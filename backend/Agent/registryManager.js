const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const { Op } = require("sequelize");
const AgentTool = require("./models/agentTool");

const REGISTRY_PATH = path.join(__dirname, "tool-registry.json");

function inferCategory(name) {
  if (
    /stat|mean|analyzable|anomal|change|analysis|trend|difference|threshold/.test(
      name,
    )
  ) {
    return "analytics";
  }
  if (/zoom|map|region/.test(name)) return "map-navigation";
  if (/time|temporal|animation/.test(name)) return "temporal";
  if (/layer|opacity|highlight|contour/.test(name)) return "layers-visualization";
  if (/export/.test(name)) return "data";
  return "application";
}

function normalizeRegistry(parsed) {
  return {
    ...parsed,
    tools: (parsed.tools || []).map((tool) => ({
      ...tool,
      category: tool.category || inferCategory(tool.name),
      // One authoritative schema: provider descriptions, Azure Responses
      // registration, and Ajv validation must never disagree.
      modelParameters:
        tool.parameters || { type: "object", additionalProperties: false },
    })),
  };
}

function loadFileRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tools)) {
    throw new Error("Registry must provide a 'tools' array.");
  }
  return normalizeRegistry(parsed);
}

async function seedFromFile() {
  const registry = loadFileRegistry();
  const currentFileToolNames = [];
  for (const tool of registry.tools || []) {
    currentFileToolNames.push(tool.name);
    const fields = {
      description: tool.description || "",
      execution: tool.execution || {},
      modelParameters: tool.modelParameters || {},
      parameters: tool.parameters || {},
    };
    const [row, created] = await AgentTool.findOrCreate({
      where: { name: tool.name },
      defaults: { ...fields, source: "file", enabled: true },
    });
    // Keep file-seeded rows in sync with tool-registry.json on every boot —
    // findOrCreate alone only inserts, so edits to the file (renamed
    // execution.ui.type, fixed description, new parameters, etc.) would
    // otherwise never reach a database that was seeded before the edit.
    // Rows an admin created/edited directly (source !== "file") are left
    // alone, and `enabled` is never overwritten here.
    if (!created && row.source === "file") {
      await row.update(fields);
    }
  }
  // A renamed/removed file tool must not survive forever as an enabled DB row.
  // Reconcile only rows whose provenance is still exactly "file"; admin/API
  // tools and request-scoped runtime plugin capabilities are outside this
  // lifecycle and are never disabled or deleted here.
  await AgentTool.update(
    { enabled: false },
    {
      where: {
        source: "file",
        name: { [Op.notIn]: currentFileToolNames },
      },
    },
  );
}

async function reloadRegistry(app) {
  const dbTools = await AgentTool.findAll({ where: { enabled: true } });
  const { tools } = normalizeRegistry({
    tools: dbTools.map((t) => t.toJSON()),
  });

  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    coerceTypes: true,
    useDefaults: true,
  });
  const validators = {};
  const toolNames = new Set();
  for (const t of tools) {
    toolNames.add(t.name);
    validators[t.name] = ajv.compile(
      t.parameters || { type: "object", additionalProperties: false },
    );
  }

  app.locals.agentToolRegistry = { tools };
  app.locals.agentAjv = ajv;
  app.locals.agentToolValidators = validators;
  app.locals.agentToolNames = toolNames;

  return { tools };
}

module.exports = {
  loadFileRegistry,
  normalizeRegistry,
  inferCategory,
  seedFromFile,
  reloadRegistry,
};
