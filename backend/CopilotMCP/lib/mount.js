// Mounts the Copilot MCP routes on the MMGIS app. Only called when
// WITH_COPILOT_MCP=true, so the MCP SDK is never loaded otherwise.
//
//   POST {ROOT_PATH}/api/copilot-mcp/mcp            Streamable HTTP MCP endpoint
//   GET  {ROOT_PATH}/api/copilot-mcp/status          bridge discovery for the browser
//   *    {ROOT_PATH}/api/copilot-mcp/bridge/...      browser session bridge
//
// All routes are loopback-only unless COPILOT_MCP_ALLOW_REMOTE=true and use
// MMGIS's own ensureUser()/stopGuests gates (logged-in users or long-term
// tokens, exactly like the Copilot's /api/agent routes).

const { BrowserSessionRegistry } = require("./sessions");
const { createLoopback } = require("./loopback");
const { createCatalog } = require("./catalog");
const { localOnly, jsonRpcGate, createMissionAccess } = require("./access");
const { createMcpRouter } = require("../routes/mcp");
const { createBridgeRouter } = require("../routes/bridge");

const PLUGIN_VERSION = require("../plugin.json").version;

function mountCopilotMcp(s, cfg, log = () => {}) {
  const sessions = new BrowserSessionRegistry(cfg);
  const loopback = createLoopback(cfg);
  const missionAccess = createMissionAccess(loopback);
  const catalog = createCatalog({ app: s.app, cfg, sessions, loopback, missionAccess });
  const base = `${s.ROOT_PATH || ""}${cfg.basePath}`;

  s.app.use(
    `${base}/mcp`,
    localOnly(cfg, { jsonRpc: true }),
    s.checkHeadersCodeInjection,
    jsonRpcGate(s.ensureUser()),
    jsonRpcGate(s.stopGuests),
    createMcpRouter({ catalog, log })
  );

  s.app.get(`${base}/status`, localOnly(cfg), s.checkHeadersCodeInjection, s.ensureUser(), s.setContentType, (req, res) => {
    const user = typeof req.user === "string" ? req.user : null;
    res.json({
      status: "success",
      enabled: true,
      version: PLUGIN_VERSION,
      loggedIn: !!user && user !== "guest",
      user,
      pollTimeoutMs: cfg.pollTimeoutMs,
    });
  });

  s.app.use(
    `${base}/bridge`,
    localOnly(cfg),
    s.checkHeadersCodeInjection,
    s.ensureUser(),
    s.stopGuests,
    s.setContentType,
    createBridgeRouter({ cfg, sessions, missionAccess })
  );

  return {
    catalog,
    sessions,
    start: () => sessions.start(),
    stop: () => sessions.stop(),
  };
}

module.exports = { mountCopilotMcp };
