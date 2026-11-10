// Mounts the Copilot MCP routes on the MMGIS app. Only called when
// WITH_COPILOT_MCP=true, so the MCP SDK is never loaded otherwise.
//
//   POST {ROOT_PATH}/api/copilot-mcp/mcp            Streamable HTTP MCP endpoint
//   GET  {ROOT_PATH}/api/copilot-mcp/status          bridge discovery for the browser
//   *    {ROOT_PATH}/api/copilot-mcp/bridge/...      browser session bridge
//
// All routes are loopback-only unless COPILOT_MCP_ALLOW_REMOTE=true. Every
// route declares its permission with s.authorize (see each router), so
// long-term token scopes and mission limits apply and the routes appear in
// MMGIS's permissions table.

const { BrowserSessionRegistry } = require("./sessions");
const { createLoopback } = require("./loopback");
const { createCatalog } = require("./catalog");
const { localOnly, createMissionAccess } = require("./access");
const { createMcpRouter } = require("../routes/mcp");
const { createBridgeRouter } = require("../routes/bridge");

function mountCopilotMcp(s, cfg, log = () => {}) {
  const sessions = new BrowserSessionRegistry(cfg);
  const loopback = createLoopback(cfg);
  const missionAccess = createMissionAccess(s);
  const catalog = createCatalog({ app: s.app, cfg, sessions, loopback, missionAccess });
  const base = `${s.ROOT_PATH || ""}${cfg.basePath}`;

  s.app.use(
    `${base}/mcp`,
    localOnly(cfg, { jsonRpc: true }),
    s.checkHeadersCodeInjection,
    s.registerRouter(`${base}/mcp`, createMcpRouter({ s, catalog, log }))
  );

  s.app.use(
    base,
    localOnly(cfg),
    s.checkHeadersCodeInjection,
    s.setContentType,
    s.registerRouter(base, createBridgeRouter({ s, cfg, sessions, missionAccess }))
  );

  return {
    catalog,
    sessions,
    start: () => sessions.start(),
    stop: () => sessions.stop(),
  };
}

module.exports = { mountCopilotMcp };
