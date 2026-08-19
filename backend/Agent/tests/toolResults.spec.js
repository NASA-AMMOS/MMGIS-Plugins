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

  test("recursively redacts values stored under sensitive field names", () => {
    const [result] = sanitizeToolResults([
      {
        tool: "runtime_action",
        ok: true,
        data: {
          apiKey: "top-level-api-key",
          nested: {
            Authorization: "Bearer nested-token",
            safe: "visible",
            items: [
              { refresh_token: "refresh-secret", count: 2 },
              {
                metadata: {
                  clientSecret: "client-secret",
                  tokenCount: 4,
                },
              },
            ],
          },
        },
      },
    ]);

    expect(result.data).toEqual({
      apiKey: "[redacted]",
      nested: {
        Authorization: "[redacted]",
        safe: "visible",
        items: [
          { refresh_token: "[redacted]", count: 2 },
          {
            metadata: {
              clientSecret: "[redacted]",
              tokenCount: 4,
            },
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("top-level-api-key");
    expect(serialized).not.toContain("nested-token");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("client-secret");
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
