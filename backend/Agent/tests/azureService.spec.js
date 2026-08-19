import { test, expect } from "@playwright/test";
import {
  extractFunctionCalls,
  normalizeAgentResponse,
  buildFunctionCallOutputs,
  isPublishedAgentPayloadCompatibilityError,
  isAgentReferenceBodyCompatibilityError,
  createPublishedAgentResponse,
} from "../azureService";

test.describe("@unit Azure Responses structured output", () => {
  test("parses native function_call items and preserves call correlation", () => {
    const calls = extractFunctionCalls({
      output: [
        {
          type: "reasoning",
          summary: [],
        },
        {
          type: "function_call",
          name: "zoom_to",
          arguments: '{"center":[-146,72],"zoom":3}',
          call_id: "call_beaufort",
        },
      ],
    });
    expect(calls).toEqual([
      {
        tool: "zoom_to",
        args: { center: [-146, 72], zoom: 3 },
        callId: "call_beaufort",
      },
    ]);
  });

  test("treats a call-only completed response as an action, not empty output", () => {
    const result = normalizeAgentResponse(
      {
        id: "resp_123",
        status: "completed",
        output: [
          {
            type: "function_call",
            name: "list_layers",
            arguments: "{}",
            call_id: "call_123",
          },
        ],
      },
      "conversation_123",
    );
    expect(result.responseId).toBe("resp_123");
    expect(result.message).toBeNull();
    expect(result.actions).toEqual([
      { tool: "list_layers", args: {}, callId: "call_123" },
    ]);
  });

  test("rejects malformed native arguments with a diagnosable code", () => {
    expect(() =>
      extractFunctionCalls({
        output: [
          {
            type: "function_call",
            name: "toggle_layer",
            arguments: "{bad json",
            call_id: "call_bad",
          },
        ],
      }),
    ).toThrow(/malformed JSON arguments/i);
    try {
      extractFunctionCalls({
        output: [
          {
            type: "function_call",
            name: "toggle_layer",
            arguments: "[]",
            call_id: "call_bad",
          },
        ],
      });
    } catch (error) {
      expect(error.code).toBe("InvalidAgentFunctionCall");
    }
  });

  test("rejects a truly empty completed response", () => {
    expect(() =>
      normalizeAgentResponse(
        { id: "resp_empty", status: "completed", output: [] },
        "conversation_123",
      ),
    ).toThrow(/without a message or function call/i);
  });

  test("builds official function_call_output continuation input", () => {
    expect(
      buildFunctionCallOutputs([
        {
          tool: "statistics_first_visible",
          callId: "call_stats",
          ok: true,
          message: "Statistics calculated.",
          data: { mean: 4.25, min: 1, max: 8 },
        },
      ]),
    ).toEqual([
      {
        type: "function_call_output",
        call_id: "call_stats",
        output: JSON.stringify({
          tool: "statistics_first_visible",
          ok: true,
          message: "Statistics calculated.",
          data: { mean: 4.25, min: 1, max: 8 },
        }),
      },
    ]);
  });

  test("requires callId only for native continuation input", () => {
    expect(() =>
      buildFunctionCallOutputs([
        { tool: "list_layers", ok: true, data: { layers: [] } },
      ]),
    ).toThrow(/callId/i);
  });

  test("retries the exact published-agent invalid payload once with a minimal conversation", async () => {
    const attempts = [];
    const client = {
      responses: {
        async create(payload, options) {
          attempts.push({ payload, options });
          if (attempts.length === 1) {
            const error = new Error(
              "Invalid payload: Not allowed when agent is specified. [Request ID: safe-id]",
            );
            error.status = 400;
            error.code = "invalid_payload";
            throw error;
          }
          return { id: "resp_retry", status: "completed", output_text: "ok" };
        },
      },
    };
    const result = await createPublishedAgentResponse(
      client,
      {
        conversation: "conversation_once",
        instructions: "request policy",
        tools: [{ type: "function", name: "list_layers" }],
      },
      { agentName: "mmgis-copilot", agentVersion: "7" },
    );

    expect(result.id).toBe("resp_retry");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].payload).toMatchObject({
      conversation: "conversation_once",
      instructions: "request policy",
    });
    expect(attempts[1].payload).toEqual({
      conversation: "conversation_once",
    });
    expect(attempts[1].options).toEqual({
      body: {
        agent_reference: {
          name: "mmgis-copilot",
          version: "7",
          type: "agent_reference",
        },
      },
    });
  });

  test("prefers agent_reference and falls back only on the exact inverse endpoint signature", async () => {
    const attempts = [];
    const client = {
      responses: {
        async create(payload, options) {
          attempts.push({ payload, options });
          if (attempts.length === 1) {
            const error = new Error(
              "The 'agent_reference' property is deprecated. Use 'agent' instead.",
            );
            error.status = 400;
            error.code = "invalid_payload";
            throw error;
          }
          return { id: "resp_body_fallback", status: "completed", output_text: "ok" };
        },
      },
    };
    const result = await createPublishedAgentResponse(
      client,
      { conversation: "conversation_once" },
      { agentName: "mmgis-copilot", agentVersion: "7" },
    );

    expect(result.id).toBe("resp_body_fallback");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].options.body).toHaveProperty("agent_reference");
    expect(attempts[1]).toEqual({
      payload: { conversation: "conversation_once" },
      options: {
        body: {
          agent: { name: "mmgis-copilot", type: "agent_reference" },
        },
      },
    });
  });

  test("does not invert the body for the live agent-to-agent_reference error", async () => {
    const error = new Error(
      "The 'agent' property is deprecated. Use 'agent_reference' instead.",
    );
    error.status = 400;
    error.code = "invalid_payload";
    expect(isAgentReferenceBodyCompatibilityError(error)).toBe(false);
  });

  test("preserves native continuation input during the exact minimal retry", async () => {
    const attempts = [];
    const input = [
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"ok":true}',
      },
    ];
    const client = {
      responses: {
        async create(payload) {
          attempts.push(payload);
          if (attempts.length === 1) {
            const error = new Error(
              "Invalid payload: Not allowed when agent is specified.",
            );
            error.status = 400;
            error.code = "invalid_payload";
            throw error;
          }
          return { id: "resp_continue", status: "completed", output_text: "done" };
        },
      },
    };
    await createPublishedAgentResponse(
      client,
      {
        previous_response_id: "resp_previous",
        input,
        instructions: "request policy",
        tools: [{ type: "function", name: "next_action" }],
      },
      { agentName: "mmgis-copilot", agentVersion: "7" },
    );
    expect(attempts[1]).toEqual({
      previous_response_id: "resp_previous",
      input,
    });
  });

  test("does not retry unrelated Azure 400 responses", async () => {
    const error = new Error("Invalid payload: malformed conversation id.");
    error.status = 400;
    error.code = "invalid_payload";
    expect(isPublishedAgentPayloadCompatibilityError(error)).toBe(false);
    let calls = 0;
    const client = {
      responses: {
        async create() {
          calls += 1;
          throw error;
        },
      },
    };
    await expect(
      createPublishedAgentResponse(
        client,
        { conversation: "bad", instructions: "policy" },
        { agentName: "mmgis-copilot", agentVersion: "7" },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});
