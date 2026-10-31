// Environment configuration for the Copilot MCP plugin. MCP support is opt-in:
// nothing is mounted unless WITH_COPILOT_MCP=true.

const ENVS = [
  { name: "WITH_COPILOT_MCP", description: "Set to 'true' to enable the Copilot MCP endpoint and browser bridge [default false]" },
  { name: "COPILOT_MCP_ALLOW_REMOTE", description: "Set to 'true' to accept non-loopback MCP/bridge connections [default false]" },
  { name: "COPILOT_MCP_POLL_TIMEOUT_MS", description: "Long-poll hold time for browser sessions in ms [default 25000]" },
  { name: "COPILOT_MCP_DELIVERY_TIMEOUT_MS", description: "Max wait for a browser session to receive and acknowledge a command in ms; unacknowledged commands are withdrawn unexecuted [default 15000]" },
  { name: "COPILOT_MCP_RESULT_TIMEOUT_MS", description: "Max wait for an acknowledged command's result in ms [default 120000]" },
  { name: "COPILOT_MCP_LIVENESS_GRACE_MS", description: "A browser session with no open poll, no running command and no request for this long is closed, in ms [default 20000]" },
  { name: "COPILOT_MCP_MAX_SESSIONS_PER_USER", description: "Browser sessions kept per user [default 10]" },
];

function parseBool(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function parseIntInRange(value, fallback, min, max) {
  const n = Number.parseInt(String(value == null ? "" : value).trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadConfig(env = process.env) {
  const rootPath = typeof env.ROOT_PATH === "string" ? env.ROOT_PATH.replace(/\/+$/, "") : "";
  return {
    enabled: parseBool(env.WITH_COPILOT_MCP, false),
    allowRemote: parseBool(env.COPILOT_MCP_ALLOW_REMOTE, false),
    pollTimeoutMs: parseIntInRange(env.COPILOT_MCP_POLL_TIMEOUT_MS, 25000, 1000, 55000),
    deliveryTimeoutMs: parseIntInRange(env.COPILOT_MCP_DELIVERY_TIMEOUT_MS, 15000, 1000, 120000),
    resultTimeoutMs: parseIntInRange(env.COPILOT_MCP_RESULT_TIMEOUT_MS, 120000, 2000, 600000),
    livenessGraceMs: parseIntInRange(env.COPILOT_MCP_LIVENESS_GRACE_MS, 20000, 5000, 600000),
    maxSessionsPerUser: parseIntInRange(env.COPILOT_MCP_MAX_SESSIONS_PER_USER, 10, 1, 100),
    rootPath,
    basePath: "/api/copilot-mcp",
    port: parseIntInRange(env.PORT, 8888, 1, 65535),
    https: parseBool(env.HTTPS, false),
  };
}

module.exports = { ENVS, loadConfig, parseBool, parseIntInRange };
