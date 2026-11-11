// Browser bridge used by the CopilotMCPBridge component: a logged-in MMGIS
// page registers a session for its mission, long-polls for commands,
// acknowledges the ones it received (it runs only acknowledged commands) and
// posts back what it executed. Every request must come from the session's own
// login (same MMGIS user and Express session) and carry the session secret.
//
// Permissions (s.authorize): /status needs site.view; /bridge/register needs
// mission.view on the mission it registers; the other bridge routes need
// mission.view on the mission of the session they name.

const express = require("express");
const { CopilotMcpError, ERROR_CODES, sanitize } = require("../lib/results");
const { getCaller, requireSignedIn } = require("../lib/access");

const SECRET_HEADER = "x-copilot-mcp-secret";
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

function statusFor(err) {
  switch (err && err.code) {
    case ERROR_CODES.SESSION_NOT_FOUND:
      return 404;
    case ERROR_CODES.SESSION_FORBIDDEN:
    case ERROR_CODES.MISSION_FORBIDDEN:
      return 403;
    case ERROR_CODES.INVALID_INPUT:
    case ERROR_CODES.PAYLOAD_TOO_LARGE:
      return 400;
    default:
      return 500;
  }
}

function sendError(res, err) {
  const code = err instanceof CopilotMcpError ? err.code : ERROR_CODES.EXECUTION_FAILED;
  res.status(statusFor(err)).json({ status: "failure", code, message: (err && err.message) || "Bridge error" });
}

const PLUGIN_VERSION = require("../plugin.json").version;

function createBridgeRouter({ s, cfg, sessions }) {
  const router = express.Router();
  const { authorize, resolvers } = s;
  const signedIn = requireSignedIn(s);

  // The mission of the browser session a bridge request names; null (403)
  // when there is no such session. The secret is checked in the handler.
  const sessionIdOf = (req) => (req.method === "GET" ? req.query.session_id : req.body && req.body.session_id);
  const sessionMission = async (req) => {
    const mission = sessions.missionOf(sessionIdOf(req));
    return mission ? resolvers.mission(() => mission)(req) : null;
  };
  sessionMission.description = "mission of the named browser session";
  const viewSessionMission = authorize("mission.view", sessionMission);

  router.get("/status", authorize("site.view"), (req, res) => {
    const caller = getCaller(req);
    res.json({
      status: "success",
      enabled: true,
      version: PLUGIN_VERSION,
      loggedIn: !!(req.principal && req.principal.authenticated),
      user: caller.username,
      pollTimeoutMs: cfg.pollTimeoutMs,
    });
  });

  function authenticate(req) {
    const caller = getCaller(req);
    return sessions.authenticate(sessionIdOf(req) || "", req.get(SECRET_HEADER), { owner: caller.username, httpSessionId: caller.httpSessionId });
  }

  const missionFromBody = (req) => (req.body && typeof req.body.mission === "string" ? req.body.mission.trim() : "");
  router.post("/bridge/register", signedIn, authorize("mission.view", resolvers.mission(missionFromBody)), async (req, res) => {
    try {
      const caller = getCaller(req);
      const mission = missionFromBody(req);
      if (!mission || mission.length > 256) throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, "A mission name is required.");
      const { session, secret } = sessions.register({
        owner: caller.username,
        mission,
        httpSessionId: caller.httpSessionId,
        page: (req.body && req.body.page) || {},
        client: (req.body && req.body.client) || {},
      });
      res.json({
        status: "success",
        session: { id: session.id, secret, mission: session.mission, user: session.owner, pollTimeoutMs: cfg.pollTimeoutMs },
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/bridge/poll", signedIn, viewSessionMission, async (req, res) => {
    let session;
    try {
      session = authenticate(req);
    } catch (err) {
      return sendError(res, err);
    }
    const aborter = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) aborter.abort();
    });
    const commands = await sessions.poll(session, cfg.pollTimeoutMs, aborter.signal);
    if (aborter.signal.aborted || res.destroyed) {
      sessions.requeue(session, commands);
      return;
    }
    res.json({ status: "success", commands });
  });

  router.post("/bridge/ack", signedIn, viewSessionMission, (req, res) => {
    try {
      const session = authenticate(req);
      const ids = req.body && Array.isArray(req.body.command_ids) ? req.body.command_ids : [];
      res.json({ status: "success", accepted: sessions.acknowledge(session, ids) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/bridge/result", signedIn, viewSessionMission, (req, res) => {
    try {
      const session = authenticate(req);
      const body = req.body || {};
      const raw = JSON.stringify(body.payload || {});
      if (raw.length > MAX_RESULT_BYTES) {
        const outcome = sessions.complete(session, body.command_id, {
          ok: false,
          status: "failed",
          error: { code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: `The browser result was ${raw.length} bytes (limit ${MAX_RESULT_BYTES}).` },
        });
        return res.json({ status: "success", ...outcome });
      }
      const outcome = sessions.complete(session, body.command_id, sanitize(body.payload || {}));
      res.json({ status: "success", ...outcome });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post("/bridge/unregister", signedIn, viewSessionMission, (req, res) => {
    try {
      const session = authenticate(req);
      sessions.unregister(session, "browser_closed");
      res.json({ status: "success" });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

module.exports = { createBridgeRouter, SECRET_HEADER };
