import { test, expect } from "@playwright/test";
import {
  sanitizeToolResults,
  redactSensitiveText,
} from "../toolResults";

test.describe("@unit Copilot continuation tool results", () => {
  test("accepts the frontend native-call result shape", () => {
    expect(
      sanitizeToolResults([
        {
          tool: "statistics_first_visible",
          callId: "call_stats_1",
          ok: true,
          message: "Computed statistics.",
          data: { mean: 2.5, min: 1, max: 4 },
          error: null,
        },
      ]),
    ).toEqual([
      {
        tool: "statistics_first_visible",
        callId: "call_stats_1",
        ok: true,
        message: "Computed statistics.",
        data: { mean: 2.5, min: 1, max: 4 },
      },
    ]);
  });

  test("accepts prompt-JSON results without callId", () => {
    const [result] = sanitizeToolResults([
      {
        tool: "toggle_layer",
        ok: true,
        message: "SWOT binned freeboard is now visible.",
      },
    ]);
    expect(result.callId).toBeUndefined();
    expect(result.message).toMatch(/visible/);
  });

  test("preserves a safe structured tool exception", () => {
    const [result] = sanitizeToolResults([
      {
        tool: "calculate_layer_mean",
        ok: false,
        error: {
          code: "ScalarValuesUnavailable",
          message: "The RGB imagery layer does not expose scalar values.",
        },
      },
    ]);
    expect(result.error).toEqual({
      code: "ScalarValuesUnavailable",
      message: "The RGB imagery layer does not expose scalar values.",
    });
  });

  test("scrubs persistence diagnostics before logging", () => {
    const scrubbed = redactSensitiveText(
      "Failed at C:\\private\\agent.js https://example.test/a?token=secret\n at handler (C:\\private\\stack.js:1:2)",
      500,
    );
    expect(scrubbed).toContain("[redacted path]");
    expect(scrubbed).toContain("token=[redacted]");
    expect(scrubbed).not.toContain("secret");
    expect(scrubbed).not.toContain("stack.js");
  });

  test("rejects malformed, oversized, and non-JSON result data", () => {
    expect(() => sanitizeToolResults([])).toThrow(/non-empty array/i);
    expect(() =>
      sanitizeToolResults([{ tool: "bad tool", ok: true }]),
    ).toThrow(/valid capability name/i);
    expect(() =>
      sanitizeToolResults([
        {
          tool: "list_layers",
          ok: true,
          data: { value: Number.POSITIVE_INFINITY },
        },
      ]),
    ).toThrow(/non-finite/i);
    expect(() =>
      sanitizeToolResults([
        {
          tool: "list_layers",
          ok: true,
          message: "x".repeat(1201),
        },
      ]),
    ).toThrow(/exceeds/i);
  });
});
