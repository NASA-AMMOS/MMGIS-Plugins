const express = require("express");
const Ajv = require("ajv");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
// Config model lives under plugins/core/backend/ in the plugin architecture.
const Config = require(
  path.join(process.cwd(), "plugins/core/backend/Config/models/config"),
);
const AgentConversation = require("../models/agentConversation");
const {
  planWithProvider,
  continueWithProvider,
  streamWithProvider,
} = require("../provider");
const {
  mergeToolRegistries,
  sanitizeRuntimeCapabilities,
} = require("../capabilities");
const {
  sanitizeToolResults,
  redactSensitiveText,
} = require("../toolResults");
const { sanitizeRuntimeContext } = require("../requestContext");
const { spawnBounded } = require("../boundedProcess");
const {
  requestIdentity,
  beginRuntimeConversation,
  getRuntimeConversation,
  listRuntimeConversations,
  deleteRuntimeConversation,
  setPendingActions,
  claimPendingActions,
  completePendingClaim,
  releasePendingClaim,
  bestEffortCreateConversation,
} = require("../conversationRuntime");
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
const MAX_ANALYTICS_TIME_CHARS = 64;

function invalidAnalysisTime(parameter = "time") {
  const error = new Error(
    `Query parameter '${parameter}' must be a single ISO-8601 instant or YYYYMMDD date.`,
  );
  error.status = 400;
  error.code = "InvalidAnalysisTime";
  return error;
}

function normalizeAnalysisTimeValue(raw, parameter = "time") {
  if (raw == null || raw === "") return "";
  if (typeof raw !== "string" || Array.isArray(raw)) {
    throw invalidAnalysisTime(parameter);
  }
  const value = raw.trim();
  if (
    !value ||
    value.length > MAX_ANALYTICS_TIME_CHARS ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidAnalysisTime(parameter);
  }

  let normalizedInput = value;
  const isDateOnly = /^\d{8}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (/^\d{8}$/.test(value)) {
    normalizedInput = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  } else if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      value,
    )
  ) {
    throw invalidAnalysisTime(parameter);
  }

  const timestamp = Date.parse(normalizedInput);
  if (!Number.isFinite(timestamp)) throw invalidAnalysisTime(parameter);
  const normalized = new Date(timestamp).toISOString();
  // Date.parse normalizes impossible calendar dates on some runtimes. Reject
  // those instead of silently selecting an asset from a different day.
  if (
    isDateOnly &&
    normalized.slice(0, 10) !== normalizedInput.slice(0, 10)
  ) {
    throw invalidAnalysisTime(parameter);
  }
  return normalized;
}

function readOptionalAnalysisTime(query = {}) {
  const time = query.time == null
    ? ""
    : normalizeAnalysisTimeValue(query.time, "time");
  const datetime = query.datetime == null
    ? ""
    : normalizeAnalysisTimeValue(query.datetime, "datetime");
  if (time && datetime && time !== datetime) {
    const error = invalidAnalysisTime("time/datetime");
    error.message = "Query parameters 'time' and 'datetime' must identify the same instant.";
    throw error;
  }
  return time || datetime;
}

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
function resolvePythonExecutable(
  env = process.env,
  platform = process.platform,
) {
  const explicit =
    typeof env.MMGIS_PYTHON === "string" ? env.MMGIS_PYTHON.trim() : "";
  if (explicit) return explicit;
  const virtualEnv =
    typeof env.VIRTUAL_ENV === "string" ? env.VIRTUAL_ENV.trim() : "";
  if (virtualEnv) {
    return platform === "win32"
      ? path.win32.join(virtualEnv, "Scripts", "python.exe")
      : path.posix.join(virtualEnv, "bin", "python");
  }
  return platform === "win32" ? "python" : "python3";
}

// Resolve deterministically without spawning a probe at module import. A
// deployment can always override discovery with MMGIS_PYTHON.
const PYTHON_EXECUTABLE = resolvePythonExecutable();
const DEMO_QUERIES_CONFIG_PATH = path.resolve(
  __dirname,
  "../config/copilot_demo_queries.json",
);
const MAX_LAYER_HINTS = 40;
const MAX_LAYER_HINT_ALIASES = 4;
const MAX_LAYER_SUMMARIES = 24;
const MAX_SUMMARY_CHARS = 260;
const MAX_CITATION_CHARS = 180;
const MAX_LAYER_FIELD_CHARS = 320;
const MAX_LAYER_ANALYTICS = 16;
const MAX_CONTINUATION_STEPS = 8;
const MAX_PROVIDER_ID_CHARS = 200;

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
    const type = truncateText(
      raw.type || raw.layerType || raw.layer_type,
      80,
    );
    const sourceType = truncateText(
      raw.sourceType || raw.source_type,
      80,
    );
    const source = sanitizeLayerSource(raw.source || raw.url || raw.path);
    const groupPathSource = raw.groupPath || raw.group_path;
    const groupPath = truncateText(
      Array.isArray(groupPathSource)
        ? groupPathSource
            .map((entry) => truncateText(entry, 100))
            .filter(Boolean)
            .join(" / ")
        : groupPathSource,
      MAX_LAYER_FIELD_CHARS,
    );
    const nestedAnalysis =
      raw.analysis && typeof raw.analysis === "object"
        ? raw.analysis
        : null;
    const analyzable =
      typeof raw.analyzable === "boolean"
        ? raw.analyzable
        : typeof raw.isAnalyzable === "boolean"
          ? raw.isAnalyzable
          : typeof nestedAnalysis?.supported === "boolean"
            ? nestedAnalysis.supported
          : undefined;
    const analyticsSource = Array.isArray(raw.analysisCapabilities)
      ? raw.analysisCapabilities
      : Array.isArray(raw.analytics)
        ? raw.analytics
        : Array.isArray(nestedAnalysis?.operations)
          ? nestedAnalysis.operations
        : [];
    const analysisCapabilities = Array.from(
      new Set(
        analyticsSource
          .map((value) => truncateText(value, 80))
          .filter(Boolean),
      ),
    ).slice(0, MAX_LAYER_ANALYTICS);
    const rawTime =
      raw.time && typeof raw.time === "object"
        ? raw.time
        : raw.temporal && typeof raw.temporal === "object"
          ? raw.temporal
          : null;
    const time = rawTime
      ? {
          enabled:
            typeof rawTime.enabled === "boolean"
              ? rawTime.enabled
              : undefined,
          current: truncateText(
            rawTime.current || rawTime.value || rawTime.currentTime,
            100,
          ) || undefined,
          start: truncateText(
            rawTime.start || rawTime.availableStart || rawTime.min,
            100,
          ) || undefined,
          end: truncateText(
            rawTime.end || rawTime.availableEnd || rawTime.max,
            100,
          ) || undefined,
        }
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
        type: type || undefined,
        sourceType: sourceType || undefined,
        source: source || undefined,
        groupPath: groupPath || undefined,
        analyzable,
        analysisCapabilities,
        analysisReason:
          truncateText(nestedAnalysis?.reason, 320) || undefined,
        analysisSource:
          truncateText(nestedAnalysis?.source, 160) || undefined,
        scalar:
          typeof nestedAnalysis?.scalar === "boolean"
            ? nestedAnalysis.scalar
            : undefined,
        time,
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

function sanitizeLayerSource(value) {
  const raw = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!raw || /^(?:data|blob):/i.test(raw)) return "";

  const redactLocalPath = () => {
    const withoutSuffix = raw.split(/[?#]/, 1)[0];
    const extension =
      path.win32.extname(withoutSuffix) || path.posix.extname(withoutSuffix);
    const safeExtension = /^\.[A-Za-z0-9]{1,10}$/.test(extension)
      ? extension.toLowerCase()
      : "";
    return safeExtension
      ? `[local ${safeExtension} source redacted]`
      : "[local source redacted]";
  };
  const isExplicitLocalPath =
    path.win32.isAbsolute(raw) ||
    path.posix.isAbsolute(raw) ||
    /^(?:\.{1,2}[\\/]|\\\\)/.test(raw) ||
    raw.includes("\\");
  // WHATWG URL treats a Windows drive letter as a URL scheme, so local paths
  // must be classified before URL parsing.
  if (isExplicitLocalPath) return redactLocalPath();

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return truncateText(url.toString(), MAX_LAYER_FIELD_CHARS);
  } catch (_) {
    // Continue with local-path/plain-source classification.
  }

  if (raw.includes("/")) return redactLocalPath();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return "";
  return truncateText(raw, 80);
}

function sanitizeCatalogAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  const sanitized = [];
  for (const alias of aliases) {
    const raw = String(alias || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    if (!raw) continue;
    let safe = "";
    if (/^https?:\/\//i.test(raw)) {
      safe = sanitizeLayerSource(raw);
    } else if (
      path.win32.isAbsolute(raw) ||
      path.posix.isAbsolute(raw) ||
      raw.includes("\\")
    ) {
      continue;
    } else {
      safe = truncateText(raw.split(/[?#]/, 1)[0], 160);
    }
    if (safe && !sanitized.includes(safe)) sanitized.push(safe);
    if (sanitized.length >= 8) break;
  }
  return sanitized;
}

function selectLayerSummaries(store) {
  if (!store || !Array.isArray(store.items)) return [];
  return store.items.slice(0, MAX_LAYER_SUMMARIES).map((item) => ({
    name: item.name,
    summary: truncateText(item.summary, MAX_SUMMARY_CHARS),
    citation: sanitizeLayerCitation(item.citation),
    type: truncateText(item.type, 80),
    sourceType: truncateText(item.sourceType, 80),
    analyzable:
      typeof item.analyzable === "boolean" ? item.analyzable : undefined,
    timeEnabled:
      typeof item.timeEnabled === "boolean" ? item.timeEnabled : undefined,
  }));
}

function sanitizeLayerCitation(value) {
  const raw = truncateText(value, MAX_CITATION_CHARS);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return truncateText(url.toString(), MAX_CITATION_CHARS);
  } catch (_) {
    return "";
  }
}

function sanitizeLayerInfoItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_LAYER_SUMMARIES).map((item) => ({
    name: truncateText(item?.name, MAX_LAYER_NAME_LENGTH),
    summary: truncateText(item?.summary, MAX_SUMMARY_CHARS),
    citation: sanitizeLayerCitation(item?.citation),
    type: truncateText(item?.type, 80) || undefined,
    sourceType: truncateText(item?.sourceType, 80) || undefined,
    visible:
      typeof item?.visible === "boolean" ? item.visible : undefined,
    timeEnabled:
      typeof item?.timeEnabled === "boolean" ? item.timeEnabled : undefined,
    analyzable:
      typeof item?.analyzable === "boolean" ? item.analyzable : undefined,
    analysisCapabilities: Array.isArray(item?.analysisCapabilities)
      ? item.analysisCapabilities
          .map((entry) => truncateText(entry, 80))
          .filter(Boolean)
          .slice(0, MAX_LAYER_ANALYTICS)
      : [],
  }));
}

const layerCatalogCache = new Map();
const LAYER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
const LAYER_CATALOG_CACHE_MAX = 32;

function getCachedLayerCatalog(mission, now = Date.now()) {
  const cached = layerCatalogCache.get(mission);
  if (!cached) return null;
  if (now - cached.cachedAt > LAYER_CATALOG_CACHE_TTL_MS) {
    layerCatalogCache.delete(mission);
    return null;
  }
  // Refresh insertion order for LRU eviction.
  layerCatalogCache.delete(mission);
  layerCatalogCache.set(mission, cached);
  return cached.catalog;
}

function setCachedLayerCatalog(mission, catalog, now = Date.now()) {
  if (layerCatalogCache.has(mission)) layerCatalogCache.delete(mission);
  layerCatalogCache.set(mission, { catalog, cachedAt: now });
  while (layerCatalogCache.size > LAYER_CATALOG_CACHE_MAX) {
    layerCatalogCache.delete(layerCatalogCache.keys().next().value);
  }
}

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

function extractScalarSemantics(node = {}) {
  const expression = truncateText(
    node.currentCogExpression || node.cogExpression || "b1",
    256,
  ) || "b1";
  const normalizedExpression = expression
    .replace(/asset_([bB]\d+)/g, "$1")
    .replace(/\s+/g, "")
    .toLowerCase();
  const minimum = Number(node.cogMin);
  const maximum = Number(node.cogMax);
  const validRange =
    node.cogTransform === true &&
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    minimum <= maximum
      ? [minimum, maximum]
      : null;
  const nodataCandidates = [
    node.nodata,
    node.noData,
    node.noDataValue,
    node.nodataValue,
    node.cogNoData,
    node.cogNodata,
    node.metadata?.nodata,
    node.metadata?.noData,
    node.analysis?.nodata,
    node.analysis?.noData,
  ].flatMap((value) => (Array.isArray(value) ? value : [value]));
  const nodata = Array.from(
    new Set(
      nodataCandidates
        .map(Number)
        .filter((value) => Number.isFinite(value)),
    ),
  ).slice(0, 8);
  const transformed = normalizedExpression !== "b1";
  const backendSupported = !transformed && !validRange && nodata.length === 0;
  return {
    expression,
    transformed,
    validRange,
    nodata,
    unit: truncateText(node.cogUnits || node.units || node.unit, 80) || null,
    backendSupported,
    backendReason: backendSupported
      ? null
      : "Configured expression, valid-range, or nodata semantics require the validated client raster analyzer.",
  };
}

function publicScalarSemantics(semantics = extractScalarSemantics()) {
  return {
    value_expression: semantics.expression || "b1",
    transformed: semantics.transformed === true,
    valid_range: Array.isArray(semantics.validRange)
      ? semantics.validRange
      : null,
    configured_nodata: Array.isArray(semantics.nodata)
      ? semantics.nodata
      : [],
    unit: semantics.unit || null,
    backend_supported: semantics.backendSupported !== false,
  };
}

function getBackendScalarSemanticsError(record, layerName) {
  const semantics = record?.scalarSemantics || extractScalarSemantics();
  if (semantics.backendSupported !== false) return null;
  return {
    status: 422,
    code: "BackendScalarSemanticsUnsupported",
    message: `Layer '${layerName}' uses configured raster value semantics that this backend will not ignore; use the validated client raster analyzer.`,
    scalarSemantics: publicScalarSemantics(semantics),
  };
}

function getComparisonScalarSemanticsError(recordA, recordB) {
  const unsupportedA = getBackendScalarSemanticsError(
    recordA,
    recordA?.name || "layer A",
  );
  if (unsupportedA) return unsupportedA;
  const unsupportedB = getBackendScalarSemanticsError(
    recordB,
    recordB?.name || "layer B",
  );
  if (unsupportedB) return unsupportedB;
  const unitA = String(recordA?.scalarSemantics?.unit || "").trim().toLowerCase();
  const unitB = String(recordB?.scalarSemantics?.unit || "").trim().toLowerCase();
  if (!unitA || !unitB || unitA !== unitB) {
    const unitsMissing = !unitA || !unitB;
    return {
      status: 422,
      code: unitsMissing
        ? "UnverifiedRasterSemantics"
        : "IncompatibleRasterSemantics",
      message: unitsMissing
        ? "Both selected layers must declare the same units before the backend can report a scientifically meaningful numerical difference."
        : "The selected layers do not declare compatible units, so a numerical difference would not be scientifically meaningful.",
      scalarSemantics: {
        a: publicScalarSemantics(recordA?.scalarSemantics),
        b: publicScalarSemantics(recordB?.scalarSemantics),
      },
    };
  }
  return null;
}

async function buildLayerCatalog(mission) {
  const missionName = mission;
  const cached = getCachedLayerCatalog(missionName);
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
          scalarSemantics: extractScalarSemantics(node),
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
  setCachedLayerCatalog(missionName, catalog);
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
function selectTiffForTime(tiffs, requestedTime = "") {
  const candidates = Array.isArray(tiffs)
    ? tiffs.filter((name) => /\.tif[f]?$/i.test(name)).sort()
    : [];
  if (candidates.length === 0) return null;
  if (!requestedTime) return candidates[candidates.length - 1];

  const target = Date.parse(normalizeAnalysisTimeValue(requestedTime));
  let selected = null;
  let bestDistance = Infinity;
  for (const filename of candidates) {
    const match = filename.match(/(?:^|\D)(\d{4})(\d{2})(\d{2})(?:\D|$)/);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const timestamp = Date.UTC(year, month - 1, day);
    const parsed = new Date(timestamp);
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      continue;
    }
    const distance = Math.abs(timestamp - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      selected = filename;
    }
  }
  // An explicit time must never silently degrade to an arbitrary undated
  // asset; callers can surface that the requested temporal slice is missing.
  return selected;
}

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
    const selected = selectTiffForTime(entries, requestedTime);
    if (!selected) continue;
    return path.join(dir, selected);
  }
  return null;
}

async function findConfiguredStacCollection(layerName, mission) {
  const config = await loadMissionConfig(mission);
  if (!config) return null;
  const layers = Array.isArray(config.layers) ? config.layers : [];
  let best = null;
  let bestScore = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    const name = typeof node.name === "string" ? node.name.trim() : "";
    const collection =
      typeof node.url === "string" ? node.url.trim() : "";
    if (name && node.sourceType === "stac-collection" && collection) {
      const score = scoreCandidate(layerName, name);
      if (score > bestScore) {
        bestScore = score;
        best = {
          name,
          collection,
          score,
          scalarSemantics: extractScalarSemantics(node),
        };
      }
    }
    if (Array.isArray(node.sublayers)) node.sublayers.forEach(visit);
  };
  layers.forEach(visit);
  return best;
}

async function resolveLayerRasterForAnalytics(
  layerName,
  mission,
  requestedTime = "",
) {
  const stac = await findConfiguredStacCollection(layerName, mission);
  if (stac) {
    const stacPath = findNewestTiffInCollection(
      mission,
      stac.collection,
      requestedTime,
    );
    const localCollection = isSafePathSegment(stac.collection);
    return {
      name: stac.name,
      path: stacPath,
      score: stac.score,
      provider: localCollection ? "mission-stac-raster" : "remote-stac",
      requestedTime: requestedTime || null,
      scalarSemantics: stac.scalarSemantics || extractScalarSemantics(),
    };
  }

  const record = await findLayerRaster(layerName, mission);
  if (record?.path) {
    return {
      ...record,
      provider: "mission-raster",
      requestedTime: requestedTime || null,
    };
  }

  const collectionPath = findNewestTiffInCollection(
    mission,
    layerName,
    requestedTime,
  );
  if (collectionPath) {
    return {
      name: layerName,
      path: collectionPath,
      score: 1,
      provider: "mission-collection-raster",
      requestedTime: requestedTime || null,
      scalarSemantics: extractScalarSemantics(),
    };
  }
  return null;
}

function describeAnalyticsLayerAvailability(entry, mission, overrides = {}) {
  const sources = Array.isArray(entry?.sources) ? entry.sources : [];
  const sourceType = String(entry?.sourceType || "").toLowerCase();
  const resolveLocal =
    overrides.resolveRasterPathFromSources || resolveRasterPathFromSources;
  const resolveCollection =
    overrides.findNewestTiffInCollection || findNewestTiffInCollection;
  const isStac = sourceType === "stac-collection";
  const scalarSemantics = publicScalarSemantics(
    entry?.scalarSemantics || extractScalarSemantics(),
  );
  const hasRemoteSource = sources.some((source) =>
    /^https?:\/\//i.test(String(source || "")),
  );

  if (isStac) {
    const collection = sources.find((source) =>
      isSafePathSegment(String(source || "").replace(/^stac-collection:/i, "")),
    );
    const local = collection
      ? resolveCollection(
          mission,
          String(collection).replace(/^stac-collection:/i, ""),
        )
      : null;
    if (local) {
      return {
        provider: "mission-stac-raster",
        availability: "available",
        analyzable: scalarSemantics.backend_supported ? true : null,
        backend_analyzable: scalarSemantics.backend_supported,
        scalar_semantics: scalarSemantics,
        availability_reason: scalarSemantics.backend_supported
          ? "A local raster asset is available for this STAC collection."
          : "A local asset is available, but configured value semantics require validated client-side analysis.",
      };
    }
    return {
      provider: hasRemoteSource ? "remote-stac" : "stac-collection",
      availability: "configured-client-resolvable",
      analyzable: null,
      backend_analyzable: false,
      scalar_semantics: scalarSemantics,
      availability_reason:
        "The STAC provider is configured, but server-side raster availability has not been verified; the client may resolve an item asset.",
    };
  }

  if (resolveLocal(sources, mission)) {
    return {
      provider: "mission-raster",
      availability: "available",
      analyzable: scalarSemantics.backend_supported ? true : null,
      backend_analyzable: scalarSemantics.backend_supported,
      scalar_semantics: scalarSemantics,
      availability_reason: scalarSemantics.backend_supported
        ? "A local raster source is available."
        : "A local raster is available, but configured value semantics require validated client-side analysis.",
    };
  }
  if (hasRemoteSource) {
    return {
      provider: "remote-source",
      availability: "configured-unverified",
      analyzable: null,
      backend_analyzable: false,
      scalar_semantics: scalarSemantics,
      availability_reason:
        "A remote source is configured, but scalar raster access has not been verified by this backend.",
    };
  }
  if (sources.length) {
    return {
      provider: "mission-raster",
      availability: "unavailable",
      analyzable: false,
      backend_analyzable: false,
      scalar_semantics: scalarSemantics,
      availability_reason: "The configured local raster source is not currently available.",
    };
  }
  return {
    provider: "none",
    availability: "metadata-only",
    analyzable: false,
    backend_analyzable: false,
    scalar_semantics: scalarSemantics,
    availability_reason: "No raster analysis source is configured.",
  };
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
        return {
          name: entry.name,
          path: resolved,
          score,
          scalarSemantics: entry.scalarSemantics || extractScalarSemantics(),
        };
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
      scalarSemantics: extractScalarSemantics(),
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

function getRuntimeCapabilities(context) {
  if (!context || typeof context !== "object") return [];
  const raw =
    context.capabilities ||
    context.runtimeCapabilities ||
    context.runtime_capabilities ||
    context.tools;
  return sanitizeRuntimeCapabilities(raw);
}

function getLiveToolOptions(req, runtimeCapabilities = []) {
  const staticRegistry =
    req.app?.locals?.agentToolRegistry || { tools: [] };
  const registry = mergeToolRegistries(
    staticRegistry,
    runtimeCapabilities,
  );
  const toolNames = new Set(
    (registry.tools || []).map((tool) => tool?.name).filter(Boolean),
  );
  const validators = {
    ...(req.app?.locals?.agentToolValidators || {}),
  };
  const ajv =
    req.app?.locals?.agentAjv ||
    new Ajv({
      allErrors: true,
      strict: false,
      coerceTypes: true,
      useDefaults: true,
    });
  for (const tool of registry.tools || []) {
    if (typeof validators[tool.name] === "function") continue;
    validators[tool.name] = ajv.compile(
      tool.parameters || { type: "object", additionalProperties: false },
    );
  }
  return { registry, toolNames, validators };
}

function parseBboxFromQuery(query) {
  const keys = ["lon_min", "lat_min", "lon_max", "lat_max"];
  if (keys.every((key) => query[key] != null)) {
    const values = keys.map((key) => {
      const raw = query[key];
      if (
        Array.isArray(raw) ||
        (typeof raw === "string" && !raw.trim())
      ) {
        return Number.NaN;
      }
      return Number(raw);
    });
    if (
      values.every((value) => Number.isFinite(value)) &&
      values[0] < values[2] &&
      values[1] < values[3] &&
      values[0] >= -180 &&
      values[2] <= 180 &&
      values[1] >= -90 &&
      values[3] <= 90
    ) {
      return values;
    }
  }
  if (typeof query.b === "string") {
    const rawParts = query.b.split(",");
    const parts = rawParts.map((value) =>
      value.trim() ? Number(value.trim()) : Number.NaN,
    );
    if (
      rawParts.length === 4 &&
      parts.length === 4 &&
      parts.every((value) => Number.isFinite(value)) &&
      parts[0] < parts[2] &&
      parts[1] < parts[3] &&
      parts[0] >= -180 &&
      parts[2] <= 180 &&
      parts[1] >= -90 &&
      parts[3] <= 90
    ) {
      return parts;
    }
  }
  return null;
}

function getDifferenceBboxError(query = {}) {
  const hasRequestedBbox =
    query.b != null ||
    ["lon_min", "lat_min", "lon_max", "lat_max"].some(
      (key) => query[key] != null,
    );
  if (!hasRequestedBbox) return null;
  if (!parseBboxFromQuery(query)) {
    return {
      status: 400,
      code: "InvalidBoundingBox",
      message: "The requested geographic bounds are invalid.",
    };
  }
  return null;
}

function classifyRasterStatsProcessError(error) {
  const diagnostic = String(error?.stderr || "");
  if (
    /proj\.db|database\.layout\.version|proj_create/i.test(diagnostic)
  ) {
    const typed = new Error(
      "Raster projection support is temporarily unavailable on the analytics provider.",
    );
    typed.code = "RasterProjectionUnavailable";
    typed.status = 503;
    typed.cause = error;
    return typed;
  }
  if (diagnostic.includes("MMGIS_MISSING_RASTER_CRS")) {
    const typed = new Error(
      "Statistics over geographic bounds require CRS metadata for the selected raster.",
    );
    typed.code = "MissingRasterCrs";
    typed.status = 422;
    typed.cause = error;
    return typed;
  }
  if (diagnostic.includes("MMGIS_UNSAFE_FULL_READ")) {
    const typed = new Error(
      "The requested raster statistics mode exceeds the safe full-read limit.",
    );
    typed.code = "UnsafeRasterRead";
    typed.status = 422;
    typed.cause = error;
    return typed;
  }
  return error;
}

function getRasterStatsAttempts() {
  return [
    {
      mode: "auto",
      tileSize: 1024,
      maxQuantileSamples: 65536,
      maxSamples: 5000,
    },
    {
      mode: "sampled",
      sampleSpacing: 1.0,
      maxQuantileSamples: 65536,
      maxSamples: 5000,
    },
  ];
}

async function runRasterStats(rasterPath, bbox, options = {}) {
  const mode = options.mode || "auto";
  const args = [RASTER_STATS_SCRIPT, rasterPath, "--mode", mode];
  if (bbox) args.push("--bbox", ...bbox.map((value) => String(value)));
  if (typeof options.tileSize === "number") {
    args.push("--tile-size", String(options.tileSize));
  }
  if (typeof options.sampleSpacing === "number") {
    args.push("--sample-spacing", String(options.sampleSpacing));
  }
  if (typeof options.maxSamples === "number") {
    args.push("--max-samples", String(options.maxSamples));
  }
  if (typeof options.maxQuantileSamples === "number") {
    args.push(
      "--max-quantile-samples",
      String(options.maxQuantileSamples),
    );
  }
  let processResult;
  try {
    processResult = await spawnBounded(PYTHON_EXECUTABLE, args, {
      cwd: REPO_ROOT,
    });
  } catch (error) {
    throw classifyRasterStatsProcessError(error);
  }
  const { stdout, stderr } = processResult;
  try {
    return JSON.parse(stdout || "{}");
  } catch (error) {
    const err = new Error(
      `Failed to parse raster stats output: ${error.message}`,
    );
    err.code = "InvalidAnalysisOutput";
    err.stderr = stderr;
    throw err;
  }
}

function buildRasterDifferenceArgs({
  pathA,
  pathB,
  layerNameA,
  layerNameB,
  bbox = null,
}) {
  const args = [
    RASTER_DIFFERENCE_SCRIPT,
    "--path-a", pathA,
    "--path-b", pathB,
    "--layer-a", layerNameA,
    "--layer-b", layerNameB,
    "--mode", "auto",
    "--tile-size", "1024",
    "--max-samples", "5000",
    "--max-quantile-samples", "65536",
  ];
  if (bbox) {
    // One argv token is essential for negative western longitudes: with
    // separate tokens argparse can interpret '-106,...' as another option.
    args.push(`--bbox=${bbox.join(",")}`);
  }
  return args;
}

function getToolNames(req, toolOptions) {
  return toolOptions?.toolNames || req.app?.locals?.agentToolNames || new Set();
}

function getValidators(req, toolOptions) {
  return toolOptions?.validators || req.app?.locals?.agentToolValidators || {};
}

function repr(v) {
  try {
    if (typeof v === "string") return `"${v}"`;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function validateAction(action, req, toolOptions) {
  if (!action || typeof action !== "object") {
    throw new TypeError(
      `Action must be an object; received ${repr(action)} instead`,
    );
  }
  const toolNames = getToolNames(req, toolOptions);
  if (!toolNames.has(action.tool)) {
    const expected = [...toolNames].join(", ") || "(none)";
    throw new Error(
      `Unknown tool '${action.tool}'. Expected one of ${expected}; received ${repr(action.tool)} instead`,
    );
  }
  const validators = getValidators(req, toolOptions);
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
  const validated = { tool: action.tool, args };
  if (typeof action.callId === "string" && action.callId.trim()) {
    validated.callId = action.callId.trim().slice(0, 200);
  }
  return validated;
}

function publicAgentError(error, fallbackMessage = "Copilot request failed.") {
  const code = error?.code || "CopilotRequestFailed";
  const explicitStatus = Number.isInteger(error?.status) ? error.status : null;
  const providerRejectedRequest =
    (explicitStatus === 400 || explicitStatus === 422) &&
    String(code).toLowerCase() === "invalid_payload";
  if (providerRejectedRequest) {
    return {
      status: 502,
      code: "CopilotProviderFailed",
      message: "Copilot's language-model provider rejected the request.",
    };
  }
  if (explicitStatus && explicitStatus < 500) {
    return { status: explicitStatus, code, message: error.message };
  }
  if (code === "MissingAzureAgentEnv" || code === "ProviderUnavailable") {
    return {
      status: 503,
      code: "CopilotProviderUnavailable",
      message: "Copilot's language-model provider is not configured or unavailable.",
    };
  }
  if (code === "InvalidToolResults" || code === "MissingPreviousResponseId") {
    return {
      status: 400,
      code,
      message: error.message,
    };
  }
  if (code === "ProviderContinuationMismatch") {
    return {
      status: 409,
      code,
      message: "The submitted tool results do not match the active Copilot provider.",
    };
  }
  if (
    [
      "InvalidAgentPlan",
      "EmptyModelResponse",
      "AzureAgentEmptyOutput",
      "InvalidAgentFunctionCall",
    ].includes(code)
  ) {
    return {
      status: 502,
      code: "InvalidModelResponse",
      message: "Copilot returned a malformed or empty model response. Please try again.",
    };
  }
  if (code === "AzureAgentRunFailed") {
    return {
      status: 502,
      code: "CopilotProviderFailed",
      message: "Copilot's language-model provider could not complete the request.",
    };
  }
  return {
    status: explicitStatus || 500,
    code,
    message: explicitStatus && explicitStatus < 500
      ? error.message
      : fallbackMessage,
  };
}

router.post("/", computeLimiter, express.json(), async function (req, res) {
  try {
    const message = req.body?.message ?? "";
    if (typeof message !== "string") {
      const err = new Error("Message must be a string.");
      err.status = 400;
      throw err;
    }
    if (!message.trim()) {
      const err = new Error("Message must not be empty.");
      err.status = 400;
      err.code = "EmptyMessage";
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
    const runtimeCapabilities = getRuntimeCapabilities(bodyContext);
    const toolOptions = getLiveToolOptions(req, runtimeCapabilities);
    const safeRequestContext = sanitizeRuntimeContext(
      bodyContext,
      req.body?.history,
    );
    const layerInfoStore = req.agentLayerInfo;
    const layerSummaries = selectLayerSummaries(layerInfoStore);

    // Runtime state is authoritative for ownership and pending calls.
    // Database persistence remains best-effort so DB permission/sync failures
    // cannot turn into a global Copilot outage.
    const owner = requestIdentity(req);
    let conversationId =
      typeof req.body?.conversationId === "string"
        ? req.body.conversationId.trim()
        : null;
    let runtimeConversation = conversationId
      ? getRuntimeConversation(conversationId, owner, mission)
      : null;
    let conversation = null;
    let azureThreadId = runtimeConversation?.azureThreadId || null;

    if (runtimeConversation) {
      try {
        conversation = await AgentConversation.findByPk(conversationId);
        if (conversation?.missionName === mission) {
          azureThreadId =
            runtimeConversation.azureThreadId ||
            conversation.azureThreadId ||
            null;
        } else {
          conversation = null;
        }
      } catch (_) {
        conversation = null;
      }
    }

    if (!runtimeConversation) {
      conversationId = uuidv4();
      runtimeConversation = beginRuntimeConversation({
        conversationId,
        owner,
        mission,
        messages: [],
      });
      conversation = await bestEffortCreateConversation(
        AgentConversation,
        {
          conversationId,
          missionName: mission,
          title: message.slice(0, 200),
          messages: [],
        },
        (error) => {
          // eslint-disable-next-line no-console
          console.warn(
            "Copilot conversation persistence unavailable:",
            error?.message,
          );
        },
      );
    }

    const result = await planWithProvider(message, {
      layerHints: clientLayerHints,
      layerSummaries,
      ...safeRequestContext,
    }, { threadId: azureThreadId, ...toolOptions });
    if (!result || !Array.isArray(result.actions)) {
      const err = new Error(
        "Provider returned malformed response (missing actions array).",
      );
      err.code = "InvalidModelResponse";
      throw err;
    }

    const reply = typeof result.reply === "string" ? result.reply.trim() : "";
    const citations = Array.isArray(result.citations) ? result.citations : [];
    const actions = result.actions.map((action) =>
      validateAction(action, req, toolOptions),
    );

    // planWithProvider() (provider.js) already guarantees a non-empty, readable
    // `reply` — describing planned actions in plain language when the model
    // omitted one, or a fallback message when there was nothing to plan. Only
    // append the raw "Planned: ..." trace as a last-resort safety net so the
    // assistant message can never end up empty even if that guarantee is
    // ever violated upstream.
    const segments = [];
    if (reply) segments.push(reply);
    if (!reply) {
      const planList = actions.map((a) => a.tool).join(", ") || "(none)";
      segments.push(`Planned: ${planList}.`);
    }
    const text = segments.join("\n\n");
    const finalReply = reply || text;

    const debug = {
      providerAttempted: true,
      providerReturnedActions: actions.length > 0,
      providerFailureReason: null,
    };
    if (result.debug) {
      debug.azure = result.debug;
    }

    runtimeConversation.messages = [
      ...(runtimeConversation.messages || []),
      { role: "user", text: message },
      { role: "assistant", text: finalReply, actions, citations },
    ].slice(-40);
    runtimeConversation.azureThreadId =
      result.threadId || runtimeConversation.azureThreadId;
    setPendingActions(runtimeConversation, actions, result.responseId);

    // Persist messages to conversation
    try {
      if (!conversation) throw new Error("persistence unavailable");
      const updatedMessages = [
        ...(conversation.messages || []),
        { role: "user", text: message, timestamp: new Date().toISOString() },
        { role: "assistant", text: finalReply, actions, citations, timestamp: new Date().toISOString() },
      ];
      await conversation.update({
        messages: updatedMessages,
        azureThreadId: result.threadId || azureThreadId,
      });
    } catch (persistenceError) {
      // Non-fatal: response still goes through even if persistence fails, but
      // keep a scrubbed diagnostic so degraded persistence is observable.
      // eslint-disable-next-line no-console
      console.warn(
        "Failed to persist Copilot response:",
        redactSensitiveText(
          persistenceError?.message || persistenceError?.code || "unknown",
          500,
        ),
      );
    }

    res.status(200).json({
      text,
      reply: finalReply,
      citations,
      actions,
      conversationId,
      responseId: result.responseId || null,
      source: "provider",
      debug,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Agent planning error:", error);
    const publicError = publicAgentError(error, "Agent planning failed.");
    const response = {
      error: publicError.message,
      code: publicError.code,
    };
    if (error.validationErrors)
      response.validationErrors = error.validationErrors;
    res.status(publicError.status).json(response);
  }
});

router.post("/continue", computeLimiter, express.json(), async function (req, res) {
  let runtimeConversation = null;
  let pendingClaim = null;
  try {
    const mission = getMissionFromRequest(req);
    const rawConversationId = req.body?.conversationId;
    if (
      typeof rawConversationId !== "string" ||
      !rawConversationId.trim() ||
      rawConversationId.length > 128
    ) {
      const err = new Error("A valid conversationId is required.");
      err.status = 400;
      err.code = "InvalidConversationId";
      throw err;
    }
    const conversationId = rawConversationId.trim();
    const owner = requestIdentity(req);
    runtimeConversation = getRuntimeConversation(
      conversationId,
      owner,
      mission,
    );
    if (!runtimeConversation) {
      const err = new Error("Conversation not found for this mission.");
      err.status = 404;
      err.code = "ConversationNotFound";
      throw err;
    }

    let conversation = null;
    try {
      const stored = await AgentConversation.findByPk(conversationId);
      if (stored?.missionName === mission) conversation = stored;
    } catch (_) {
      // Runtime state is sufficient when persistence is unavailable.
    }
    const priorMessages = Array.isArray(runtimeConversation.messages)
      ? runtimeConversation.messages
      : [];
    const continuationCount = runtimeConversation.continuationCount || 0;
    if (continuationCount >= MAX_CONTINUATION_STEPS) {
      const err = new Error(
        `Copilot stopped after ${MAX_CONTINUATION_STEPS} action rounds for safety.`,
      );
      err.status = 409;
      err.code = "ContinuationLimitExceeded";
      throw err;
    }

    const toolResults = sanitizeToolResults(req.body?.toolResults);
    const rawResponseId = req.body?.responseId;
    const responseId =
      typeof rawResponseId === "string" ? rawResponseId.trim() : "";
    if (responseId.length > MAX_PROVIDER_ID_CHARS) {
      const err = new Error(
        `responseId exceeds ${MAX_PROVIDER_ID_CHARS} characters.`,
      );
      err.status = 400;
      err.code = "InvalidResponseId";
      throw err;
    }
    const hasNativeCallIds = toolResults.some((result) => result.callId);
    if (hasNativeCallIds && !responseId) {
      const err = new Error(
        "responseId is required when tool results include Azure callId values.",
      );
      err.status = 400;
      err.code = "MissingPreviousResponseId";
      throw err;
    }
    pendingClaim = claimPendingActions(
      runtimeConversation,
      toolResults,
      responseId || null,
    );

    // Results are authorized by the exact pending tool/call correlation above,
    // not by the registry rebuilt for this request. A one-shot capability may
    // unregister after successful client execution. The current registry still
    // constrains every newly planned action below.
    const bodyContext = req.body?.context || {};
    const clientLayerHints = sanitizeLayerHints(bodyContext.layers);
    const runtimeCapabilities = getRuntimeCapabilities(bodyContext);
    const toolOptions = getLiveToolOptions(req, runtimeCapabilities);
    const safeRequestContext = sanitizeRuntimeContext(
      bodyContext,
      req.body?.history,
    );

    const layerInfoStore = req.agentLayerInfo;
    const layerSummaries = selectLayerSummaries(layerInfoStore);
    const result = await continueWithProvider(
      toolResults,
      {
        layerHints: clientLayerHints,
        layerSummaries,
        ...safeRequestContext,
      },
      {
        threadId: runtimeConversation.azureThreadId || null,
        responseId: responseId || null,
        ...toolOptions,
      },
    );
    if (!result || !Array.isArray(result.actions)) {
      const err = new Error(
        "Provider returned malformed continuation response.",
      );
      err.code = "InvalidModelResponse";
      throw err;
    }

    let actions = result.actions.map((action) =>
      validateAction(action, req, toolOptions),
    );
    let reply = typeof result.reply === "string" ? result.reply.trim() : "";
    let limitReached = false;
    if (
      continuationCount + 1 >= MAX_CONTINUATION_STEPS &&
      actions.length > 0
    ) {
      actions = [];
      limitReached = true;
      reply = [
        reply,
        `Copilot stopped after ${MAX_CONTINUATION_STEPS} action rounds for safety.`,
      ].filter(Boolean).join(" ");
    }
    if (!reply) {
      reply = actions.length
        ? `Running ${[...new Set(actions.map((action) => action.tool))].join(", ")}.`
        : "The requested MMGIS actions completed.";
    }

    const citations = Array.isArray(result.citations) ? result.citations : [];
    completePendingClaim(
      runtimeConversation,
      pendingClaim,
      actions,
      result.responseId,
    );
    pendingClaim = null;
    runtimeConversation.azureThreadId =
      result.threadId || runtimeConversation.azureThreadId;
    const updatedMessages = [
      ...priorMessages,
      {
        role: "tool",
        kind: "copilot-tool-results",
        results: toolResults,
        timestamp: new Date().toISOString(),
      },
      {
        role: "assistant",
        text: reply,
        actions,
        citations,
        timestamp: new Date().toISOString(),
      },
    ];
    runtimeConversation.messages = updatedMessages.slice(-40);
    try {
      if (!conversation) throw new Error("persistence unavailable");
      await conversation.update({
        messages: updatedMessages,
        azureThreadId: result.threadId || conversation.azureThreadId,
      });
    } catch (persistenceError) {
      // Execution already completed; log persistence failure without blanking
      // or discarding the useful Copilot response.
      // eslint-disable-next-line no-console
      console.warn(
        "Failed to persist Copilot continuation:",
        redactSensitiveText(
          persistenceError?.message || persistenceError?.code || "unknown",
          500,
        ),
      );
    }

    res.status(200).json({
      text: reply,
      reply,
      citations,
      actions,
      conversationId,
      responseId: result.responseId || null,
      source: "provider",
      limitReached,
      debug: result.debug
        ? { providerAttempted: true, provider: result.debug }
        : { providerAttempted: true },
    });
  } catch (error) {
    if (runtimeConversation && pendingClaim) {
      releasePendingClaim(runtimeConversation, pendingClaim);
    }
    // eslint-disable-next-line no-console
    console.error("Agent continuation error:", error);
    const publicError = publicAgentError(
      error,
      "Copilot could not continue after executing the requested action.",
    );
    res.status(publicError.status).json({
      error: publicError.message,
      code: publicError.code,
    });
  }
});

router.post("/stream", computeLimiter, express.json(), async function (req, res) {
  try {
    const message = req.body?.message ?? "";
    if (typeof message !== "string") {
      return res.status(400).json({ error: "Message must be a string." });
    }
    if (!message.trim()) {
      return res.status(400).json({
        error: "Message must not be empty.",
        code: "EmptyMessage",
      });
    }
    if (message.length > 2000) {
      return res.status(400).json({ error: "Message too long (max 2000 chars)." });
    }

    const mission = getMissionFromRequest(req);
    const bodyContext = req.body?.context || {};
    const clientLayerHints = sanitizeLayerHints(bodyContext.layers);
    const runtimeCapabilities = getRuntimeCapabilities(bodyContext);
    const toolOptions = getLiveToolOptions(req, runtimeCapabilities);
    const safeRequestContext = sanitizeRuntimeContext(
      bodyContext,
      req.body?.history,
    );
    const layerInfoStore = req.agentLayerInfo;
    const layerSummaries = selectLayerSummaries(layerInfoStore);

    const owner = requestIdentity(req);
    let conversationId =
      typeof req.body?.conversationId === "string"
        ? req.body.conversationId.trim()
        : null;
    let runtimeConversation = conversationId
      ? getRuntimeConversation(conversationId, owner, mission)
      : null;
    let conversation = null;
    let azureThreadId = runtimeConversation?.azureThreadId || null;

    if (runtimeConversation) {
      try {
        conversation = await AgentConversation.findByPk(conversationId);
        if (conversation?.missionName === mission) {
          azureThreadId =
            runtimeConversation.azureThreadId ||
            conversation.azureThreadId ||
            null;
        } else {
          conversation = null;
        }
      } catch (persistenceError) {
        // eslint-disable-next-line no-console
        console.warn(
          "Failed to persist streamed Copilot response:",
          redactSensitiveText(
            persistenceError?.message || persistenceError?.code || "unknown",
            500,
          ),
        );
      }
    }

    if (!runtimeConversation) {
      conversationId = uuidv4();
      runtimeConversation = beginRuntimeConversation({
        conversationId,
        owner,
        mission,
        messages: [],
      });
      conversation = await bestEffortCreateConversation(
        AgentConversation,
        {
          conversationId,
          missionName: mission,
          title: message.slice(0, 200),
          messages: [],
        },
      );
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
      {
        layerHints: clientLayerHints,
        layerSummaries,
        ...safeRequestContext,
      },
      { threadId: azureThreadId, ...toolOptions },
    )) {
      if (event.type === "plan") {
        // Validate actions before sending
        const validatedActions = [];
        for (const action of event.data.actions || []) {
          try {
            validatedActions.push(validateAction(action, req, toolOptions));
          } catch (error) {
            error.code = error.code || "InvalidModelResponse";
            throw error;
          }
        }
        lastPlan = { ...event.data, actions: validatedActions };
        res.write(`data: ${JSON.stringify({
          type: "plan",
          data: lastPlan,
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }

    // Persist conversation after stream completes. Runtime state remains
    // authoritative and is updated even if the optional database write fails.
    if (lastPlan) {
      const reply = lastPlan?.reply || "";
      const actions = lastPlan?.actions || [];
      const citations = lastPlan?.citations || [];
      const newThreadId = lastPlan?.threadId || azureThreadId;
      const updatedMessages = [
        ...(runtimeConversation.messages || []),
        { role: "user", text: message, timestamp: new Date().toISOString() },
        { role: "assistant", text: reply, actions, citations, timestamp: new Date().toISOString() },
      ];
      runtimeConversation.messages = updatedMessages.slice(-40);
      runtimeConversation.azureThreadId = newThreadId;
      setPendingActions(
        runtimeConversation,
        actions,
        lastPlan.responseId,
      );
      try {
        if (!conversation) throw new Error("persistence unavailable");
        await conversation.update({
          messages: updatedMessages,
          azureThreadId: newThreadId,
        });
      } catch (persistenceError) {
        // Runtime state remains authoritative, but keep the optional database
        // failure visible in sanitized server logs for diagnosis.
        // eslint-disable-next-line no-console
        console.warn(
          "Failed to persist streamed Copilot response:",
          redactSensitiveText(
            persistenceError?.message || persistenceError?.code || "unknown",
            500,
          ),
        );
      }
    }

    res.end();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error("Agent stream error:", error);
    const publicError = publicAgentError(error, "Agent streaming failed.");
    if (!res.headersSent) {
      res.status(publicError.status).json({
        error: publicError.message,
        code: publicError.code,
      });
    } else {
      res.write(`data: ${JSON.stringify({
        type: "error",
        code: publicError.code,
        data: publicError.message,
      })}\n\n`);
      res.end();
    }
  }
});

router.get("/layer-info", (req, res) => {
  const store = req.agentLayerInfo;
  if (!store || store.error) {
    res.status(404).json({
      error: "Layer metadata is unavailable.",
      code: "LayerInfoUnavailable",
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
    items: sanitizeLayerInfoItems(items),
    match,
    source: {
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

    const bboxError = getDifferenceBboxError(req.query);
    if (bboxError) {
      return res.status(bboxError.status).json({
        code: bboxError.code,
        error: bboxError.message,
      });
    }
    const bbox = parseBboxFromQuery(req.query);
    const requestedTime = readOptionalAnalysisTime(req.query);
    const layerRecord = await resolveLayerRasterForAnalytics(
      layerName,
      mission,
      requestedTime,
    );
    if (!layerRecord || !layerRecord.path) {
      if (layerRecord?.provider === "mission-stac-raster" && requestedTime) {
        res.status(404).json({
          code: "RasterTimeUnavailable",
          error: `No dated raster asset is available for layer '${layerRecord.name}' near the requested time.`,
          layer_name: layerRecord.name,
          provider: layerRecord.provider,
          requested_time: requestedTime,
        });
        return;
      }
      const catalog = await buildLayerCatalog(mission);
      const scored = scoreCatalog(catalog, normalizeName(layerName));
      const catalogMatch = scored.length ? scored[0].entry : null;
      if (catalogMatch) {
        const availability = describeAnalyticsLayerAvailability(
          catalogMatch,
          mission,
        );
        if (availability.analyzable == null) {
          res.status(422).json({
            code: "UnverifiedRasterProvider",
            error: `Layer '${catalogMatch.name}' is configured through ${availability.provider}, but this backend cannot verify a scalar raster asset for statistics.`,
            layer_name: catalogMatch.name,
            provider: availability.provider,
            availability: availability.availability,
          });
          return;
        }
      }
      if (catalogMatch?.sourceType === "url") {
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

    const scalarSemanticsError = getBackendScalarSemanticsError(
      layerRecord,
      layerRecord.name,
    );
    if (scalarSemanticsError) {
      res.status(scalarSemanticsError.status).json({
        code: scalarSemanticsError.code,
        error: scalarSemanticsError.message,
        scalar_semantics: scalarSemanticsError.scalarSemantics,
        semantics_applied: false,
      });
      return;
    }

    let stats = null;
    const attempts = getRasterStatsAttempts();
    const errors = [];
    for (const attempt of attempts) {
      try {
        stats = await runRasterStats(layerRecord.path, bbox, attempt);
        break;
      } catch (error) {
        if (
          Number.isInteger(error.status) &&
          (error.status < 500 || error.code === "RasterProjectionUnavailable")
        ) {
          throw error;
        }
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
      source: layerRecord.provider || "mission-raster",
      provider: layerRecord.provider || "mission-raster",
      requested_time: requestedTime || null,
      scalar_semantics: publicScalarSemantics(layerRecord.scalarSemantics),
      semantics_applied: true,
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
      requested_mode: stats.requested_mode || "auto",
      mode_selection_reason: stats.mode_selection_reason || null,
      population_coverage: stats.population_coverage || "all-valid-pixels",
      mean_is_approximate: stats.mean_is_approximate === true,
      quantile_method: stats.quantile_method || null,
      quantile_sample_count:
        typeof stats.quantile_sample_count === "number"
          ? stats.quantile_sample_count
          : null,
      quantile_sample_limit:
        typeof stats.quantile_sample_limit === "number"
          ? stats.quantile_sample_limit
          : null,
      quantiles_approximate: stats.quantiles_approximate === true,
      selected_pixel_count:
        typeof stats.selected_pixel_count === "number"
          ? stats.selected_pixel_count
          : null,
      spatial_sample_count:
        typeof stats.spatial_sample_count === "number"
          ? stats.spatial_sample_count
          : null,
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
    if (status < 500 || error.code === "RasterProjectionUnavailable") {
      res.status(status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
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
      aliases: sanitizeCatalogAliases(entry.aliases),
      source_type: entry.sourceType || "unknown",
      ...describeAnalyticsLayerAvailability(entry, mission),
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

    const requestedTime = readOptionalAnalysisTime(req.query);
    const record = await resolveLayerRasterForAnalytics(
      layerName,
      mission,
      requestedTime,
    );
    const resolvedPath = record?.path || null;

    if (!resolvedPath) {
      if (record?.provider === "mission-stac-raster" && requestedTime) {
        res.status(404).json({
          code: "RasterTimeUnavailable",
          error: `No dated raster asset is available for layer '${record.name}' near the requested time.`,
          layer_name: record.name,
          requested_time: requestedTime,
        });
        return;
      }
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

    res.status(200).json({
      url: titilerUrl,
      mission,
      provider: record?.provider || "mission-raster",
      availability: "available",
      requested_time: requestedTime || null,
      scalar_semantics: publicScalarSemantics(record?.scalarSemantics),
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
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

    const bboxError = getDifferenceBboxError(req.query);
    if (bboxError) {
      return res.status(bboxError.status).json({
        code: bboxError.code,
        error: bboxError.message,
      });
    }

    const requestedTime = readOptionalAnalysisTime(req.query);
    const recordA = await resolveLayerRasterForAnalytics(
      layerNameA,
      mission,
      requestedTime,
    );
    const recordB = await resolveLayerRasterForAnalytics(
      layerNameB,
      mission,
      requestedTime,
    );
    if (!recordA?.path) {
      if (recordA?.provider === "mission-stac-raster" && requestedTime) {
        return res.status(404).json({
          code: "RasterTimeUnavailable",
          error: `No dated raster asset is available for layer '${recordA.name}' near the requested time.`,
          layer_name: recordA.name,
          requested_time: requestedTime,
        });
      }
      return res.status(404).json({ error: `Cannot find raster for layer '${layerNameA}'.` });
    }
    if (!recordB?.path) {
      if (recordB?.provider === "mission-stac-raster" && requestedTime) {
        return res.status(404).json({
          code: "RasterTimeUnavailable",
          error: `No dated raster asset is available for layer '${recordB.name}' near the requested time.`,
          layer_name: recordB.name,
          requested_time: requestedTime,
        });
      }
      return res.status(404).json({ error: `Cannot find raster for layer '${layerNameB}'.` });
    }

    const semanticsError = getComparisonScalarSemanticsError(
      recordA,
      recordB,
    );
    if (semanticsError) {
      return res.status(semanticsError.status).json({
        code: semanticsError.code,
        error: semanticsError.message,
        scalar_semantics: semanticsError.scalarSemantics,
        semantics_applied: false,
      });
    }

    // Compute the difference in a dedicated Python script. All values are
    // passed as argv — no caller-controlled data is ever interpolated into
    // source code — so there is no path to arbitrary code execution.
    const requestedBbox = parseBboxFromQuery(req.query);
    const args = buildRasterDifferenceArgs({
      pathA: recordA.path,
      pathB: recordB.path,
      layerNameA,
      layerNameB,
      bbox: requestedBbox,
    });
    const { stdout, stderr } = await spawnBounded(
      PYTHON_EXECUTABLE,
      args,
      { cwd: REPO_ROOT },
    );
    let result;
    try {
      result = JSON.parse(stdout || "{}");
    } catch (error) {
      const invalidOutput = new Error("Difference computation returned invalid output.");
      invalidOutput.code = "InvalidAnalysisOutput";
      invalidOutput.stderr = stderr;
      throw invalidOutput;
    }

    if (result.error) {
      return res.status(422).json({ error: result.error });
    }

    result.provider_a = recordA.provider || "mission-raster";
    result.provider_b = recordB.provider || "mission-raster";
    result.requested_time = requestedTime || null;
    result.scalar_semantics = {
      a: publicScalarSemantics(recordA.scalarSemantics),
      b: publicScalarSemantics(recordB.scalarSemantics),
    };
    result.layer_a_semantics = result.scalar_semantics.a;
    result.layer_b_semantics = result.scalar_semantics.b;
    result.semantics_applied = true;

    res.status(200).json(result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status < 500) {
      res.status(status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    } else {
      sendError(res, 500, "Failed to compute layer difference.", error);
    }
  }
});

// --- Conversation endpoints ---

router.get("/conversations", async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const owner = requestIdentity(req);
    const conversations = listRuntimeConversations(owner, mission).map(
      (state) => {
        const firstUser = state.messages.find(
          (entry) => entry?.role === "user",
        );
        return {
          conversationId: state.conversationId,
          title: (firstUser?.text || "Copilot conversation").slice(0, 200),
          createdAt: new Date(state.createdAt).toISOString(),
          updatedAt: new Date(state.updatedAt).toISOString(),
        };
      },
    );
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
    const mission = getMissionFromRequest(req);
    const state = getRuntimeConversation(
      req.params.id,
      requestIdentity(req),
      mission,
    );
    if (!state) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    res.status(200).json({
      conversationId: state.conversationId,
      missionName: state.mission,
      messages: state.messages,
      createdAt: new Date(state.createdAt).toISOString(),
      updatedAt: new Date(state.updatedAt).toISOString(),
    });
  } catch (error) {
    sendError(res, 500, "Failed to get conversation.", error);
  }
});

router.delete("/conversations/:id", async (req, res) => {
  try {
    const mission = getMissionFromRequest(req);
    const state = deleteRuntimeConversation(
      req.params.id,
      requestIdentity(req),
      mission,
    );
    if (!state) {
      return res.status(404).json({ error: "Conversation not found." });
    }
    // Best-effort cleanup of Azure conversation (legacy field: azureThreadId)
    if (state.azureThreadId) {
      try {
        const cfg = haveFasEnv();
        if (cfg.ok) {
          const client = getClient(cfg.endpoint);
          await client.conversations.delete(state.azureThreadId);
        }
      } catch (_) {
        // Non-fatal
      }
    }
    try {
      const conversation = await AgentConversation.findByPk(req.params.id);
      if (conversation?.missionName === mission) {
        await conversation.destroy();
      }
    } catch (_) {
      // Runtime deletion succeeded; optional persistence may be unavailable.
    }
    res.status(200).json({ deleted: true });
  } catch (error) {
    sendError(res, 500, "Failed to delete conversation.", error);
  }
});

router._testHelpers = {
  sanitizeLayerHints,
  getRuntimeCapabilities,
  getLiveToolOptions,
  publicAgentError,
  getCachedLayerCatalog,
  setCachedLayerCatalog,
  layerCatalogCache,
  getDifferenceBboxError,
  classifyRasterStatsProcessError,
  getRasterStatsAttempts,
  sanitizeLayerInfoItems,
  sanitizeLayerSource,
  selectLayerSummaries,
  normalizeAnalysisTimeValue,
  readOptionalAnalysisTime,
  selectTiffForTime,
  describeAnalyticsLayerAvailability,
  buildRasterDifferenceArgs,
  extractScalarSemantics,
  publicScalarSemantics,
  getBackendScalarSemanticsError,
  getComparisonScalarSemanticsError,
  resolvePythonExecutable,
};

module.exports = router;
