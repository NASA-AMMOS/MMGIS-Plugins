// Access to the MMGIS Copilot tool registry owned by the Agent backend plugin.
// When the Agent plugin is running, its live registry and compiled Ajv
// validators (app.locals.agentToolRegistry / agentToolValidators) are used so
// MCP input validation is identical to Copilot's validateAction(). Otherwise
// the registry file shipped with the Agent plugin in this container is used for
// discovery only, and calls report the capability as unavailable.

const fs = require("fs");
const path = require("path");

const FILE_REGISTRY_PATH = path.join(__dirname, "..", "..", "Agent", "tool-registry.json");

const ROUTING_PROPERTIES = Object.freeze({
  mission: {
    type: "string",
    minLength: 1,
    description: "Mission to act on. Optional when it can be taken from the selected browser session.",
  },
  session_id: {
    type: "string",
    minLength: 1,
    description: "Target MMGIS browser session (see mmgis_list_sessions). Optional when exactly one matching session is connected.",
  },
});

let fileRegistryCache = null;

function loadFileRegistry() {
  if (fileRegistryCache) return fileRegistryCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE_REGISTRY_PATH, "utf8"));
    fileRegistryCache = parsed && Array.isArray(parsed.tools) ? parsed : { tools: [] };
  } catch (_) {
    fileRegistryCache = { tools: [] };
  }
  return fileRegistryCache;
}

function getRegistry(app) {
  const locals = (app && app.locals) || {};
  const live = locals.agentToolRegistry;
  const validators = locals.agentToolValidators;
  if (live && Array.isArray(live.tools) && validators && typeof validators === "object") {
    return { tools: live.tools, validators, ajv: locals.agentAjv || null, available: true, source: "agent" };
  }
  return { tools: loadFileRegistry().tools, validators: {}, ajv: null, available: false, source: "file" };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Advertised MCP input schema = registry schema + optional routing fields on
// every object node that would otherwise reject unknown properties.
function withRoutingProperties(schema) {
  const out = clone(schema && typeof schema === "object" ? schema : { type: "object", properties: {} });
  if (!out.type) out.type = "object";
  const visit = (node, isRoot) => {
    if (!node || typeof node !== "object") return;
    if (isRoot || node.type === "object" || node.properties || node.additionalProperties === false) {
      node.properties = { ...(node.properties || {}), ...clone(ROUTING_PROPERTIES) };
    }
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(node[key])) node[key].forEach((child) => visit(child, false));
    }
  };
  visit(out, true);
  return out;
}

function splitRouting(args) {
  const { mission, session_id: sessionId, ...rest } = args && typeof args === "object" ? args : {};
  return {
    routing: {
      mission: typeof mission === "string" && mission.trim() ? mission.trim() : null,
      sessionId: typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null,
    },
    toolArgs: rest,
  };
}

function formatAjvErrors(errors) {
  return (errors || []).map((e) => ({
    path: e.instancePath || e.dataPath || "",
    message: e.message,
    params: e.params,
  }));
}

// Same semantics as the Agent's validateAction(): Ajv with coerceTypes and
// useDefaults mutates the args; the coerced copy is what gets executed.
function validateRegistryArgs(registry, toolName, toolArgs) {
  const validate = registry.validators[toolName];
  if (typeof validate !== "function") return { valid: false, args: toolArgs, errors: [{ path: "", message: `No validator for tool ${toolName}` }] };
  const args = clone(toolArgs || {});
  const valid = validate(args);
  return { valid: !!valid, args, errors: valid ? [] : formatAjvErrors(validate.errors) };
}

module.exports = {
  FILE_REGISTRY_PATH,
  ROUTING_PROPERTIES,
  getRegistry,
  loadFileRegistry,
  withRoutingProperties,
  splitRouting,
  validateRegistryArgs,
  formatAjvErrors,
};
