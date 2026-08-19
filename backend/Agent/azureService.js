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
  // Current Foundry Responses endpoints require the agent_reference body
  // property. Some older SDK endpoint versions documented body.agent; the
  // narrowly matched fallback below handles that version skew.
  return {
    agent_reference: {
      name: cfg.agentName,
      version: cfg.agentVersion,
      type: "agent_reference",
    },
  };
}

function legacyAgentBody(cfg) {
  return {
    agent: {
      name: cfg.agentName,
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

/**
 * The `output_text` convenience getter is only populated when the response's
 * `output` array contains a `message` item with `output_text`/`text` content
 * parts. Foundry Agents can also finish a turn having only produced
 * `function_call`/`reasoning` output items (e.g. when the Agent has native
 * tool-calling configured directly in the Foundry portal), in which case
 * `output_text` is legitimately empty even though `status` is "completed".
 * Walk the structured `output` array ourselves so we don't silently drop
 * text that the convenience getter missed.
 */
function extractOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text) {
        parts.push(part.text);
      } else if (typeof part?.text?.value === "string" && part.text.value) {
        parts.push(part.text.value);
      }
    }
  }
  return parts.join("");
}

function boundedInstructions(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 80000)
    : undefined;
}

function boundedConversationMessage(value, fallback = "") {
  const preferred = typeof value === "string" && value.trim()
    ? value.trim()
    : String(fallback || "").trim();
  return preferred.slice(0, 80000);
}

function isPublishedAgentPayloadCompatibilityError(error) {
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status || 0,
  );
  const code = String(
    error?.code ||
      error?.providerCode ||
      error?.error?.code ||
      error?.response?.data?.error?.code ||
      "",
  ).toLowerCase();
  const message = String(
    error?.message ||
      error?.error?.message ||
      error?.response?.data?.error?.message ||
      "",
  );
  return (
    [400, 422].includes(status) &&
    (!code || code === "invalid_payload") &&
    /not allowed when agent is specified/i.test(message)
  );
}

function isAgentReferenceBodyCompatibilityError(error) {
  const status = Number(
    error?.status || error?.statusCode || error?.response?.status || 0,
  );
  const code = String(
    error?.code ||
      error?.providerCode ||
      error?.error?.code ||
      error?.response?.data?.error?.code ||
      "",
  ).toLowerCase();
  const message = String(
    error?.message ||
      error?.error?.message ||
      error?.response?.data?.error?.message ||
      "",
  );
  return (
    [400, 422].includes(status) &&
    (!code || code === "invalid_payload") &&
    /['\"]?agent_reference['\"]?\s+property\s+is\s+deprecated/i.test(
      message,
    ) &&
    /use\s+['\"]?agent['\"]?\s+instead/i.test(message)
  );
}

function minimalPublishedAgentPayload(payload = {}) {
  const minimal = { ...payload };
  delete minimal.instructions;
  delete minimal.tools;
  return minimal;
}

async function createPublishedAgentResponse(
  openAIClient,
  payload,
  cfg,
) {
  async function attempt(
    currentPayload,
    body,
    { mayStripOverrides, mayUseLegacyBody },
  ) {
    try {
      return await openAIClient.responses.create(
        currentPayload,
        { body },
      );
    } catch (error) {
      const hasForbiddenOverrides =
        Boolean(currentPayload?.instructions) ||
        (Array.isArray(currentPayload?.tools) &&
          currentPayload.tools.length > 0);
      if (
        mayStripOverrides &&
        hasForbiddenOverrides &&
        isPublishedAgentPayloadCompatibilityError(error)
      ) {
        return attempt(minimalPublishedAgentPayload(currentPayload), body, {
          mayStripOverrides: false,
          mayUseLegacyBody,
        });
      }
      if (
        mayUseLegacyBody &&
        isAgentReferenceBodyCompatibilityError(error)
      ) {
        return attempt(currentPayload, legacyAgentBody(cfg), {
          mayStripOverrides,
          mayUseLegacyBody: false,
        });
      }
      throw error;
    }
  }
  // Each compatibility branch is exact and one-shot. Rejected response
  // creation never appends another conversation item, so retries preserve one
  // logical user/tool-result turn.
  return attempt(payload, agentReferenceBody(cfg), {
    mayStripOverrides: true,
    mayUseLegacyBody: true,
  });
}

function parseFunctionCallArguments(value, name) {
  if (value == null || value === "") return {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    const err = new Error(
      `Azure function call '${name}' supplied non-JSON arguments.`,
    );
    err.code = "InvalidAgentFunctionCall";
    throw err;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("arguments must decode to an object");
    }
    return parsed;
  } catch (cause) {
    const err = new Error(
      `Azure function call '${name}' supplied malformed JSON arguments.`,
    );
    err.code = "InvalidAgentFunctionCall";
    err.cause = cause;
    throw err;
  }
}

function extractFunctionCalls(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const calls = [];
  for (const item of output) {
    if (item?.type !== "function_call") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const callId =
      (typeof item.call_id === "string" && item.call_id) ||
      (typeof item.callId === "string" && item.callId) ||
      "";
    if (!name || !callId) {
      const err = new Error(
        "Azure function call output is missing its name or call identifier.",
      );
      err.code = "InvalidAgentFunctionCall";
      throw err;
    }
    calls.push({
      tool: name,
      args: parseFunctionCallArguments(item.arguments, name),
      callId,
    });
  }
  return calls;
}

function assertSuccessfulResponse(response) {
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
  return status;
}

function normalizeAgentResponse(response, conversationId) {
  const outputText = extractOutputText(response);
  const actions = extractFunctionCalls(response);
  const status = assertSuccessfulResponse(response);
  if (!outputText && actions.length === 0) {
    const outputTypes = Array.isArray(response?.output)
      ? response.output.map((item) => item?.type).filter(Boolean)
      : [];
    const err = new Error(
      `Azure Agent Service completed without a message or function call (output types: ${outputTypes.join(", ") || "none"}).`,
    );
    err.code = "AzureAgentEmptyOutput";
    err.run = response;
    throw err;
  }

  const assistant = outputText ? assistantMessageFromText(outputText) : null;
  return {
    run: {
      id: response?.id || null,
      status,
    },
    responseId: response?.id || null,
    message: assistant,
    messages: assistant ? [assistant] : [],
    actions,
    threadId: conversationId || null,
  };
}

function buildFunctionCallOutputs(toolResults) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) {
    const err = new Error(
      "At least one tool result is required to continue an Azure response.",
    );
    err.code = "InvalidToolResults";
    throw err;
  }
  return toolResults.map((result, index) => {
    if (!result || typeof result !== "object" || !result.callId) {
      const err = new Error(
        `Tool result at index ${index} is missing its Azure callId.`,
      );
      err.code = "InvalidToolResults";
      throw err;
    }
    const output = {
      tool: result.tool,
      ok: result.ok === true,
      ...(result.message ? { message: result.message } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    return {
      type: "function_call_output",
      call_id: result.callId,
      output: JSON.stringify(output),
    };
  });
}

async function resolveConversation(
  openAIClient,
  conversationId,
  messageText,
  { appendMessage = true } = {},
) {
  if (conversationId) {
    try {
      await openAIClient.conversations.retrieve(conversationId);
      if (appendMessage) {
        await openAIClient.conversations.items.create(conversationId, {
          items: [
            { type: "message", role: "user", content: messageText },
          ],
        });
      }
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

async function executeAgentRun(
  messageText,
  {
    threadId,
    keepThread,
    instructions,
    tools,
    conversationMessage,
    messageAlreadyAdded = false,
  } = {},
) {
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
      boundedConversationMessage(conversationMessage, messageText),
      { appendMessage: !messageAlreadyAdded },
    );
    conversationId = conversation.id;

    response = await createPublishedAgentResponse(
      openAIClient,
      {
        conversation: conversationId,
        ...(boundedInstructions(instructions)
          ? { instructions: boundedInstructions(instructions) }
          : {}),
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      },
      cfg,
    );

    return normalizeAgentResponse(response, conversationId);
  } catch (error) {
    // Compatibility retries must reuse the conversation item already created
    // above. Otherwise the same user turn is appended twice.
    if (conversationId && !error._threadId) error._threadId = conversationId;
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

async function continueAgentRun(
  toolResults,
  { responseId, threadId, keepThread, instructions, tools } = {},
) {
  const cfg = haveFasEnv();
  if (!cfg.ok) throw createMissingEnvError(cfg.missing);
  if (typeof responseId !== "string" || !responseId.trim()) {
    const err = new Error(
      "An Azure responseId is required for native function-call continuation.",
    );
    err.code = "MissingPreviousResponseId";
    throw err;
  }

  const openAIClient = getOpenAIClient(cfg.endpoint);
  let response = null;
  try {
    response = await createPublishedAgentResponse(
      openAIClient,
      {
        previous_response_id: responseId.trim(),
        input: buildFunctionCallOutputs(toolResults),
        ...(boundedInstructions(instructions)
          ? { instructions: boundedInstructions(instructions) }
          : {}),
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      },
      cfg,
    );
    return normalizeAgentResponse(response, threadId || null);
  } catch (error) {
    if (response && !error.run) error.run = response;
    throw error;
  } finally {
    if (threadId && !keepThread) {
      try {
        await openAIClient.conversations.delete(threadId);
      } catch (_) {
        // Best-effort cleanup only.
      }
    }
  }
}

async function* executeAgentRunStreaming(
  messageText,
  {
    threadId,
    keepThread,
    instructions,
    tools,
    messageAlreadyAdded = false,
    conversationMessage,
  } = {},
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
      boundedConversationMessage(conversationMessage, messageText),
      { appendMessage: !messageAlreadyAdded },
    );
    conversationId = conversation.id;

    const stream = openAIClient.responses.stream(
      {
        conversation: conversationId,
        ...(boundedInstructions(instructions)
          ? { instructions: boundedInstructions(instructions) }
          : {}),
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
      },
      { body: agentReferenceBody(cfg) },
    );

    for await (const event of stream) {
      event._threadId = conversationId;
      yield event;
    }
  } catch (error) {
    // A request-tool compatibility retry must reuse the conversation without
    // appending the same user message a second time.
    if (conversationId && !error._threadId) error._threadId = conversationId;
    throw error;
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
  continueAgentRun,
  streamAgentMessage,
  getClient,
  getOpenAIClient,
  getProjectClient,
  extractOutputText,
  extractFunctionCalls,
  normalizeAgentResponse,
  buildFunctionCallOutputs,
  boundedInstructions,
  boundedConversationMessage,
  isPublishedAgentPayloadCompatibilityError,
  isAgentReferenceBodyCompatibilityError,
  minimalPublishedAgentPayload,
  createPublishedAgentResponse,
};
