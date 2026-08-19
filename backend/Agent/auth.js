"use strict";

const AGENT_AUTH_OPTIONS = Object.freeze({
  code: "AgentAuthenticationRequired",
  message: "Sign in to use MMGIS Copilot.",
  unavailableCode: "AgentAuthenticationUnavailable",
  unavailableMessage: "MMGIS authentication is temporarily unavailable.",
});

function getAgentAuthMiddleware(server) {
  if (!server || typeof server.ensureUserForApi !== "function") {
    throw new TypeError(
      "Agent routes require the MMGIS ensureUserForApi middleware.",
    );
  }
  return server.ensureUserForApi(AGENT_AUTH_OPTIONS);
}

module.exports = {
  AGENT_AUTH_OPTIONS,
  getAgentAuthMiddleware,
};
