"use strict";

const crypto = require("crypto");

const MAX_RUNTIME_CONVERSATIONS = 500;
const RUNTIME_CONVERSATION_TTL_MS = 60 * 60 * 1000;
const store = new Map();

function requestIdentity(req) {
  const user =
    (typeof req?.user === "string" && req.user) ||
    (typeof req?.session?.user === "string" && req.session.user) ||
    "anonymous";
  const session =
    (typeof req?.sessionID === "string" && req.sessionID) ||
    (typeof req?.session?.id === "string" && req.session.id) ||
    "";
  return `${user}|${session}`.slice(0, 300);
}

function prune(now = Date.now()) {
  for (const [id, state] of store) {
    if (now - state.updatedAt > RUNTIME_CONVERSATION_TTL_MS) {
      store.delete(id);
    }
  }
  while (store.size > MAX_RUNTIME_CONVERSATIONS) {
    store.delete(store.keys().next().value);
  }
}

function beginRuntimeConversation({
  conversationId,
  owner,
  mission,
  azureThreadId = null,
  messages = [],
}) {
  prune();
  const state = {
    conversationId,
    owner,
    mission,
    azureThreadId,
    messages: Array.isArray(messages) ? messages : [],
    continuationCount: 0,
    pending: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  store.set(conversationId, state);
  prune();
  return state;
}

function getRuntimeConversation(conversationId, owner, mission) {
  prune();
  const state = store.get(conversationId);
  if (!state || state.owner !== owner || state.mission !== mission) return null;
  state.updatedAt = Date.now();
  return state;
}

function listRuntimeConversations(owner, mission) {
  prune();
  return Array.from(store.values())
    .filter((state) => state.owner === owner && state.mission === mission)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50);
}

function deleteRuntimeConversation(conversationId, owner, mission) {
  const state = getRuntimeConversation(conversationId, owner, mission);
  if (!state) return null;
  store.delete(conversationId);
  return state;
}

function setPendingActions(state, actions, responseId) {
  if (!state) return;
  state.pending =
    Array.isArray(actions) && actions.length
      ? {
          responseId: responseId || null,
          actions: actions.map((action) => ({
            tool: action.tool,
            callId: action.callId || null,
          })),
          inFlight: null,
        }
      : null;
  state.updatedAt = Date.now();
}

function mismatch(message, code = "ToolResultMismatch") {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  return error;
}

function claimPendingActions(state, toolResults, responseId) {
  const pending = state?.pending;
  if (!pending || !Array.isArray(pending.actions) || !pending.actions.length) {
    throw mismatch(
      "This Copilot turn has no pending actions, or its results were already submitted.",
      "ContinuationAlreadyConsumed",
    );
  }
  if (pending.inFlight) {
    throw mismatch(
      "This Copilot continuation is already being processed.",
      "ContinuationInProgress",
    );
  }
  if (pending.actions.length !== toolResults.length) {
    throw mismatch("Tool results do not match the pending Copilot actions.");
  }
  const native = pending.actions.every((action) => action.callId);
  if (native) {
    if (!responseId || responseId !== pending.responseId) {
      throw mismatch("responseId does not match the pending Copilot response.");
    }
    const expected = new Map(
      pending.actions.map((action) => [action.callId, action.tool]),
    );
    for (const result of toolResults) {
      if (!result.callId || expected.get(result.callId) !== result.tool) {
        throw mismatch(
          "A tool result callId or capability does not match the pending action.",
        );
      }
      expected.delete(result.callId);
    }
    if (expected.size) throw mismatch("One or more pending callIds are missing.");
  } else {
    if (toolResults.some((result) => result.callId)) {
      throw mismatch(
        "Prompt-planned actions must not include Azure callId values.",
      );
    }
    const expected = pending.actions.map((action) => action.tool).sort();
    const actual = toolResults.map((result) => result.tool).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw mismatch("Tool result capabilities do not match the pending actions.");
    }
  }
  const claim = crypto.randomBytes(12).toString("hex");
  pending.inFlight = claim;
  state.updatedAt = Date.now();
  return claim;
}

function completePendingClaim(state, claim, actions, responseId) {
  if (!state?.pending || state.pending.inFlight !== claim) {
    throw mismatch("Copilot continuation state changed before completion.");
  }
  state.continuationCount += 1;
  setPendingActions(state, actions, responseId);
}

function releasePendingClaim(state, claim) {
  if (state?.pending?.inFlight === claim) {
    state.pending.inFlight = null;
    state.updatedAt = Date.now();
  }
}

async function bestEffortCreateConversation(Model, values, onError = () => {}) {
  try {
    return await Model.create(values);
  } catch (error) {
    onError(error);
    return null;
  }
}

module.exports = {
  MAX_RUNTIME_CONVERSATIONS,
  requestIdentity,
  beginRuntimeConversation,
  getRuntimeConversation,
  listRuntimeConversations,
  deleteRuntimeConversation,
  setPendingActions,
  claimPendingActions,
  completePendingClaim,
  releasePendingClaim,
  bestEffortCreateConversation,
  _runtimeStore: store,
};
