import { test, expect } from "@playwright/test";
import Ajv from "ajv";
import {
  sanitizeRuntimeCapabilities,
  mergeToolRegistries,
} from "../capabilities";
import { formatToolDescription } from "../provider";

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
      predicate: "never preserve executable applicability code",
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
    expect(tool.analytics.predicate).toBeUndefined();
    const validate = new Ajv({ strict: false }).compile(tool.parameters);
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

  test("drops invalid names and strips executable or risky schema fields", () => {
    const tools = sanitizeRuntimeCapabilities([
      { ...runtimeDescriptor, name: "bad tool name" },
      {
        ...runtimeDescriptor,
        name: "safe_plugin__action",
        parameters: {
          type: "object",
          properties: {
            value: {
              type: "string",
              pattern: "(a+)+$",
              $ref: "https://example.invalid/schema",
            },
          },
        },
      },
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].parameters.properties.value.pattern).toBeUndefined();
    expect(tools[0].parameters.properties.value.$ref).toBeUndefined();
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

  test("bounds analytics applicability metadata and drops executable fields", () => {
    const [tool] = sanitizeRuntimeCapabilities([
      {
        ...runtimeDescriptor,
        analytics: {
          operations: Array.from({ length: 30 }, (_, index) =>
            `operation-${index}`,
          ),
          data_kinds: ["scalar-raster", "scalar-raster", "vector-feature"],
          requiresScalar: "yes",
          supports: () => true,
          execute: "arbitrary code",
        },
      },
    ]);
    expect(tool.analytics.operations).toHaveLength(16);
    expect(tool.analytics.dataKinds).toEqual([
      "scalar-raster",
      "vector-feature",
    ]);
    expect(Object.keys(tool.analytics).sort()).toEqual([
      "dataKinds",
      "operations",
    ]);
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
