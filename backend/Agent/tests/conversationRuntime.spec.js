import { test, expect } from "@playwright/test";
import {
  beginRuntimeConversation,
  getRuntimeConversation,
  setPendingActions,
  claimPendingActions,
  completePendingClaim,
  bestEffortCreateConversation,
  _runtimeStore,
} from "../conversationRuntime";
import { normalizeActions } from "../provider";

test.describe("@unit Copilot runtime conversation state", () => {
  test.beforeEach(() => _runtimeStore.clear());

  test("planning remains available when model create fails", async () => {
    const result = await bestEffortCreateConversation(
      {
        create: async () => {
          throw new Error("permission denied");
        },
      },
      { conversationId: "id" },
    );
    expect(result).toBeNull();
  });

  test("binds conversations to owner and mission", () => {
    beginRuntimeConversation({
      conversationId: "conversation-a",
      owner: "alice|session-a",
      mission: "Arctic",
    });
    expect(
      getRuntimeConversation(
        "conversation-a",
        "alice|session-a",
        "Arctic",
      ),
    ).not.toBeNull();
    expect(
      getRuntimeConversation(
        "conversation-a",
        "bob|session-b",
        "Arctic",
      ),
    ).toBeNull();
  });

  test("validates and consumes exact call IDs once while allowing a next round", () => {
    const state = beginRuntimeConversation({
      conversationId: "conversation-a",
      owner: "alice",
      mission: "Arctic",
    });
    setPendingActions(
      state,
      [
        {
          tool: "statistics_first_visible",
          callId: "call_1",
        },
      ],
      "resp_1",
    );
    expect(() =>
      claimPendingActions(
        state,
        [
          {
            tool: "statistics_first_visible",
            callId: "wrong",
            ok: true,
          },
        ],
        "resp_1",
      ),
    ).toThrow(/does not match/i);
    const claim = claimPendingActions(
      state,
      [
        {
          tool: "statistics_first_visible",
          callId: "call_1",
          ok: true,
        },
      ],
      "resp_1",
    );
    completePendingClaim(
      state,
      claim,
      [{ tool: "highlight_relative_to_mean", callId: "call_2" }],
      "resp_2",
    );
    const next = claimPendingActions(
      state,
      [
        {
          tool: "highlight_relative_to_mean",
          callId: "call_2",
          ok: true,
        },
      ],
      "resp_2",
    );
    completePendingClaim(state, next, [], "resp_3");
    expect(() =>
      claimPendingActions(state, [], "resp_3"),
    ).toThrow(/already submitted|no pending/i);
  });

  test("accepts an unregistered one-shot result but rejects a future new call", () => {
    const state = beginRuntimeConversation({
      conversationId: "conversation-one-shot",
      owner: "alice",
      mission: "Arctic",
    });
    setPendingActions(
      state,
      [{ tool: "ephemeral__capture", callId: "call_ephemeral_1" }],
      "resp_ephemeral_1",
    );

    // The client executed the pending action, then the one-shot plugin removed
    // its runtime descriptor before posting the correlated result.
    const currentlyAvailable = new Set(["list_layers"]);
    expect(currentlyAvailable.has("ephemeral__capture")).toBe(false);
    const toolResults = [
      {
        tool: "ephemeral__capture",
        callId: "call_ephemeral_1",
        ok: true,
        message: "One-shot capture completed.",
      },
    ];
    const claim = claimPendingActions(
      state,
      toolResults,
      "resp_ephemeral_1",
    );

    // Current availability governs only calls planned after this result.
    expect(() =>
      normalizeActions(
        [{ tool: "ephemeral__capture", args: {} }],
        { toolNames: currentlyAvailable },
      ),
    ).toThrow(/unknown tool/i);

    completePendingClaim(state, claim, [], "resp_ephemeral_2");
    expect(() =>
      claimPendingActions(state, toolResults, "resp_ephemeral_1"),
    ).toThrow(/already submitted|no pending/i);
  });
});
