// Request gating for the Copilot MCP routes: loopback-only by default,
// DNS-rebinding checks, JSON-RPC-friendly wrappers around MMGIS's own auth
// middleware, caller identity, and mission viewing permission (delegated to
// MMGIS's /api/configure/missions, which applies core's permission rules).

const crypto = require("crypto");
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

// Runs an MMGIS auth middleware (ensureUser, stopGuests, …). Those gates
// answer with HTTP 200 + { status: "failure" } or render a login page; MCP
// clients need a JSON-RPC error with HTTP 401 instead.
function jsonRpcGate(middleware) {
  return (req, res, next) => {
    const original = { send: res.send, render: res.render, end: res.end };
    let settled = false;
    const restore = () => {
      res.send = original.send;
      res.render = original.render;
      res.end = original.end;
    };
    const fail = (detail) => {
      if (settled) return res;
      settled = true;
      restore();
      res.status(401);
      res.set("WWW-Authenticate", 'Bearer realm="MMGIS", error="invalid_token"');
      res.json(
        jsonRpcErrorBody(
          req,
          -32001,
          `MMGIS authentication failed${detail ? `: ${detail}` : ""}. Send "Authorization: Bearer <MMGIS long-term token>" (create one in Configure → API Tokens).`
        )
      );
      res.send = () => res;
      res.render = () => res;
      res.end = () => res;
      return res;
    };
    res.send = (body) => {
      let detail = "";
      if (body && typeof body === "object" && body.message) detail = body.message;
      else if (typeof body === "string") {
        try {
          detail = JSON.parse(body).message || "";
        } catch (_) {
          detail = "";
        }
      }
      return fail(detail);
    };
    res.render = () => fail("login required");
    try {
      middleware(req, res, (err) => {
        if (settled) return;
        settled = true;
        restore();
        next(err);
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        restore();
        next(err);
      }
    }
  };
}

function getCaller(req) {
  return {
    username: typeof req.user === "string" ? req.user : null,
    viaToken: !!req.isLongTermToken,
    httpSessionId: req.sessionID || null,
    headers: { authorization: req.headers.authorization, cookie: req.headers.cookie },
  };
}

// Mission viewing permission, decided by MMGIS itself for this caller.
function createMissionAccess(loopback, { ttlMs = 30000 } = {}) {
  const cache = new Map();
  const keyFor = (caller) =>
    crypto
      .createHash("sha256")
      .update(`${caller.username}|${caller.headers.authorization || ""}|${caller.headers.cookie || ""}`)
      .digest("hex");

  async function viewableMissions(caller) {
    const key = keyFor(caller);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.missions;
    const res = await loopback.request("GET", "/api/configure/missions", { caller });
    const body = loopback.unwrap(res, "Mission list");
    const missions = Array.isArray(body && body.missions) ? body.missions : [];
    cache.set(key, { at: Date.now(), missions });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return missions;
  }

  async function assertCanView(caller, mission) {
    const missions = await viewableMissions(caller);
    if (!missions.includes(mission)) {
      throw new CopilotMcpError(ERROR_CODES.MISSION_FORBIDDEN, `Mission '${mission}' does not exist or this user may not view it.`);
    }
  }

  return { viewableMissions, assertCanView };
}

module.exports = {
  isLoopbackAddress,
  requestIsLocal,
  localOnly,
  jsonRpcGate,
  jsonRpcErrorBody,
  getCaller,
  createMissionAccess,
};
