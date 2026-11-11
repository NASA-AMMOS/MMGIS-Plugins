// In-memory registry of live MMGIS browser sessions connected through the
// CopilotMCPBridge component. Each session belongs to one MMGIS user and one
// mission. MCP calls are queued per session and handed to the page over
// long-poll. The page acknowledges the commands it received and executes only
// acknowledged ones, so the registry always knows whether a command can have
// run. A call resolves only when the page reports the executed result.

const crypto = require("crypto");
const { CopilotMcpError, ERROR_CODES } = require("./results");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function safeEqual(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function unref(timer) {
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

class BrowserSessionRegistry {
  constructor(options = {}) {
    // A live page always has a poll open, is executing a command, or polls
    // again right after a poll ends. A page silent for longer than this (tab
    // closed or crashed, offline, or a proxy hid the disconnect) is closed.
    this.livenessGraceMs = options.livenessGraceMs || 20000;
    this.maxSessionsPerUser = options.maxSessionsPerUser || 10;
    this.now = options.now || (() => Date.now());
    this.sessions = new Map();
    this.sweepTimer = null;
  }

  start(intervalMs = 5000) {
    if (this.sweepTimer) return;
    this.sweepTimer = unref(setInterval(() => this.sweep(), intervalMs));
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const session of [...this.sessions.values()]) this.unregister(session, "server_stopped");
  }

  register({ owner, mission, httpSessionId = null, page = {}, client = {} }) {
    if (!owner || typeof owner !== "string") throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, "A logged-in MMGIS user is required.");
    if (!mission || typeof mission !== "string") throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, "A mission is required.");
    const owned = [...this.sessions.values()]
      .filter((s) => s.owner === owner)
      .sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    while (owned.length >= this.maxSessionsPerUser) this.unregister(owned.shift(), "replaced");

    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString("hex");
    const now = this.now();
    const session = {
      id,
      secretHash: sha256(secret),
      owner,
      mission,
      httpSessionId,
      page: {
        title: typeof page.title === "string" ? page.title.slice(0, 200) : "",
        href: typeof page.href === "string" ? page.href.slice(0, 500) : "",
      },
      client: { version: typeof client.version === "string" ? client.version.slice(0, 40) : "" },
      createdAt: now,
      lastSeenAt: now,
      queue: [],
      waiter: null,
      pending: new Map(),
      settled: new Map(),
      executed: 0,
    };
    this.sessions.set(id, session);
    return { session, secret };
  }

  // Verifies a bridge request belongs to the session: matching secret, the same
  // MMGIS user and (when bound) the same Express session.
  authenticate(id, secret, { owner, httpSessionId = null } = {}) {
    const session = this.sessions.get(String(id || ""));
    if (!session || typeof secret !== "string" || !safeEqual(session.secretHash, sha256(secret))) {
      throw new CopilotMcpError(ERROR_CODES.SESSION_NOT_FOUND, "Unknown or expired browser session.");
    }
    if (session.owner !== owner || (session.httpSessionId && httpSessionId && session.httpSessionId !== httpSessionId)) {
      throw new CopilotMcpError(ERROR_CODES.SESSION_FORBIDDEN, "This browser session belongs to a different login.");
    }
    session.lastSeenAt = this.now();
    return session;
  }

  // Long-poll: resolves with commands to run, or [] after timeoutMs or when
  // `signal` aborts (the HTTP connection closed).
  poll(session, timeoutMs, signal = null) {
    session.lastSeenAt = this.now();
    if (session.waiter) this.releaseWaiter(session, []);
    // The page acknowledges what it receives before it polls again, so
    // commands handed to an earlier poll and never acknowledged were lost.
    this.requeue(session, this.unacknowledged(session));
    if (session.queue.length) return Promise.resolve(this.handOut(session));
    return new Promise((resolve) => {
      const timer = unref(
        setTimeout(() => {
          if (session.waiter && session.waiter.resolve === resolve) this.releaseWaiter(session, []);
        }, timeoutMs)
      );
      session.waiter = { resolve, timer };
      if (signal) {
        const onAbort = () => {
          if (session.waiter && session.waiter.resolve === resolve) this.releaseWaiter(session, []);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  releaseWaiter(session, commands) {
    const waiter = session.waiter;
    if (!waiter) return;
    session.waiter = null;
    session.lastSeenAt = this.now();
    clearTimeout(waiter.timer);
    waiter.resolve(commands);
  }

  handOut(session) {
    const commands = session.queue.splice(0, session.queue.length);
    for (const command of commands) {
      const pending = session.pending.get(command.id);
      if (pending) pending.handedOut = true;
    }
    return commands;
  }

  unacknowledged(session) {
    return [...session.pending.values()].filter((p) => p.handedOut && !p.acknowledged).map((p) => p.command);
  }

  // The page confirms which handed-out commands it received. It executes only
  // the ids returned here; withdrawn or unknown ids are not returned.
  acknowledge(session, ids) {
    session.lastSeenAt = this.now();
    const accepted = [];
    for (const id of Array.isArray(ids) ? ids.slice(0, 100) : []) {
      const pending = session.pending.get(String(id));
      if (!pending || !pending.handedOut || pending.acknowledged) continue;
      pending.onAcknowledged(this.now());
      accepted.push(pending.command.id);
    }
    return accepted;
  }

  // Queues a command for the page and resolves with the page's result.
  // Rejects with NOT_DELIVERED (nothing ran) or RESULT_TIMEOUT (outcome unknown).
  dispatch(session, command, { deliveryTimeoutMs = 15000, resultTimeoutMs = 120000 } = {}) {
    if (!this.sessions.has(session.id)) {
      return Promise.reject(new CopilotMcpError(ERROR_CODES.SESSION_CLOSED, "The browser session is no longer connected."));
    }
    const entry = { ...command, id: command.id || crypto.randomUUID() };
    const label = entry.tool || entry.kind;
    const issuedAt = this.now();
    return new Promise((resolve, reject) => {
      const pending = {
        command: entry,
        handedOut: false,
        acknowledged: false,
        acknowledgedAt: null,
        timer: null,
        resolve: (payload) => {
          clearTimeout(pending.timer);
          session.pending.delete(entry.id);
          resolve({ ...payload, commandId: entry.id, deliveredAt: pending.acknowledgedAt });
        },
        reject: (err) => {
          clearTimeout(pending.timer);
          session.pending.delete(entry.id);
          reject(err);
        },
        onAcknowledged: (at) => {
          pending.acknowledged = true;
          pending.acknowledgedAt = at;
          clearTimeout(pending.timer);
          pending.timer = unref(
            setTimeout(() => {
              session.settled.set(entry.id, "timed_out");
              pending.reject(
                new CopilotMcpError(
                  ERROR_CODES.RESULT_TIMEOUT,
                  `The browser received '${label}' but did not report a result within ${resultTimeoutMs} ms; its outcome is unknown.`,
                  { delivered: true, commandId: entry.id }
                )
              );
            }, resultTimeoutMs)
          );
        },
      };
      const armDeliveryTimer = () => {
        pending.timer = unref(
          setTimeout(() => {
            if (pending.acknowledged) return;
            // A page still executing an earlier command picks this one up next.
            if (this.sessions.has(session.id) && this.isBusy(session) && this.now() - issuedAt < resultTimeoutMs) {
              armDeliveryTimer();
              return;
            }
            const idx = session.queue.findIndex((c) => c.id === entry.id);
            if (idx >= 0) session.queue.splice(idx, 1);
            pending.reject(
              new CopilotMcpError(
                ERROR_CODES.NOT_DELIVERED,
                `The browser session did not receive '${label}' within ${deliveryTimeoutMs} ms; it was withdrawn and nothing was executed.`,
                { delivered: false, commandId: entry.id }
              )
            );
          }, deliveryTimeoutMs)
        );
      };
      armDeliveryTimer();
      session.pending.set(entry.id, pending);
      session.queue.push(entry);
      if (session.waiter) this.releaseWaiter(session, this.handOut(session));
    });
  }

  // Puts unacknowledged commands back at the front of the queue.
  requeue(session, commands) {
    for (const command of [...commands].reverse()) {
      const pending = session.pending.get(command.id);
      if (!pending || pending.acknowledged) continue;
      pending.handedOut = false;
      if (!session.queue.some((c) => c.id === command.id)) session.queue.unshift(command);
    }
  }

  // Records a page-reported result. Late or unknown results are ignored.
  complete(session, commandId, payload) {
    session.lastSeenAt = this.now();
    const pending = session.pending.get(String(commandId || ""));
    if (!pending || !pending.acknowledged) {
      const state = session.settled.get(String(commandId || ""));
      return { accepted: false, reason: state === "timed_out" ? "late" : "unknown_command" };
    }
    session.executed += 1;
    session.settled.set(pending.command.id, "completed");
    if (session.settled.size > 200) session.settled.delete(session.settled.keys().next().value);
    pending.resolve(payload || {});
    return { accepted: true };
  }

  unregister(session, reason = "closed") {
    if (!this.sessions.has(session.id)) return;
    this.sessions.delete(session.id);
    this.releaseWaiter(session, []);
    session.queue.splice(0, session.queue.length);
    for (const pending of [...session.pending.values()]) {
      pending.reject(
        new CopilotMcpError(
          ERROR_CODES.SESSION_CLOSED,
          `The browser session closed (${reason}) before '${pending.command.tool || pending.command.kind}' completed${pending.acknowledged ? "; its outcome is unknown" : "; nothing was executed"}.`,
          { delivered: pending.acknowledged, commandId: pending.command.id }
        )
      );
    }
  }

  // True while the page is executing a command it acknowledged.
  isBusy(session) {
    for (const pending of session.pending.values()) if (pending.acknowledged) return true;
    return false;
  }

  isConnected(session) {
    if (session.waiter || this.isBusy(session)) return true;
    return this.now() - session.lastSeenAt < this.livenessGraceMs;
  }

  sweep() {
    for (const session of [...this.sessions.values()]) {
      if (!this.isConnected(session)) this.unregister(session, "connection_lost");
    }
  }

  describe(session) {
    return {
      session_id: session.id,
      mission: session.mission,
      page_title: session.page.title,
      connected: this.isConnected(session),
      busy: this.isBusy(session),
      last_seen: new Date(session.lastSeenAt).toISOString(),
      created: new Date(session.createdAt).toISOString(),
      pending_commands: session.pending.size,
      executed_commands: session.executed,
    };
  }

  // Mission of a registered session, or null. The bridge routes use it for
  // their permission check, before the session secret is verified.
  missionOf(id) {
    const session = this.sessions.get(String(id || ""));
    return session ? session.mission : null;
  }

  list({ owner, mission = null } = {}) {
    return [...this.sessions.values()]
      .filter((s) => s.owner === owner && (!mission || s.mission === mission))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((s) => this.describe(s));
  }

  // Chooses the browser session an MCP call targets. Sessions of other users
  // are reported as not found so their existence is not disclosed.
  select({ owner, mission = null, sessionId = null } = {}) {
    if (sessionId) {
      const session = this.sessions.get(String(sessionId));
      if (!session || session.owner !== owner) {
        throw new CopilotMcpError(ERROR_CODES.SESSION_NOT_FOUND, `No browser session '${sessionId}' is connected for this user.`);
      }
      if (mission && session.mission !== mission) {
        throw new CopilotMcpError(
          ERROR_CODES.MISSION_MISMATCH,
          `Browser session '${sessionId}' shows mission '${session.mission}', not '${mission}'.`,
          { session_mission: session.mission }
        );
      }
      if (!this.isConnected(session)) {
        throw new CopilotMcpError(ERROR_CODES.SESSION_CLOSED, `Browser session '${sessionId}' is no longer connected.`);
      }
      return session;
    }
    const candidates = [...this.sessions.values()].filter(
      (s) => s.owner === owner && this.isConnected(s) && (!mission || s.mission === mission)
    );
    if (!candidates.length) {
      throw new CopilotMcpError(
        ERROR_CODES.NO_BROWSER_SESSION,
        mission
          ? `No MMGIS browser session for mission '${mission}' is connected for this user. Open the mission in a browser with the CopilotMCPBridge component enabled and log in.`
          : "No MMGIS browser session is connected for this user. Open a mission in a browser with the CopilotMCPBridge component enabled and log in.",
        { sessions: this.list({ owner }) }
      );
    }
    if (candidates.length > 1) {
      throw new CopilotMcpError(
        ERROR_CODES.AMBIGUOUS_BROWSER_SESSION,
        "More than one MMGIS browser session matches; pass session_id (see mmgis_list_sessions).",
        { sessions: candidates.map((s) => this.describe(s)) }
      );
    }
    return candidates[0];
  }
}

module.exports = { BrowserSessionRegistry };
