const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const router = require("./routes/agent");
const { getAgentAuthMiddleware } = require("./auth");
const { createLayerInfoMiddleware } = require("./missionLayerInfo");

if (!process.env.WITH_AGENT || process.env.WITH_AGENT.toLowerCase() !== "true") {
  module.exports = {
    onceInit: () => {},
    alwaysRun: () => {},
    getAgentAuthMiddleware,
  };
  let logger;
  try { logger = require(path.join(process.cwd(), "API/logger")); } catch (_) {}
  if (logger) logger("info", "Agent plugin disabled (WITH_AGENT != true). Skipping route mount.", "AgentSetup");
  else console.info("[Agent] Plugin disabled (WITH_AGENT != true). Skipping route mount.");
  return;
}

function normalizeLayerName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseLayerInfo(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const parts = line.split("|").map((part) => part.trim());
      if (!parts[0]) return null;
      return {
        name: parts[0],
        summary: parts[1] || "",
        citation: parts[2] || "",
        normalized: normalizeLayerName(parts[0]),
      };
    })
    .filter(Boolean);
}

function loadLayerInfoFromDisk(filePath) {
  const store = {
    items: [],
    index: [],
    sourcePath: filePath,
    loadedAt: null,
    error: null,
  };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseLayerInfo(raw);
    store.items = parsed.map((item) => ({
      name: item.name,
      summary: item.summary,
      citation: item.citation,
    }));
    store.index = parsed.map((item) => ({
      normalized: item.normalized,
      item: {
        name: item.name,
        summary: item.summary,
        citation: item.citation,
      },
    }));
    store.loadedAt = new Date().toISOString();
  } catch (error) {
    store.error = { message: error.message, code: error.code };
  }
  return store;
}

// Build a rich description from all available config properties
function buildLayerSummary(layer) {
  const parts = [];

  // Start with the existing description (strip markdown links)
  if (layer.description) {
    parts.push(layer.description.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"));
  }

  // Source type
  if (layer.sourceType) {
    parts.push(`Source type: ${layer.sourceType}`);
  }

  // Value range + units
  if (layer.cogMin != null || layer.cogMax != null) {
    let range = "Value range:";
    if (layer.cogMin != null) range += ` min ${layer.cogMin}`;
    if (layer.cogMax != null) range += ` max ${layer.cogMax}`;
    if (layer.cogUnits) range += ` ${layer.cogUnits}`;
    parts.push(range);
  }

  // Colormap and resampling
  if (layer.cogColormap) parts.push(`Colormap: ${layer.cogColormap}`);
  if (layer.cogResampling) parts.push(`Resampling: ${layer.cogResampling}`);

  // Time availability
  if (layer.time && layer.time.enabled) {
    let timeLine = "Time-enabled";
    if (layer.time.format) timeLine += ` (format: ${layer.time.format})`;
    if (layer.time.availableStart && layer.time.availableEnd) {
      timeLine += `, range: ${layer.time.availableStart} to ${layer.time.availableEnd}`;
    }
    parts.push(timeLine);
  }

  // Projection
  if (layer.tileMatrixSet) {
    parts.push(`Projection: ${layer.tileMatrixSet}`);
  }

  // Max native zoom (resolution hint)
  if (layer.maxNativeZoom != null) {
    parts.push(`Max native zoom: ${layer.maxNativeZoom}`);
  }

  return parts.join(". ") || `${layer.name || "Unknown"} layer`;
}

// Dynamic layer info from mission config
function getDynamicLayerInfo(missionPath) {
  const store = {
    items: [],
    index: [],
    sourcePath: missionPath,
    loadedAt: null,
    error: null,
  };

  try {
    const configPath = path.join(missionPath, "config.json");
    const configRaw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(configRaw);

    const items = [];

    // Recursively traverse config.layers (array with nested sublayers)
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      // Skip header nodes — they are group containers, not real layers
      if (node.type === "header") {
        if (Array.isArray(node.sublayers)) {
          node.sublayers.forEach(visit);
        }
        return;
      }

      const name =
        typeof node.name === "string" && node.name.trim()
          ? node.name.trim()
          : null;
      if (name) {
        const summary = buildLayerSummary(node);
        const citation =
          node.metadata_url || node.legend || node.url || "";
        const source =
          node.source || node.url || node.path || node.cogUrl || node.href || "";
        const analytics = Array.isArray(node.analytics)
          ? node.analytics.filter((value) => typeof value === "string")
          : Array.isArray(node.analysisCapabilities)
            ? node.analysisCapabilities.filter((value) => typeof value === "string")
            : [];
        const analyzable =
          typeof node.analyzable === "boolean"
            ? node.analyzable
            : analytics.length > 0
              ? true
              : null;

        items.push({
          name: name,
          summary: summary,
          citation: citation,
          type: node.type || "unknown",
          source: source,
          sourceType: node.sourceType || null,
          visible: node.visibility || false,
          timeEnabled: !!(node.time && node.time.enabled),
          time: node.time && typeof node.time === "object"
            ? {
                enabled: !!node.time.enabled,
                current: node.time.current || node.time.value || null,
                start: node.time.availableStart || node.time.start || null,
                end: node.time.availableEnd || node.time.end || null,
              }
            : null,
          analyzable,
          analysisCapabilities: analytics.slice(0, 16),
        });
      }

      if (Array.isArray(node.sublayers)) {
        node.sublayers.forEach(visit);
      }
    };

    if (Array.isArray(config.layers)) {
      config.layers.forEach(visit);
    }

    // Also check for static layer info file in mission directory
    const missionLayerInfoPath = path.join(missionPath, "layer_info.txt");
    if (fs.existsSync(missionLayerInfoPath)) {
      const staticInfo = loadLayerInfoFromDisk(missionLayerInfoPath);
      // Merge static info, preferring it over dynamic for matching layers
      staticInfo.items.forEach((staticItem) => {
        const existingIndex = items.findIndex(
          (i) =>
            normalizeLayerName(i.name) === normalizeLayerName(staticItem.name)
        );
        if (existingIndex >= 0) {
          items[existingIndex].summary =
            staticItem.summary || items[existingIndex].summary;
          items[existingIndex].citation =
            staticItem.citation || items[existingIndex].citation;
        } else {
          items.push(staticItem);
        }
      });
    }

    store.items = items;
    store.index = items.map((item) => ({
      normalized: normalizeLayerName(item.name),
      item: item,
    }));
    store.loadedAt = new Date().toISOString();
  } catch (error) {
    store.error = { message: error.message, code: error.code };
    // Return empty store if mission config unavailable
    return store;
  }

  return store;
}

const LAYER_INFO_PATH = process.env.MAIN_MISSION
  ? path.join(process.cwd(), "Missions", process.env.MAIN_MISSION, "layer_info.txt")
  : null;

let setup = {
  //Once the app initializes
  onceInit: (s) => {
    // Load tool registry and compile validators once
    try {
      const { loadFileRegistry } = require("./registryManager");
      const registry = loadFileRegistry();

      const ajv = new Ajv({
        allErrors: true,
        strict: false,
        coerceTypes: true,
        useDefaults: true,
      });
      const validators = {};
      const toolNames = new Set();
      for (const t of registry.tools || []) {
        toolNames.add(t.name);
        // Ajv can validate top-level schema; we wrap params under object if needed
        validators[t.name] = ajv.compile(
          t.parameters || { type: "object", additionalProperties: false },
        );
      }
      s.app.locals.agentToolRegistry = registry;
      s.app.locals.agentAjv = ajv;
      s.app.locals.agentToolValidators = validators;
      s.app.locals.agentToolNames = toolNames;
    } catch (e) {
      // Keep the server available, but preserve the real failure internally;
      // an empty registry is a degraded mode that should never be silent.
      // eslint-disable-next-line no-console
      console.error(
        "[Agent] Tool registry failed to load; capabilities are disabled.",
        e,
      );
      s.app.locals.agentToolRegistry = { tools: [] };
      s.app.locals.agentToolValidators = {};
      s.app.locals.agentToolNames = new Set();
    }

    // The host guard handles public AUTH=none/off mode, sessions, strict
    // bearer parsing, long-term-token validation, and typed API failures.
    const agentAuthMiddleware = getAgentAuthMiddleware(s);
    const layerInfoMiddleware = createLayerInfoMiddleware({
      loadDynamic: getDynamicLayerInfo,
      loadStatic: loadLayerInfoFromDisk,
      mainMission: process.env.MAIN_MISSION || "",
      mainLayerInfoPath: LAYER_INFO_PATH,
    });

    // Read-only endpoint to fetch the current registry
    s.app.get(
      s.ROOT_PATH + "/api/agent/tools",
      s.checkHeadersCodeInjection,
      agentAuthMiddleware,
      s.setContentType,
      (req, res) => {
        res.status(200).json(req.app.locals.agentToolRegistry || { tools: [] });
      },
    );

    s.app.use(
      s.ROOT_PATH + "/api/agent",
      s.checkHeadersCodeInjection,
      agentAuthMiddleware,
      layerInfoMiddleware,
      s.setContentType,
      router,
    );
  },
  //Once the server starts
  onceStarted: (s) => {},
  //Once all tables sync
  onceSynced: async (s) => {
    try {
      const AgentConversation = require("./models/agentConversation");
      const AgentTool = require("./models/agentTool");
      const { seedFromFile, reloadRegistry } = require("./registryManager");

      await AgentConversation.sync();
      await AgentTool.sync();
      await seedFromFile();
      await reloadRegistry(s.app);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("Agent onceSynced failed:", e?.message);
    }
  },
};

setup.getAgentAuthMiddleware = getAgentAuthMiddleware;

module.exports = setup;
