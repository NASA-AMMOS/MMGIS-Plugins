const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const AgentTool = require("./models/agentTool");

const REGISTRY_PATH = path.join(__dirname, "tool-registry.json");

function loadFileRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tools)) {
    throw new Error("Registry must provide a 'tools' array.");
  }
  return parsed;
}

async function seedFromFile() {
  const registry = loadFileRegistry();
  for (const tool of registry.tools || []) {
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
}

async function reloadRegistry(app) {
  const dbTools = await AgentTool.findAll({ where: { enabled: true } });
  const tools = dbTools.map((t) => t.toJSON());

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

module.exports = { loadFileRegistry, seedFromFile, reloadRegistry };
