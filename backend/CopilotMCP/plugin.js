// Copilot MCP backend plugin lifecycle. Disabled unless WITH_COPILOT_MCP=true:
// when disabled nothing is mounted and the MCP SDK is not loaded, so the
// Copilot, its APIs and every other plugin behave exactly as without it.

const path = require("path");
const { ENVS, loadConfig } = require("./lib/config");

let logger = null;
try {
  logger = require(path.join(process.cwd(), "API/logger"));
} catch (_) {
  logger = null;
}

function log(level, message) {
  if (logger) logger(level, message, "CopilotMCP");
  else console.log(`[CopilotMCP] ${level}: ${message}`);
}

const cfg = loadConfig(process.env);
const envs = ENVS.map((e) => ({ name: e.name, required: false }));

let mounted = null;

module.exports = cfg.enabled
  ? {
      envs,
      onceInit: (s) => {
        try {
          mounted = require("./lib/mount").mountCopilotMcp(s, cfg, log);
          log(
            "info",
            `Copilot MCP enabled at ${s.ROOT_PATH || ""}${cfg.basePath}/mcp (${cfg.allowRemote ? "remote connections allowed" : "local connections only"}).`
          );
        } catch (err) {
          log(
            "error",
            `Copilot MCP could not be mounted: ${err && err.message}. Install its plugin-local dependencies with "npm ci --omit=dev" in ${__dirname}.`
          );
        }
      },
      onceStarted: () => {
        if (mounted) mounted.start();
      },
    }
  : (log("info", "Copilot MCP disabled (WITH_COPILOT_MCP != true). No routes mounted."), { envs });
