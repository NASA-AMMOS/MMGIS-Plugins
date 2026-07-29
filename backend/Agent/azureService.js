"use strict";

/**
 * Azure AI Projects helpers (Foundry Agents via OpenAI-compatible Responses API).
 *
 * Migrated from the deprecated `@azure/ai-agents` threads/runs client to
 * `@azure/ai-projects` + `AIProjectClient.getOpenAIClient()`.
 *
 * Quick primer:
 *   1. Authenticate with `DefaultAzureCredential` (run `az login` beforehand).
 *   2. Point PROJECT_ENDPOINT at your Foundry project URL.
 *   3. Reference a published agent by AGENT_NAME + AGENT_VERSION.
 *   4. Conversations replace the old "threads"; we still expose `threadId`
 *      for compatibility with the Agent conversation store.
 */

const { AIProjectClient } = require("@azure/ai-projects");
const { DefaultAzureCredential } = require("@azure/identity");

let sharedProjectClient = null;
let sharedOpenAIClient = null;
let sharedEndpoint = "";

function createMissingEnvError(missing) {
  const missingList = Array.isArray(missing)
    ? missing.join(", ")
    : String(missing || "");
  const err = new Error(
    `Azure Agent Service environment is incomplete. Missing: ${missingList || "unknown values"}`,
  );
  err.code = "MissingAzureAgentEnv";
  err.missing = missing;
  return err;
}

function readEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

/**
 * Surface the minimum configuration the service needs.
 * PROJECT_ENDPOINT + AGENT_NAME + AGENT_VERSION.
 */
function haveFasEnv() {
  const endpoint = readEnv("PROJECT_ENDPOINT");
  const agentName = readEnv("AGENT_NAME");
  const agentVersion = readEnv("AGENT_VERSION");
  const missing = [];
  if (!endpoint) missing.push("PROJECT_ENDPOINT");
  if (!agentName) missing.push("AGENT_NAME");
  if (!agentVersion) missing.push("AGENT_VERSION");
  return {
    ok: missing.length === 0,
    missing,
    endpoint,
    agentName,
    agentVersion,
    apiVersion: "ai-projects",
  };
}

function getProjectClient(endpoint) {
  if (!sharedProjectClient || sharedEndpoint !== endpoint) {
    sharedProjectClient = new AIProjectClient(
      endpoint,
      new DefaultAzureCredential(),
    );
    sharedOpenAIClient = null;
    sharedEndpoint = endpoint;
  }
  return sharedProjectClient;
}

function getOpenAIClient(endpoint) {
  const project = getProjectClient(endpoint);
  if (!sharedOpenAIClient) {
    sharedOpenAIClient = project.getOpenAIClient();
  }
  return sharedOpenAIClient;
}

/** @deprecated Prefer getOpenAIClient — kept for callers that still import getClient. */
function getClient(endpoint) {
  return getOpenAIClient(endpoint);
}

function agentReferenceBody(cfg) {
  // Current Foundry Responses samples use top-level `agent_reference`
  // with required discriminator `type: "agent_reference"`.
  return {
    agent_reference: {
      name: cfg.agentName,
      version: cfg.agentVersion,
      type: "agent_reference",
    },
  };
}

function assistantMessageFromText(text) {
  const content = typeof text === "string" ? text : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: { value: content } }],
    text: content,
  };
}

function responseStatus(response) {
  return response?.status || response?.error?.code || "completed";
}

async function resolveConversation(openAIClient, conversationId, messageText) {
  if (conversationId) {
    try {
      await openAIClient.conversations.retrieve(conversationId);
      await openAIClient.conversations.items.create(conversationId, {
        items: [
          { type: "message", role: "user", content: messageText },
        ],
      });
      return { id: conversationId, reused: true };
    } catch (_) {
      // Conversation expired or deleted; create a new one with this message.
    }
  }

  const conversation = await openAIClient.conversations.create({
    items: [{ type: "message", role: "user", content: messageText }],
  });
  return { id: conversation.id, reused: false };
}

async function executeAgentRun(messageText, { threadId, keepThread } = {}) {
  const cfg = haveFasEnv();
  if (!cfg.ok) {
    throw createMissingEnvError(cfg.missing);
  }

  const openAIClient = getOpenAIClient(cfg.endpoint);
  let conversationId = null;
  let response = null;
  try {
    const conversation = await resolveConversation(
      openAIClient,
      threadId,
      messageText,
    );
    conversationId = conversation.id;

    response = await openAIClient.responses.create(
      { conversation: conversationId },
      { body: agentReferenceBody(cfg) },
    );

    const outputText =
      typeof response?.output_text === "string" ? response.output_text : "";
    const status = responseStatus(response);
    if (status && status !== "completed" && status !== "succeeded") {
      const failureReason =
        response?.error?.message ||
        response?.error?.code ||
        status ||
        "AgentRunFailed";
      const err = new Error(`Azure Agent Service run failed: ${failureReason}`);
      err.code = "AzureAgentRunFailed";
      err.run = response;
      throw err;
    }

    const assistant = assistantMessageFromText(outputText);
    return {
      run: {
        id: response?.id || null,
        status,
      },
      message: assistant,
      messages: [assistant],
      threadId: conversationId,
    };
  } catch (error) {
    if (response && !error.run) {
      error.run = response;
    }
    throw error;
  } finally {
    if (conversationId && !keepThread) {
      try {
        await openAIClient.conversations.delete(conversationId);
      } catch (_) {
        // Best-effort cleanup; stale conversations can be inspected in Azure.
      }
    }
  }
}

async function* executeAgentRunStreaming(
  messageText,
  { threadId, keepThread } = {},
) {
  const cfg = haveFasEnv();
  if (!cfg.ok) {
    throw createMissingEnvError(cfg.missing);
  }

  const openAIClient = getOpenAIClient(cfg.endpoint);
  let conversationId = null;
  try {
    const conversation = await resolveConversation(
      openAIClient,
      threadId,
      messageText,
    );
    conversationId = conversation.id;

    const stream = openAIClient.responses.stream(
      { conversation: conversationId },
      { body: agentReferenceBody(cfg) },
    );

    for await (const event of stream) {
      event._threadId = conversationId;
      yield event;
    }
  } finally {
    if (conversationId && !keepThread) {
      try {
        await openAIClient.conversations.delete(conversationId);
      } catch (_) {}
    }
  }
}

async function runAgentMessage(messageText, options = {}) {
  return executeAgentRun(messageText, options);
}

async function* streamAgentMessage(messageText, options = {}) {
  yield* executeAgentRunStreaming(messageText, options);
}

module.exports = {
  haveFasEnv,
  runAgentMessage,
  streamAgentMessage,
  getClient,
  getOpenAIClient,
  getProjectClient,
};
