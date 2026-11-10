// Request gating for the Copilot MCP routes: loopback-only by default,
// DNS-rebinding checks, the signed-in requirement, caller identity, and
// mission viewing permission through MMGIS's s.resolvers / s.can.

const { CopilotMcpError, ERROR_CODES } = require("./results");

function isLoopbackAddress(addr) {
  if (!addr) return false;
  const a = String(addr).trim().toLowerCase();
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

function hostnameOf(value) {
  if (!value) return "";
  const v = String(value).trim().toLowerCase();
  try {
    return new URL(v.includes("://") ? v : `http://${v}`).hostname.replace(/^\[|\]$/g, "");
  } catch (_) {
    return "";
  }
}

function isLocalHostname(name) {
  return name === "localhost" || name === "::1" || isLoopbackAddress(name);
}

function requestIsLocal(req) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) return false;
  const xff = req.headers["x-forwarded-for"];
  if (xff && !String(xff).split(",").every((part) => isLoopbackAddress(part))) return false;
  const host = hostnameOf(req.headers.host);
  if (host && !isLocalHostname(host)) return false;
  const origin = req.headers.origin;
  if (origin && origin !== "null" && !isLocalHostname(hostnameOf(origin))) return false;
  return true;
}

function jsonRpcErrorBody(req, code, message, data) {
  const id = req.body && typeof req.body === "object" && !Array.isArray(req.body) && req.body.id !== undefined ? req.body.id : null;
  return { jsonrpc: "2.0", error: { code, message, ...(data ? { data } : {}) }, id };
}

// Rejects non-local requests unless COPILOT_MCP_ALLOW_REMOTE=true.
function localOnly(cfg, { jsonRpc = false } = {}) {
  return (req, res, next) => {
    if (cfg.allowRemote || requestIsLocal(req)) return next();
    const message = "Copilot MCP only accepts connections from the local machine (set COPILOT_MCP_ALLOW_REMOTE=true to change this).";
    res.status(403);
    if (jsonRpc) return res.json(jsonRpcErrorBody(req, -32001, message));
    return res.json({ status: "failure", message });
  };
}

// MCP and bridge callers must be signed in (a session or a long-term token):
// browser sessions belong to an MMGIS user. Runs before s.authorize so that
// MCP clients get an HTTP 401 JSON-RPC error instead of a plain 403.
function requireSignedIn(s, { jsonRpc = false } = {}) {
  return (req, res, next) => {
    s.ensurePrincipal(req)
      .then((principal) => {
        if (principal && principal.authenticated) return next();
        const invalid = !!principal && principal.kind === "invalid_token";
        const message = invalid
          ? "The long-term token is invalid, expired or revoked."
          : 'Sign in to MMGIS or send "Authorization: Bearer <MMGIS long-term token>" (create one in Configure → API Tokens).';
        res.status(401);
        if (!jsonRpc) return res.json({ status: "failure", message });
        res.set("WWW-Authenticate", `Bearer realm="MMGIS"${invalid ? ', error="invalid_token"' : ""}`);
        return res.json(jsonRpcErrorBody(req, -32001, `MMGIS authentication failed. ${message}`));
      })
      .catch(next);
  };
}

function getCaller(req) {
  return {
    req,
    username: (req.principal && req.principal.username) || null,
    viaToken: !!(req.principal && req.principal.kind === "token"),
    httpSessionId: req.sessionID || null,
    headers: { authorization: req.headers.authorization, cookie: req.headers.cookie },
  };
}

// What a browser session can do on its caller's behalf. The page runs with
// the browser's own login, so an MCP caller may only drive it when the caller
// itself (for a long-term token: the token's scopes and mission limits) holds
// every capability the page uses: viewing the mission and reading its data.
const BROWSER_SESSION_CAPABILITIES = Object.freeze([
  "mission.view",
  "data.geodatasets.read",
  "data.datasets.read",
  "data.stac.read",
]);

// Mission permissions, decided by MMGIS's own permission API (s.resolvers,
// s.can, s.missionNamesWith) for the request's principal.
function createMissionAccess(s) {
  async function resourceFor(caller, mission) {
    if (typeof mission !== "string" || mission === "") return null;
    return s.resolvers.mission(() => mission)(caller.req);
  }

  async function holdsAll(caller, mission, capabilities) {
    const resource = await resourceFor(caller, mission);
    if (!resource) return false;
    for (const cap of capabilities) {
      if (!(await s.can(caller.req, cap, resource))) return false;
    }
    return true;
  }

  // Mission names the caller may view; null = every mission.
  function viewableMissions(caller) {
    return s.missionNamesWith(caller.req, "mission.view");
  }

  async function assertCanView(caller, mission) {
    if (!(await holdsAll(caller, mission, ["mission.view"]))) {
      throw new CopilotMcpError(ERROR_CODES.MISSION_FORBIDDEN, `Mission '${mission}' does not exist or this caller may not view it.`);
    }
  }

  async function assertCanDriveSession(caller, mission) {
    if (!(await holdsAll(caller, mission, BROWSER_SESSION_CAPABILITIES))) {
      throw new CopilotMcpError(
        ERROR_CODES.MISSION_FORBIDDEN,
        `This caller may not use browser sessions of mission '${mission}': it needs ${BROWSER_SESSION_CAPABILITIES.join(", ")} on that mission (check the long-term token's scopes and missions).`
      );
    }
  }

  return { viewableMissions, assertCanView, assertCanDriveSession };
}

module.exports = {
  isLoopbackAddress,
  requestIsLocal,
  localOnly,
  requireSignedIn,
  jsonRpcErrorBody,
  getCaller,
  BROWSER_SESSION_CAPABILITIES,
  createMissionAccess,
};
