import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { createAgentAjv } from "../schemaValidation";
import {
  RUNTIME_CAPABILITY_TRANSPORT_VERSION,
  MAX_RUNTIME_CAPABILITIES,
  MAX_CAPABILITY_NAME,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PROPERTIES,
  MAX_SCHEMA_PROPERTY_NAME,
  MAX_ENUM_VALUES,
  MAX_ANALYTICS_VALUES,
  sanitizeRuntimeCapabilities,
  mergeToolRegistries,
} from "../capabilities";
import { formatToolDescription } from "../provider";

const contractFixture = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "fixtures/runtime-capability-transport.v1.json"),
    "utf8",
  ),
);

test.describe("@unit runtime Copilot capabilities", () => {
  const runtimeDescriptor = {
    name: "frozon__statistics_first_visible",
    description: "Calculate statistics for the first analyzable visible layer.",
    category: "analytics",
    plugin: "frozon",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        region: {
          type: "string",
          description: "Named region or current view.",
        },
        threshold: {
          type: "number",
          minimum: -10,
          maximum: 100,
        },
      },
      required: ["region"],
    },
    execution: {
      adapter: "arbitrary-server-code",
      ui: { type: "statistics_panel" },
    },
    analytics: {
      operations: ["statistics", "mean", "threshold"],
      dataKinds: ["scalar-raster", "numeric-grid"],
      requiresScalar: true,
    },
  };

  test("sanitizes and preserves namespaced plugin/category/schema metadata", () => {
    const [tool] = sanitizeRuntimeCapabilities([runtimeDescriptor]);
    expect(tool.name).toBe("frozon__statistics_first_visible");
    expect(tool.plugin).toBe("frozon");
    expect(tool.category).toBe("analytics");
    expect(tool.execution.adapter).toBe("client");
    expect(tool.execution.ui.type).toBe("statistics_panel");
    expect(tool.parameters.required).toEqual(["region"]);
    expect(tool.parameters.properties.threshold.minimum).toBe(-10);
    expect(tool.analytics).toEqual({
      operations: ["statistics", "mean", "threshold"],
      dataKinds: ["scalar-raster", "numeric-grid"],
      requiresScalar: true,
    });
    const validate = createAgentAjv({ strict: false }).compile(tool.parameters);
    expect(validate({ region: "current view", threshold: 5 })).toBe(true);
    expect(validate({ threshold: 5 })).toBe(false);
  });

  test("merges runtime capabilities without allowing static tools to be overridden", () => {
    const staticRegistry = {
      version: "test",
      tools: [
        {
          name: "toggle_layer",
          description: "Trusted static tool.",
          parameters: { type: "object" },
          execution: { adapter: "custom" },
        },
      ],
      uiProfiles: { toggle: { kind: "toggle_visibility" } },
    };
    const merged = mergeToolRegistries(staticRegistry, [
      {
        ...runtimeDescriptor,
        name: "toggle_layer",
        description: "Untrusted override.",
      },
      runtimeDescriptor,
    ]);
    expect(merged.tools).toHaveLength(2);
    expect(merged.tools[0].description).toBe("Trusted static tool.");
    expect(merged.tools[1].name).toBe(
      "frozon__statistics_first_visible",
    );
    expect(merged.uiProfiles).toEqual(staticRegistry.uiProfiles);
  });

  test("preserves the versioned Agent transport fixture without schema drift", () => {
    expect(contractFixture.version).toBe(RUNTIME_CAPABILITY_TRANSPORT_VERSION);
    expect(contractFixture.limits).toEqual({
      actions: MAX_RUNTIME_CAPABILITIES,
      publicActionId: MAX_CAPABILITY_NAME,
      schemaDepth: MAX_SCHEMA_DEPTH,
      schemaProperties: MAX_SCHEMA_PROPERTIES,
      propertyName: MAX_SCHEMA_PROPERTY_NAME,
      enumValues: MAX_ENUM_VALUES,
      analyticsValues: MAX_ANALYTICS_VALUES,
    });

    const [tool] = sanitizeRuntimeCapabilities([
      contractFixture.acceptedDescriptor,
    ]);
    expect(tool.parameters).toEqual(
      contractFixture.acceptedDescriptor.parameters,
    );
    expect(tool.analytics).toEqual(
      contractFixture.acceptedDescriptor.analytics,
    );

    const validate = createAgentAjv({ strict: false }).compile(tool.parameters);
    expect(
      validate({
        mode: "safe",
        fixed: "transport-v1",
        tags: ["alpha", "beta"],
        attempt: 2,
      }),
    ).toBe(true);
    expect(
      validate({
        mode: "safe",
        fixed: "wrong",
        tags: ["duplicate", "duplicate"],
      }),
    ).toBe(false);
  });

  test("rejects incompatible descriptors instead of silently weakening them", () => {
    expect(() =>
      sanitizeRuntimeCapabilities([
        { ...runtimeDescriptor, name: "bad tool name" },
      ]),
    ).toThrow(/portable public action id/i);
    const schema = {
      type: "object",
      definitions: { code: { type: "string", pattern: "^[A-Z]+$" } },
      properties: { value: { $ref: "#/definitions/code" } },
      anyOf: [{ required: ["value"] }],
      additionalProperties: false,
    };
    const [action] = sanitizeRuntimeCapabilities([{ ...runtimeDescriptor, parameters: schema }]);
    expect(action.parameters).toEqual(schema);
    const validate = createAgentAjv({ strict: false }).compile(action.parameters);
    expect(validate({ value: "ABC" })).toBe(true);
    expect(validate({ value: "123" })).toBe(false);
    expect(() =>
      sanitizeRuntimeCapabilities([
        {
          ...runtimeDescriptor,
          analytics: {
            ...runtimeDescriptor.analytics,
            predicate: "never transport executable applicability code",
          },
        },
      ]),
    ).toThrow(/predicate.*transport contract/i);
  });

  test("validates standard formats and rejects invalid JSON Schemas", () => {
    const parameters = {
      type: "object",
      properties: { date: { type: "string", format: "date" } },
      required: ["date"],
    };
    const [tool] = sanitizeRuntimeCapabilities([{ ...runtimeDescriptor, parameters }]);
    const validate = createAgentAjv().compile(tool.parameters);
    expect(validate({ date: "2026-09-09" })).toBe(true);
    expect(validate({ date: "2026-99-99" })).toBe(false);
    expect(() => sanitizeRuntimeCapabilities([{
      ...runtimeDescriptor, parameters: { type: "object", properties: { value: { type: "bogus" } } },
    }])).toThrow(/Invalid action JSON Schema/);
  });

  test("puts category, plugin, and parameter requirements in the model prompt entry", () => {
    const [tool] = sanitizeRuntimeCapabilities([runtimeDescriptor]);
    const text = formatToolDescription(tool);
    expect(text).toContain("category: analytics");
    expect(text).toContain("plugin: frozon");
    expect(text).toContain("operations [statistics, mean, threshold]");
    expect(text).toContain("data kinds [scalar-raster, numeric-grid]");
    expect(text).toContain("requires scalar: true");
    expect(text).toContain('"required":["region"]');
    expect(text).toContain('"minimum":-10');
  });

  test("enforces Agent I/O budgets and rejects over-limit descriptors", () => {
    const operations = Array.from(
      { length: MAX_ANALYTICS_VALUES },
      (_, index) => `operation-${index}`,
    );
    const [tool] = sanitizeRuntimeCapabilities([
      {
        ...runtimeDescriptor,
        analytics: {
          operations,
          data_kinds: ["scalar-raster", "vector-feature"],
          requiresScalar: true,
        },
      },
    ]);
    expect(tool.analytics.operations).toEqual(operations);
    expect(tool.analytics.dataKinds).toEqual([
      "scalar-raster",
      "vector-feature",
    ]);
    expect(tool.analytics.requiresScalar).toBe(true);

    expect(() =>
      sanitizeRuntimeCapabilities(
        Array.from({ length: MAX_RUNTIME_CAPABILITIES + 1 }, (_, index) => ({
          ...runtimeDescriptor,
          name: `plugin_action_${index}`,
        })),
      ),
    ).toThrow(/at most 128/i);
    expect(() =>
      sanitizeRuntimeCapabilities([
        {
          ...runtimeDescriptor,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              mode: {
                type: "integer",
                enum: Array.from(
                  { length: MAX_ENUM_VALUES + 1 },
                  (_, index) => index,
                ),
              },
            },
          },
        },
      ]),
    ).toThrow(/enum must contain 1 to 128/i);
    expect(() =>
      sanitizeRuntimeCapabilities([
        {
          ...runtimeDescriptor,
          analytics: {
            operations: Array.from(
              { length: MAX_ANALYTICS_VALUES + 1 },
              (_, index) => `operation-${index}`,
            ),
          },
        },
      ]),
    ).toThrow(/at most 32/i);
  });

  test("preserves 128-character property names and rejects deeper or longer schemas", () => {
    const maximumPropertyName = "p".repeat(MAX_SCHEMA_PROPERTY_NAME);
    const [tool] = sanitizeRuntimeCapabilities([
      {
        ...runtimeDescriptor,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            [maximumPropertyName]: { type: "string" },
          },
        },
      },
    ]);
    expect(tool.parameters.properties[maximumPropertyName]).toEqual({
      type: "string",
    });

    expect(() =>
      sanitizeRuntimeCapabilities([
        {
          ...runtimeDescriptor,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
              [`${maximumPropertyName}x`]: { type: "string" },
            },
          },
        },
      ]),
    ).toThrow(/unsafe field name/i);

    let tooDeep = { type: "string" };
    for (let depth = 0; depth <= MAX_SCHEMA_DEPTH; depth += 1) {
      tooDeep = { type: "array", items: tooDeep };
    }
    expect(() =>
      sanitizeRuntimeCapabilities([
        {
          ...runtimeDescriptor,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { nested: tooDeep },
          },
        },
      ]),
    ).toThrow(/depth limit of 12/i);
  });

  test("preserves false requiresScalar metadata without requiring list fields", () => {
    const [tool] = sanitizeRuntimeCapabilities([
      {
        ...runtimeDescriptor,
        analytics: { requiresScalar: false },
      },
    ]);
    expect(tool.analytics).toEqual({ requiresScalar: false });
    expect(formatToolDescription(tool)).toContain("requires scalar: false");
  });
});
