const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { v4: uuidv4 } = require("uuid");
// Config model lives under plugins/core/backend/ in the plugin architecture.
const Config = require(
  path.join(process.cwd(), "plugins/core/backend/Config/models/config"),
);
const AgentConversation = require("../models/agentConversation");
const { planWithProvider, streamWithProvider } = require("../provider");
const { resolveRegion } = require("../regionResolver");
const { normalizeName, scoreCandidate } = require("../utils/text");
const { getClient, haveFasEnv } = require("../azureService");

// Compute rate limiter (shared MMGIS middleware). Loaded defensively so the
// plugin still mounts in environments where the script is unavailable.
let computeLimiter = (req, res, next) => next();
try {
  ({ computeLimiter } = require(
    path.join(process.cwd(), "scripts/rateLimiters"),
  ));
} catch (_) {
  // No shared limiter available; fall back to a no-op middleware.
}

const router = express.Router();

const REPO_ROOT = process.cwd();
const RASTER_STATS_SCRIPT = path.resolve(
  __dirname,
  "../tools/calculate_raster_stats.py",
);
const RASTER_DIFFERENCE_SCRIPT = path.resolve(
  __dirname,
  "../tools/calculate_raster_difference.py",
);

// Client-facing error messages must never carry stack traces, absolute paths,
// or other server internals. Log the real error, return a generic string.
function sendError(res, status, publicMessage, error) {
  if (error) {
    // eslint-disable-next-line no-console
    console.error(publicMessage, error);
  }
  if (!res.headersSent) {
    res.status(status).json({ error: publicMessage });
  }
}

// Reject oversized free-text inputs before they reach fuzzy matching / spawns.
const MAX_LAYER_NAME_LENGTH = 256;
const MAX_REGION_NAME_LENGTH = 256;

function readLayerNameParam(req, ...keys) {
  for (const key of keys) {
    const value = req.query[key];
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim();
      if (trimmed.length > MAX_LAYER_NAME_LENGTH) {
        const err = new Error(
          `Query parameter '${key}' exceeds ${MAX_LAYER_NAME_LENGTH} characters.`,
        );
        err.status = 400;
        throw err;
      }
      return trimmed;
    }
  }
  return null;
}

// A single path segment supplied by a client (layer/collection name) must not
// be able to escape its intended directory.
function isSafePathSegment(segment) {
  return (
    typeof segment === "string" &&
    segment.length > 0 &&
    segment.length <= MAX_LAYER_NAME_LENGTH &&
    !segment.includes("\0") &&
    !segment.includes("/") &&
    !segment.includes("\\") &&
    !segment.split(/[\\/]/).includes("..") &&
    segment !== ".." &&
    !path.isAbsolute(segment)
  );
}
const PYTHON_EXECUTABLE =
  process.env.MMGIS_PYTHON ||
  (process.env.VIRTUAL_ENV
    ? path.join(process.env.VIRTUAL_ENV, "bin", "python")
    : "python3");
const DEMO_QUERIES_CONFIG_PATH = path.resolve(
  __dirname,
  "../config/copilot_demo_queries.json",
);
const MAX_LAYER_HINTS = 40;
const MAX_LAYER_HINT_ALIASES = 4;
const MAX_LAYER_SUMMARIES = 24;
const MAX_SUMMARY_CHARS = 260;
const MAX_CITATION_CHARS = 180;

function findBestLayerInfo(query, store) {
  if (!store || !Array.isArray(store.index) || store.index.length === 0) {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const entry of store.index) {
    const score = scoreCandidate(query, entry.item.name);
    if (score > bestScore) {
      bestScore = score;
      best = entry.item;
    }
  }
  if (!best) return null;
  return { item: best, score: bestScore };
}

function sanitizeLayerHints(rawLayers) {
  if (!Array.isArray(rawLayers)) return [];
  const unique = new Map();
  for (const raw of rawLayers.slice(0, MAX_LAYER_HINTS)) {
    if (!raw || typeof raw !== "object") continue;
    const display =
      typeof raw.display_name === "string"
        ? raw.display_name.trim()
        : typeof raw.displayName === "string"
          ? raw.displayName.trim()
          : typeof raw.name === "string"
            ? raw.name.trim()
            : "";
    if (!display) continue;
    const canonical =
      typeof raw.canonical_name === "string"
        ? raw.canonical_name.trim()
        : typeof raw.canonicalName === "string"
          ? raw.canonicalName.trim()
          : "";
    const aliasSource =
      Array.isArray(raw.aliases) && raw.aliases.length
        ? raw.aliases
        : Array.isArray(raw.alias)
          ? raw.alias
          : [];
    const aliases = Array.from(
      new Set(
        aliasSource
          .map((value) =>
            typeof value === "string" ? value.trim() : String(value || ""),
          )
          .filter((value) => value.length > 0),
      ),
    ).slice(0, MAX_LAYER_HINT_ALIASES);
    const visible =
      typeof raw.visible === "boolean"
        ? raw.visible
        : typeof raw.isVisible === "boolean"
          ? raw.isVisible
          : undefined;
    const bboxArray =
      Array.isArray(raw.bbox) && raw.bbox.length === 4
        ? raw.bbox.map((value) => Number(value))
        : null;
    const normalizedBbox =
      bboxArray && bboxArray.every((value) => Number.isFinite(value))
        ? bboxArray
        : undefined;
    const key = display.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, {
        displayName: display,
        canonicalName: canonical || null,
        aliases,
        visible,
        bbox: normalizedBbox,
      });
    }
  }
  return Array.from(unique.values());
}

function truncateText(value, maxChars) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

function selectLayerSummaries(store) {
  if (!store || !Array.isArray(store.items)) return [];
  return store.items.slice(0, MAX_LAYER_SUMMARIES).map((item) => ({
    name: item.name,
    summary: truncateText(item.summary, MAX_SUMMARY_CHARS),
    citation: truncateText(item.citation, MAX_CITATION_CHARS),
  }));
}

const layerCatalogCache = new Map();

function getLayerSearchRoots(mission) {
  // Scope every filesystem lookup to the requesting mission's own directory.
  // We deliberately do NOT scan sibling missions or the Missions root: those
  // directories can hold billions of TMS tiles and walking them would take the
  // server down. `mission` is validated by getMissionFromRequest().
  if (!isSafePathSegment(mission)) return [];
  return [path.join(REPO_ROOT, "Missions", mission)];
}

async function loadMissionConfig(mission) {
  const missionName = mission;
  if (!isSafePathSegment(missionName)) return null;

  // Honour FORCE_CONFIG_PATH (same env var the main config endpoint uses)
  if (process.env.FORCE_CONFIG_PATH) {
    try {
      const raw = fs.readFileSync(process.env.FORCE_CONFIG_PATH, "utf8");
      return JSON.parse(raw);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("FORCE_CONFIG_PATH load failed:", e?.message);
    }
  }

  // Config is authoritatively served from the database.
  try {
    const record = await Config.findOne({
      where: { mission: missionName },
      order: [["id", "DESC"]],
    });
    if (record && record.config) return record.config;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to fetch mission config for ${missionName}:`, error?.message);
  }

  // Fallback: a single, deterministically-named config file for this mission.
  // We intentionally avoid enumerating the Missions directory (it can contain
  // billions of tile files) and only stat one known path.
  try {
    const preferred = path.join(
      REPO_ROOT,
      "Missions",
      `${missionName}_config.json`,
    );
    if (fs.existsSync(preferred)) {
      const raw = fs.readFileSync(preferred, "utf8");
      return JSON.parse(raw);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`Config file fallback failed for ${missionName}:`, e?.message);
  }
  return null;
}

async function buildLayerCatalog(mission) {
  const missionName = mission;
  const cached = layerCatalogCache.get(missionName);
  if (cached) return cached;
  let catalog = [];
  try {
    const config = await loadMissionConfig(missionName);
    if (!config) {
      throw new Error("Mission config not found");
    }
    const layers = Array.isArray(config.layers) ? config.layers : [];
    const entries = [];

    const collectAliasesFromSource = (source) => {
      const aliases = [];
      if (!source || typeof source !== "string") return aliases;
      const normalized = source.replace(/\\/g, "/");
      aliases.push(normalized);
      const parts = normalized.split("/");
      const file = parts[parts.length - 1];
      if (file) {
        aliases.push(file);
        const withoutExt = file.replace(/\.[^.]+$/, "");
        if (withoutExt && withoutExt !== file) aliases.push(withoutExt);
        aliases.push(file.replace(/[_-]+/g, " "));
        aliases.push(withoutExt.replace(/[_-]+/g, " "));
      }
      return aliases;
    };

    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      const name =
        typeof node.name === "string" && node.name.trim()
          ? node.name.trim()
          : null;
      if (name) {
        const sources = [];
        ["url", "path", "source", "cogUrl", "href"].forEach((key) => {
          if (typeof node[key] === "string" && node[key].trim()) {
            sources.push(node[key].trim());
          }
        });
        const aliases = new Set([name]);
        sources.forEach((src) => {
          collectAliasesFromSource(src).forEach((alias) => aliases.add(alias));
        });
        entries.push({
          name,
          sources,
          aliases: Array.from(aliases),
          sourceType: node.sourceType || null,
        });
      }
      if (Array.isArray(node.sublayers)) {
        node.sublayers.forEach(visit);
      }
    };

    layers.forEach(visit);
    catalog = entries;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to load layer config for mission ${missionName}:`, error?.message);
    catalog = [];
  }
  layerCatalogCache.set(missionName, catalog);
  return catalog;
}

function resolveRasterPathFromSources(sources = [], mission) {
  const layerSearchRoots = getLayerSearchRoots(mission);
  const RASTER_EXT = /\.tif[f]?$/i;

  for (const source of sources) {
    if (!source || typeof source !== "string") continue;
    // Skip external URLs — they have no local file.
    if (/^https?:\/\//i.test(source)) continue;

    const hasTimeToken = /\{(time|starttime|endtime)\}/i.test(source);

    if (!hasTimeToken) {
      // Exact path resolution
      if (path.isAbsolute(source) && fs.existsSync(source) && RASTER_EXT.test(source)) return source;
      const normalized = source.replace(/^\.?[\\/]/, "");
      for (const root of layerSearchRoots) {
        const candidate = path.resolve(root, normalized);
        if (fs.existsSync(candidate) && RASTER_EXT.test(candidate)) return candidate;
      }
    } else {
      // Source contains time tokens (e.g. "Layers/dir/file_{time}.tif").
      // Turn the token into a wildcard and pick the most recent matching file.
      const globbed = source
        .replace(/\{(time|starttime|endtime)\}/gi, "*")
        .replace(/^\.?[\\/]/, "");
      for (const root of layerSearchRoots) {
        const dir = path.resolve(root, path.dirname(globbed));
        if (!fs.existsSync(dir)) continue;
        const pattern = path.basename(globbed);
        const re = new RegExp(
          "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*") + "$",
          "i"
        );
        let entries;
        try { entries = fs.readdirSync(dir); } catch { continue; }
        const matches = entries
          .filter((f) => re.test(f) && RASTER_EXT.test(f))
          .sort()
          .reverse(); // newest time first (lexicographic)
        if (matches.length) {
          return path.join(dir, matches[0]);
        }
      }
    }
  }
  return null;
}

// Bounds for the fallback filesystem search. A mission's Layers directory can
// contain billions of TMS tiles, so the walk is strictly capped on both depth
// and the total number of entries inspected — it will bail out long before it
// could exhaust the event loop or memory.
const RASTER_SEARCH_MAX_DEPTH = 4;
const RASTER_SEARCH_MAX_ENTRIES = 5000;

function searchRasterByName(layerName, mission) {
  let best = { path: null, score: 0 };
  const layerSearchRoots = getLayerSearchRoots(mission);
  let budget = RASTER_SEARCH_MAX_ENTRIES;

  const visitDir = (dir, depth) => {
    if (depth > RASTER_SEARCH_MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visitDir(fullPath, depth + 1);
        continue;
      }
      if (!/\.tif[f]?$/i.test(entry.name)) continue;
      const base = entry.name.replace(/\.[^.]+$/, "");
      const score = scoreCandidate(layerName, base);
      if (score > best.score) {
        best = { path: fullPath, score };
      }
    }
  };

  for (const root of layerSearchRoots) {
    const layersDir = path.join(root, "Layers");
    visitDir(layersDir, 0);
  }
  return best.path ? best : null;
}

// Resolve the newest GeoTIFF inside a mission's Layers/<collection>/ directory.
// `collection` is treated as a single, untrusted path segment: it is validated
// against traversal, and the resolved directory is confirmed to still sit
// under the mission's Layers directory before anything is read. "Layers/" is
// only a soft convention — callers must tolerate a null result.
function findNewestTiffInCollection(mission, collection, requestedTime = "") {
  if (!isSafePathSegment(collection)) return null;
  for (const root of getLayerSearchRoots(mission)) {
    const layersDir = path.join(root, "Layers");
    const dir = path.resolve(layersDir, collection);
    // Defense in depth: never read outside the mission's Layers directory.
    if (dir !== layersDir && !dir.startsWith(layersDir + path.sep)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const tiffs = entries.filter((f) => /\.tif[f]?$/i.test(f)).sort();
    if (tiffs.length === 0) continue;

    let selected = tiffs[tiffs.length - 1]; // default: newest (lexicographic)
    if (requestedTime) {
      const target = requestedTime.replace(/[-T:Z]/g, "").slice(0, 8);
      let bestDist = Infinity;
      for (const f of tiffs) {
        const dateMatch = f.match(/(\d{8})/);
        if (dateMatch) {
          const dist = Math.abs(Number(dateMatch[1]) - Number(target));
          if (dist < bestDist) {
            bestDist = dist;
            selected = f;
          }
        }
      }
    }
    return path.join(dir, selected);
  }
  return null;
}

// Map an absolute server path to the public titiler /Missions mount, without
// ever exposing the absolute filesystem path to the client.
function toMissionsUrl(absPath) {
  const p = String(absPath).replace(/\\/g, "/");
  const idx = p.indexOf("/Missions/");
  if (idx >= 0) return p.slice(idx);
  const rel = p.indexOf("Missions/");
  if (rel >= 0) return "/" + p.slice(rel);
  return null;
}

function loadDemoQueries() {
  let raw;
  try {
    raw = fs.readFileSync(DEMO_QUERIES_CONFIG_PATH, "utf8");
  } catch (error) {
    const err = new Error(
      `Failed to read demo queries config at ${DEMO_QUERIES_CONFIG_PATH}: ${error.message}`,
    );
    err.status = 500;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const err = new Error(
      `Invalid JSON in demo queries config at ${DEMO_QUERIES_CONFIG_PATH}: ${error.message}`,
    );
    err.status = 500;
    throw err;
  }

  const sourceQueries = parsed?.queries;
  if (!Array.isArray(sourceQueries)) {
    const err = new Error(
      `Demo queries config must include a 'queries' array at ${DEMO_QUERIES_CONFIG_PATH}.`,
    );
    err.status = 500;
    throw err;
  }

  const queries = sourceQueries
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);

  if (!queries.length) {
    const err = new Error(
      `Demo queries config contains no valid query strings at ${DEMO_QUERIES_CONFIG_PATH}.`,
    );
    err.status = 500;
    throw err;
  }

  return queries;
}

function scoreCatalog(catalog, targetNorm) {
  const scored = [];
  for (const entry of catalog) {
    const aliasList = Array.isArray(entry.aliases)
      ? entry.aliases
      : [entry.name];
    let entryBest = 0;
    for (const alias of aliasList) {
      const score = scoreCandidate(targetNorm, alias);
      if (score > entryBest) entryBest = score;
    }
    if (entryBest > 0) scored.push({ entry, score: entryBest });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function findLayerRaster(layerName, mission) {
  const catalog = await buildLayerCatalog(mission);
  const targetNorm = normalizeName(layerName);
  const scored = scoreCatalog(catalog, targetNorm);

  // If the best catalog match is an external layer (HTTPS source, no local file),
  // return null immediately — the endpoint will surface a 422 explaining why.
  // This prevents falling through to unrelated local layers.
  const topEntry = scored.length ? scored[0].entry : null;
  if (topEntry) {
    const topSources = topEntry.sources || [];
    const isTopExternal =
      topEntry.sourceType === 'url' ||
      topSources.some((s) => /^https?:\/\//i.test(s));
    const isTopGroup = topSources.length === 0;
    if (isTopExternal) return null;

    // Try each match in score order until we find one with a resolvable path.
    // Only consider entries whose score is within a reasonable range of the best.
    const topScore = scored[0].score;
    const MIN_SCORE_RATIO = isTopGroup ? 0.5 : 0.6;
    for (const { entry, score } of scored) {
      if (topScore > 0 && score / topScore < MIN_SCORE_RATIO) break;
      const resolved = resolveRasterPathFromSources(entry.sources, mission);
      if (resolved) {
        return { name: entry.name, path: resolved, score };
      }
    }
  }

  // Filesystem fallback for layers not in the catalog.
  const fallback = searchRasterByName(layerName, mission);
  if (fallback && fallback.score >= 0.4) {
    return {
      name: layerName,
      path: fallback.path,
      score: fallback.score,
    };
  }
  return null;
}

// The mission always comes from the request. Admins add and remove missions
// freely, so there is no server-side default to fall back to.
function getMissionFromRequest(req) {
  const raw =
    typeof req.query?.mission === "string" ? req.query.mission.trim() : "";
  if (!raw) {
    const err = new Error("Query parameter 'mission' is required.");
    err.status = 400;
    throw err;
  }
  if (!isSafePathSegment(raw)) {
    const err = new Error("Invalid mission name.");
    err.status = 400;
    throw err;
  }
  return raw;
}

function getLiveToolOptions(req) {
  const registry = req.app?.locals?.agentToolRegistry;
  const toolNames = req.app?.locals?.agentToolNames;
  return { registry, toolNames };
}

function parseBboxFromQuery(query) {
  const keys = ["lon_min", "lat_min", "lon_max", "lat_max"];
  if (keys.every((key) => query[key] != null)) {
    const values = keys.map((key) => Number(query[key]));
    if (
      values.every((value) => Number.isFinite(value)) &&
      values[0] < values[2] &&
      values[1] < values[3]
    ) {
      return values;
    }
  }
  if (typeof query.b === "string") {
    const parts = query.b
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => !Number.isNaN(value));
    if (
      parts.length === 4 &&
      parts[0] < parts[2] &&
      parts[1] < parts[3]
    ) {
      return parts;
    }
  }
  return null;
}

function runRasterStats(rasterPath, bbox, options = {}) {
  return new Promise((resolve, reject) => {
    const mode = options.mode || "full";
    const args = [RASTER_STATS_SCRIPT, rasterPath, "--mode", mode];
    if (bbox) {
      args.push("--bbox", ...bbox.map((value) => String(value)));
    }
    if (mode === "tiled" && typeof options.tileSize === "number") {
      args.push("--tile-size", String(options.tileSize));
    }
    if (mode === "sampled" && typeof options.sampleSpacing === "number") {
      args.push("--sample-spacing", String(options.sampleSpacing));
    }

    const child = spawn(PYTHON_EXECUTABLE, args, { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const err = new Error(
          stderr.trim() ||
            `Raster stats script failed with exit code ${code}`,
        );
        err.code = code;
        err.stderr = stderr;
        return reject(err);
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        resolve(parsed);
      } catch (error) {
        const err = new Error(`Failed to parse raster stats output: ${error.message}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function getToolNames(req) {
  return req.app?.locals?.agentToolNames || new Set();
}

function getValidators(req) {
  return req.app?.locals?.agentToolValidators || {};
}

function repr(v) {
  try {
    if (typeof v === "string") return `"${v}"`;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function validateAction(action, req) {
  if (!action || typeof action !== "object") {
    throw new TypeError(
      `Action must be an object; received ${repr(action)} instead`,
    );
  }
  const toolNames = getToolNames(req);
  if (!toolNames.has(action.tool)) {
    const expected = [...toolNames].join(", ") || "(none)";
    throw new Error(
      `Unknown tool '${action.tool}'. Expected one of ${expected}; received ${repr(action.tool)} instead`,
    );
  }
  const validators = getValidators(req);
  const validate = validators[action.tool];
  const args = action.args || {};
  if (typeof validate !== "function") {
    throw new Error(`No validator for tool ${action.tool}`);
  }
  const valid = validate(args);
  if (!valid) {
    const errors =
      (validate.errors || [])
        .map((e) => `${e.instancePath || ""} ${e.message}`)
        .join("; ") || "validation failed";
    const err = new Error(`${action.tool} args invalid: ${errors}`);
    err.validationErrors = validate.errors || [];
    throw err;
  }
  return { tool: action.tool, args };
}

router.post("/", computeLimiter, express.json(), async function (req, res) {
  try {
    const message = req.body?.message ?? "";
    if (typeof message !== "string") {
      const err = new Error("Message must be a string.");
      err.status = 400;
      throw err;
    }
    if (message.length > 2000) {
      const err = new Error("Message too long (max 2000 chars).");
      err.status = 400;
      throw err;
    }

    const mission = getMissionFromRequest(req);
    const bodyContext = req.body?.context || {};
    const clientLayerHints = sanitizeLayerHints(bodyContext.layers);
    const layerInfoStore = req.app?.locals?.agentLayerInfo;
    const layerSummaries = selectLayerSummaries(layerInfoStore);

    // Conversation persistence
    let conversationId = req.body?.conversationId || null;
    let conversation = null;
    let azureThreadId = null;

    if (conversationId) {
      try {
        conversation = await AgentConversation.findByPk(conversationId);
        if (conversation) {
          azureThreadId = conversation.azureThreadId;
        }
      } catch (_) {
        // If lookup fails, proceed without conversation
      }
    }

    if (!conversation) {
      conversationId = uuidv4();
      conversation = await AgentConversation.create({
        conversationId,
        missionName: mission,
        title: message.slice(0, 200),
        messages: [],
      });
    }

    const result = await planWithProvider(message, {
      layerHints: clientLayerHints,
      layerSummaries,
    }, { threadId: azureThreadId, ...getLiveToolOptions(req) });
    if (!result || !Array.isArray(result.actions)) {
      throw new Error(
        "Provider returned malformed response (missing actions array).",
      );
    }

    const reply = typeof result.reply === "string" ? result.reply.trim() : "";
    const citations = Array.isArray(result.citations) ? result.citations : [];
    const actions = result.actions.map((action) => validateAction(action, req));

    const planList = actions.map((a) => a.tool).join(", ") || "(none)";
    const planText = `Planned: ${planList}.`;

    const segments = [];
    if (reply) segments.push(reply);
    if (planText) segments.push(planText);
    const text = segments.join("\n\n");

    const debug = {
      providerAttempted: true,
      providerReturnedActions: actions.length > 0,
      providerFailureReason: null,
    };
    if (result.debug) {
      debug.azure = result.debug;
    }

    // Persist messages to conversation
    try {
      const updatedMessages = [
        ...(conversation.messages || []),
        { role: "user", text: message, timestamp: new Date().toISOString() },
        { role: "assistant", text: reply, actions, citations, timestamp: new Date().toISOString() },
      ];
      await conversation.update({
        messages: updatedMessages,
        azureThreadId: result.threadId || azureThreadId,
      });
    } catch (_) {
      // Non-fatal: response still goes through even if persistence fails
    }

    res.status(200).json({
      text,
      reply,
      citations,
      actions,
      conversationId,
      source: "provider",
      debug,
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    // eslint-disable-next-line no-console
    console.error("Agent planning error:", error);
    // Only surface messages for deliberate client errors (4xx). 5xx failures
    // return a generic message so stack traces / internals never reach clients.
    const response = {
      error: status < 500 ? error.message : "Agent planning failed.",
    };
    if (error.validationErrors)
      response.validationErrors = error.validationErrors;
    res.status(status).json(response);
  }
});

router.post("/stream", computeLimiter, express.json(), async function (req, res) {
  try {
    const message = req.body?.message ?? "";
    if (typeof message !== "string") {
      return res.status(400).json({ error: "Message must be a string." });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 chars)." });
    }

    const mission = getMissionFromRequest(req);
    const bodyContext = req.body?.context || {};
    const clientLayerHints = sanitizeLayerHints(bodyContext.layers);
    const layerInfoStore = req.app?.locals?.agentLayerInfo;
    const layerSummaries = selectLayerSummaries(layerInfoStore);

    // Conversation persistence
    let conversationId = req.body?.conversationId || null;
    let conversation = null;
    let azureThreadId = null;

    if (conversationId) {
      try {
        conversation = await AgentConversation.findByPk(conversationId);
        if (conversation) azureThreadId = conversation.azureThreadId;
      } catch (_) {}
    }

    if (!conversation) {
      conversationId = uuidv4();
      conversation = await AgentConversation.create({
        conversationId,
        missionName: mission,
        title: message.slice(0, 200),
        messages: [],
      });
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Send conversationId immediately
    res.write(`data: ${JSON.stringify({ type: "conversationId", data: conversationId })}\n\n`);

    let lastPlan = null;

    for await (const event of streamWithProvider(
      message,
      { layerHints: clientLayerHints, layerSummaries },
      { threadId: azureThreadId, ...getLiveToolOptions(req) },
    )) {
      if (event.type === "plan") {
        lastPlan = event.data;
        // Validate actions before sending
        const validatedActions = [];
        for (const action of event.data.actions || []) {
          try {
            validatedActions.push(validateAction(action, req));
          } catch (_) {}
        }
        res.write(`data: ${JSON.stringify({
          type: "plan",
          data: { ...event.data, actions: validatedActions },
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    // Persist conversation after stream completes
    try {
      const reply = lastPlan?.reply || "";
      const actions = lastPlan?.actions || [];
      const citations = lastPlan?.citations || [];
      const newThreadId = lastPlan?.threadId || azureThreadId;
      const updatedMessages = [
        ...(conversation.messages || []),
        { role: "user", text: message, timestamp: new Date().toISOString() },
        { role: "assistant", text: reply, actions, citations, timestamp: new Date().toISOString() },
      ];
      await conversation.update({
        messages: updatedMessages,
        azureThreadId: newThreadId,
      });
    } catch (_) {}

    res.end();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Agent stream error:", error);
    const status = Number.isInteger(error.status) ? error.status : 500;
    const publicMessage =
      status < 500 ? error.message : "Agent streaming failed.";
    if (!res.headersSent) {
      res.status(status).json({ error: publicMessage });
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", data: publicMessage })}\n\n`);
      res.end();
    }
  }
});

router.get("/layer-info", (req, res) => {
  const store = req.app?.locals?.agentLayerInfo;
  if (!store || store.error) {
    res.status(404).json({
      error: "Layer metadata is unavailable.",
      code: "LayerInfoUnavailable",
      details: store?.error || null,
    });
    return;
  }

  const query =
    typeof req.query?.name === "string" ? req.query.name.trim() : "";
  let items = store.items || [];
  let match = null;
  if (query) {
    const found = findBestLayerInfo(query, store);
    if (found && found.score >= 0.35) {
      items = [found.item];
      match = {
        name: found.item.name,
        score: Number(found.score.toFixed(3)),
      };
    } else {
      items = [];
      match = null;
    }
  }

  res.status(200).json({
    items,
    match,
    source: {
      path: store.sourcePath || null,
      loadedAt: store.loadedAt || null,
    },
  });
});

router.get("/copilot/demo-queries", (req, res) => {
  try {
    const queries = loadDemoQueries();
    res.status(200).json({ queries });
  } catch (error) {
    sendError(res, 500, "Failed to load copilot demo queries.", error);
  }
});

router.get("/regions/resolve", async (req, res) => {
  try {
    const nameParam =
      (typeof req.query.name === "string" && req.query.name.trim()) ||
      (typeof req.query.q === "string" && req.query.q.trim()) ||
      "";
    if (!nameParam) {
      res.status(400).json({ error: "Query parameter 'name' is required." });
      return;
    }
    if (nameParam.length > MAX_REGION_NAME_LENGTH) {
      res.status(400).json({
        error: `Query parameter 'name' exceeds ${MAX_REGION_NAME_LENGTH} characters.`,
      });
      return;
    }
    const bufferParam =
      typeof req.query.buffer_km === "string" && req.query.buffer_km.trim()
        ? Number(req.query.buffer_km)
        : null;
    const bufferKm =
      Number.isFinite(bufferParam) && bufferParam > 0 ? bufferParam : null;

    const resolved = await resolveRegion(nameParam, { bufferKm });
    if (!resolved) {
      res.status(404).json({
        error: `Unable to resolve geographical area '${nameParam}'.`,
      });
      return;
    }
    res.status(200).json({
      label: resolved.label,
      bbox: resolved.bbox,
      bboxParts: resolved.bboxParts,
      geometry: resolved.geometry || null,
      geometry_type: resolved.geometryType || (resolved.geometry ? "polygon" : "bbox"),
      source: resolved.sourceDomain || null,
      source_domain: resolved.sourceDomain || null,
      source_url: resolved.sourceUrl || null,
      method: resolved.method || "bbox",
      buffer_km: resolved.bufferKm || null,
    });
  } catch (error) {
    sendError(res, 500, "Failed to resolve geographical region.", error);
  }
});

router.get("/analytics/statistics", computeLimiter, async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const layerName = readLayerNameParam(req, "layer_name", "layer");
    if (!layerName) {
      res.status(400).json({
        error: "Query parameter 'layer_name' is required.",
      });
      return;
    }

    const bbox = parseBboxFromQuery(req.query);
    const layerRecord = await findLayerRaster(layerName, mission);
    if (!layerRecord || !layerRecord.path) {
      // Check if the layer exists but is an external tile service
      const catalog = await buildLayerCatalog(mission);
      const scored = scoreCatalog(catalog, normalizeName(layerName));
      const catalogMatch = scored.length ? scored[0].entry : null;
      const isExternal = catalogMatch && (
        catalogMatch.sourceType === 'url' ||
        (catalogMatch.sources || []).some((s) => /^https?:\/\//i.test(s))
      );
      if (isExternal) {
        res.status(422).json({
          error: `Layer '${catalogMatch.name}' is an external tile service and does not have local raster data for statistics.`,
          layer_name: catalogMatch.name,
          sourceType: catalogMatch.sourceType || 'url',
        });
        return;
      }
      res.status(404).json({
        error: `Unable to locate raster data for layer '${layerName}'.`,
      });
      return;
    }

    let stats = null;
    const attempts = [
      { mode: "full" },
      { mode: "tiled", tileSize: 1024 },
      { mode: "sampled", sampleSpacing: 1.0 },
    ];
    const errors = [];
    for (const attempt of attempts) {
      try {
        stats = await runRasterStats(layerRecord.path, bbox, attempt);
        break;
      } catch (error) {
        errors.push({ mode: attempt.mode, error });
      }
    }
    if (!stats) {
      const last = errors[errors.length - 1];
      const err = new Error(
        last?.error?.message || "Failed to compute raster statistics.",
      );
      err.cause = last?.error;
      throw err;
    }
    const response = {
      layer_name: layerRecord.name,
      source: "local-raster",
      confidence: layerRecord.score,
      mean: typeof stats.mean === "number" ? stats.mean : null,
      std: typeof stats.std === "number" ? stats.std : null,
      min: typeof stats.min === "number" ? stats.min : null,
      max: typeof stats.max === "number" ? stats.max : null,
      median:
        typeof stats.median === "number"
          ? stats.median
          : typeof stats.q50 === "number"
            ? stats.q50
            : null,
      q25: typeof stats.q25 === "number" ? stats.q25 : null,
      q75: typeof stats.q75 === "number" ? stats.q75 : null,
      total_count: typeof stats.count === "number" ? stats.count : null,
      count: typeof stats.count === "number" ? stats.count : null,
      is_sampled: (stats.method || "").toLowerCase() === "sampled",
      method: stats.method || "full",
      valid_count: typeof stats.valid_count === "number" ? stats.valid_count : null,
      nodata_count: typeof stats.nodata_count === "number" ? stats.nodata_count : null,
      quantiles:
        typeof stats.q25 === "number" || typeof stats.q75 === "number"
          ? {
              "0.25": stats.q25 ?? null,
              "0.50":
                typeof stats.median === "number"
                  ? stats.median
                  : typeof stats.q50 === "number"
                    ? stats.q50
                    : null,
              "0.75": stats.q75 ?? null,
            }
          : null,
      bbox: bbox
        ? {
            lon_min: bbox[0],
            lat_min: bbox[1],
            lon_max: bbox[2],
            lat_max: bbox[3],
          }
        : null,
    };
    res.status(200).json(response);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({ error: error.message });
    } else {
      sendError(res, 500, "Failed to compute raster statistics.", error);
    }
  }
});

router.get("/analytics/layers", async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const catalog = await buildLayerCatalog(mission);
    const payload = catalog.map((entry) => ({
      name: entry.name,
      aliases: entry.aliases || [],
      sources: entry.sources || [],
    }));
    res.status(200).json({ layers: payload, mission });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({ error: error.message });
    } else {
      sendError(res, 500, "Failed to enumerate analytics layers.", error);
    }
  }
});

router.get("/analytics/resolve-cog", async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const layerName = readLayerNameParam(req, "layer_name", "layer");
    if (!layerName) {
      res.status(400).json({ error: "Query parameter 'layer_name' is required." });
      return;
    }

    let resolvedPath = null;
    const record = await findLayerRaster(layerName, mission);
    if (record?.path) resolvedPath = record.path;

    // STAC collections are only sometimes materialised on disk under
    // Missions/<mission>/Layers/<collection>/. This is a best-effort lookup:
    // a STAC item's assets can point at any URL, so a miss here is expected and
    // simply falls through to the 404/422 below.
    if (!resolvedPath) {
      resolvedPath = findNewestTiffInCollection(mission, layerName);
    }

    // Also try matching the requested name to a configured STAC collection and
    // then looking for that collection's directory on disk.
    if (!resolvedPath) {
      const config = await loadMissionConfig(mission);
      if (config) {
        const layers = Array.isArray(config.layers) ? config.layers : [];
        let stacCollection = null;
        let bestScore = 0;
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          const name = (node.name || "").trim();
          if (name && node.sourceType === "stac-collection" && node.url) {
            const score = scoreCandidate(layerName, name);
            if (score > bestScore) {
              bestScore = score;
              stacCollection = node.url;
            }
          }
          if (Array.isArray(node.sublayers)) node.sublayers.forEach(visit);
        };
        layers.forEach(visit);
        if (stacCollection) {
          resolvedPath = findNewestTiffInCollection(mission, stacCollection);
        }
      }
    }

    if (!resolvedPath) {
      const catalog = await buildLayerCatalog(mission);
      const catalogMatch = catalog.find((e) =>
        e.name.toLowerCase().includes(layerName.toLowerCase()),
      );
      if (catalogMatch && catalogMatch.sourceType === "url") {
        res.status(422).json({
          error: `Layer '${catalogMatch.name}' is an external tile service and does not have local raster data for statistics.`,
          layer_name: catalogMatch.name,
          sourceType: catalogMatch.sourceType,
        });
        return;
      }
      res.status(404).json({
        error: `Unable to locate raster data for layer '${layerName}'.`,
      });
      return;
    }

    const titilerUrl = toMissionsUrl(resolvedPath);
    if (!titilerUrl) {
      res.status(404).json({
        error: `Layer '${layerName}' is not served from the Missions mount.`,
      });
      return;
    }

    res.status(200).json({ url: titilerUrl, mission });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({ error: error.message });
    } else {
      sendError(res, 500, "Failed to resolve COG url.", error);
    }
  }
});

// --- Layer difference endpoint ---

router.get("/analytics/difference", computeLimiter, async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const layerNameA = readLayerNameParam(req, "layer_a");
    const layerNameB = readLayerNameParam(req, "layer_b");
    if (!layerNameA || !layerNameB) {
      return res.status(400).json({ error: "Both layer_a and layer_b are required." });
    }

    const requestedTime = (req.query.time || "").toString().trim().slice(0, 32);

    // Resolve each layer to a local raster. Prefer a configured STAC collection
    // directory (time-aware), then fall back to standard resolution.
    const resolveRaster = async (layerName) => {
      const config = await loadMissionConfig(mission);
      if (config) {
        const layers = Array.isArray(config.layers) ? config.layers : [];
        let stacCollection = null;
        let bestScore = 0;
        const visit = (node) => {
          if (!node || typeof node !== "object") return;
          const name = (node.name || "").trim();
          if (name && node.sourceType === "stac-collection" && node.url) {
            const score = scoreCandidate(layerName, name);
            if (score > bestScore) {
              bestScore = score;
              stacCollection = node.url;
            }
          }
          if (Array.isArray(node.sublayers)) node.sublayers.forEach(visit);
        };
        layers.forEach(visit);
        if (stacCollection) {
          const found = findNewestTiffInCollection(
            mission,
            stacCollection,
            requestedTime,
          );
          if (found) return found;
        }
      }
      const record = await findLayerRaster(layerName, mission);
      return record?.path || null;
    };

    const pathA = await resolveRaster(layerNameA);
    const pathB = await resolveRaster(layerNameB);
    if (!pathA) {
      return res.status(404).json({ error: `Cannot find raster for layer '${layerNameA}'.` });
    }
    if (!pathB) {
      return res.status(404).json({ error: `Cannot find raster for layer '${layerNameB}'.` });
    }

    // Compute the difference in a dedicated Python script. All values are
    // passed as argv — no caller-controlled data is ever interpolated into
    // source code — so there is no path to arbitrary code execution.
    const result = await new Promise((resolve, reject) => {
      const args = [
        RASTER_DIFFERENCE_SCRIPT,
        "--path-a", pathA,
        "--path-b", pathB,
        "--layer-a", layerNameA,
        "--layer-b", layerNameB,
      ];
      const bbox = parseBboxFromQuery(req.query);
      if (bbox) args.push("--bbox", bbox.join(","));

      const child = spawn(PYTHON_EXECUTABLE, args, { cwd: REPO_ROOT });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          const err = new Error("Difference computation failed.");
          err.stderr = stderr;
          return reject(err);
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          e.stdout = stdout;
          reject(e);
        }
      });
    });

    if (result.error) {
      return res.status(422).json({ error: result.error });
    }

    res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({ error: error.message });
    } else {
      sendError(res, 500, "Failed to compute layer difference.", error);
    }
  }
});

// --- Conversation endpoints ---

router.get("/conversations", async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const conversations = await AgentConversation.findAll({
      where: { missionName: mission },
      attributes: ["conversationId", "title", "createdAt", "updatedAt"],
      order: [["updatedAt", "DESC"]],
      limit: 50,
    });
    res.status(200).json({ conversations });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({ error: error.message });
    } else {
      sendError(res, 500, "Failed to list conversations.", error);
    }
  }
});

router.get("/conversations/:id", async (req, res) => {
  try {
    const conversation = await AgentConversation.findByPk(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    res.status(200).json(conversation.toJSON());
  } catch (error) {
    sendError(res, 500, "Failed to get conversation.", error);
  }
});

router.delete("/conversations/:id", async (req, res) => {
  try {
    const conversation = await AgentConversation.findByPk(req.params.id);
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    // Best-effort cleanup of Azure conversation (legacy field: azureThreadId)
    if (conversation.azureThreadId) {
      try {
        const cfg = haveFasEnv();
        if (cfg.ok) {
          const client = getClient(cfg.endpoint);
          await client.conversations.delete(conversation.azureThreadId);
        }
      } catch (_) {
        // Non-fatal
      }
    }
    await conversation.destroy();
    res.status(200).json({ deleted: true });
  } catch (error) {
    sendError(res, 500, "Failed to delete conversation.", error);
  }
});

module.exports = router;
