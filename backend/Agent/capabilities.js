"use strict";

const { createAgentAjv } = require("./schemaValidation");

// Agent's request I/O budgets. These bound model context and schema compilation;
// they are not a sandbox for installed frontend plugins.
const RUNTIME_CAPABILITY_TRANSPORT_VERSION = 1;
const MAX_RUNTIME_CAPABILITIES = 128;
const MAX_CAPABILITY_NAME = 64;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_PROPERTY_NAME = 128;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_ENUM_VALUES = 128;
const MAX_ANALYTICS_VALUES = 32;
const MAX_ANALYTICS_VALUE_CHARS = 64;
const CAPABILITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function capabilityError(message) {
  const error = new Error(message);
  error.code = "InvalidRuntimeCapabilities";
  error.status = 400;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnsafeControlText(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function sanitizeJsonSchema(schema) {
  if (!isPlainObject(schema) || schema.type !== "object") {
    throw capabilityError('Runtime capability parameters.type must be "object".');
  }
  let serialized;
  try { serialized = JSON.stringify(schema); } catch (_) {
    throw capabilityError("Runtime capability parameters must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
    throw capabilityError(`Runtime capability parameters exceed ${MAX_SCHEMA_BYTES} bytes.`);
  }
  const copy = JSON.parse(serialized);
  function bound(value, depth = 0) {
    if (!value || typeof value !== "object") return;
    if (depth > MAX_SCHEMA_DEPTH) {
      throw capabilityError(`Runtime schema exceeds the depth limit of ${MAX_SCHEMA_DEPTH}.`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_OBJECT_KEYS.has(key)) throw capabilityError("Schema contains an unsafe field name.");
      if (key === "properties" && isPlainObject(child)) {
        if (Object.keys(child).length > MAX_SCHEMA_PROPERTIES ||
            Object.keys(child).some((name) => name.length > MAX_SCHEMA_PROPERTY_NAME)) {
          throw capabilityError("Schema contains too many properties or an unsafe field name.");
        }
      }
      if (key === "enum" && Array.isArray(child) && child.length > MAX_ENUM_VALUES) {
        throw capabilityError(`Schema enum must contain 1 to ${MAX_ENUM_VALUES} values.`);
      }
      bound(child, depth + 1);
    }
  }
  bound(copy);
  // Ajv supplies JSON Schema semantics, including local $ref, pattern and
  // composition. Preserve the schema exactly; never silently strip keywords.
  try {
    const ajv = createAgentAjv({ strict: false, validateFormats: true, addUsedSchema: false });
    ajv.compile(copy);
  } catch (error) {
    throw capabilityError(`Invalid action JSON Schema: ${error.message}`);
  }
  return copy;
}

function boundedText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeIdentifier(value, maxLength = MAX_CAPABILITY_NAME) {
  const text = boundedText(value, maxLength);
  return text && CAPABILITY_NAME_RE.test(text) ? text : "";
}

function assertCompatibleAnalyticsMetadata(value, path = "analytics") {
  if (value == null) return;
  if (!isPlainObject(value)) {
    throw capabilityError(`${path} must be a plain object.`);
  }
  const allowed = new Set([
    "operations",
    "dataKinds",
    "data_kinds",
    "requiresScalar",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw capabilityError(`${path}.${key} is not in the transport contract.`);
    }
  }
  if (Object.hasOwn(value, "dataKinds") && Object.hasOwn(value, "data_kinds")) {
    throw capabilityError(
      `${path} must not contain both dataKinds and data_kinds.`,
    );
  }
  for (const field of ["operations", "dataKinds", "data_kinds"]) {
    if (!Object.hasOwn(value, field)) continue;
    if (!Array.isArray(value[field]) || value[field].length > MAX_ANALYTICS_VALUES) {
      throw capabilityError(
        `${path}.${field} may contain at most ${MAX_ANALYTICS_VALUES} values.`,
      );
    }
    const seen = new Set();
    for (const entry of value[field]) {
      if (
        typeof entry !== "string" ||
        !entry.trim() ||
        entry !== entry.trim() ||
        entry.length > MAX_ANALYTICS_VALUE_CHARS ||
        hasUnsafeControlText(entry) ||
        seen.has(entry.trim())
      ) {
        throw capabilityError(`${path}.${field} contains an invalid value.`);
      }
      seen.add(entry.trim());
    }
  }
  if (
    Object.hasOwn(value, "requiresScalar") &&
    typeof value.requiresScalar !== "boolean"
  ) {
    throw capabilityError(`${path}.requiresScalar must be a boolean.`);
  }
}

function sanitizeMetadataList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          boundedText(entry, MAX_ANALYTICS_VALUE_CHARS)
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .trim(),
        )
        .filter(Boolean),
    ),
  ).slice(0, MAX_ANALYTICS_VALUES);
}

function sanitizeAnalyticsMetadata(value) {
  assertCompatibleAnalyticsMetadata(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const operations = sanitizeMetadataList(value.operations);
  const dataKinds = sanitizeMetadataList(value.dataKinds || value.data_kinds);
  const requiresScalar =
    typeof value.requiresScalar === "boolean"
      ? value.requiresScalar
      : undefined;
  if (
    !operations.length &&
    !dataKinds.length &&
    requiresScalar === undefined
  ) {
    return null;
  }
  return {
    ...(operations.length ? { operations } : {}),
    ...(dataKinds.length ? { dataKinds } : {}),
    ...(requiresScalar !== undefined ? { requiresScalar } : {}),
  };
}

function sanitizeRuntimeCapabilities(rawCapabilities) {
  if (rawCapabilities == null) return [];
  if (!Array.isArray(rawCapabilities)) {
    throw capabilityError("Runtime capabilities must be an array.");
  }
  if (rawCapabilities.length > MAX_RUNTIME_CAPABILITIES) {
    throw capabilityError(
      `Runtime capabilities may contain at most ${MAX_RUNTIME_CAPABILITIES} entries.`,
    );
  }
  const capabilities = [];
  const seen = new Set();

  for (const [index, raw] of rawCapabilities.entries()) {
    const path = `runtimeCapabilities[${index}]`;
    if (!isPlainObject(raw)) {
      throw capabilityError(`${path} must be a plain object.`);
    }
    const hasName = Object.hasOwn(raw, "name");
    const hasId = Object.hasOwn(raw, "id");
    const rawName = hasName ? raw.name : raw.id;
    if (
      typeof rawName !== "string" ||
      !rawName.trim() ||
      rawName !== rawName.trim() ||
      rawName.trim().length > MAX_CAPABILITY_NAME ||
      !CAPABILITY_NAME_RE.test(rawName.trim())
    ) {
      throw capabilityError(`${path}.name is not a portable public action id.`);
    }
    if (
      hasName &&
      hasId &&
      (typeof raw.id !== "string" || rawName !== raw.id)
    ) {
      throw capabilityError(`${path}.name and .id must identify the same action.`);
    }
    if (
      raw.description != null &&
      (typeof raw.description !== "string" ||
        !raw.description.trim() ||
        raw.description !== raw.description.trim() ||
        raw.description.trim().length > MAX_DESCRIPTION_CHARS ||
        hasUnsafeControlText(raw.description))
    ) {
      throw capabilityError(`${path}.description is not bounded safe text.`);
    }
    if (
      raw.category != null &&
      (typeof raw.category !== "string" ||
        !raw.category.trim() ||
        raw.category !== raw.category.trim() ||
        raw.category.trim().length > 64 ||
        hasUnsafeControlText(raw.category))
    ) {
      throw capabilityError(`${path}.category is not bounded safe text.`);
    }
    const rawPlugin = raw.plugin || raw.pluginId || raw.plugin_id || raw.namespace;
    if (
      rawPlugin != null &&
      (typeof rawPlugin !== "string" ||
        !rawPlugin.trim() ||
        rawPlugin !== rawPlugin.trim() ||
        rawPlugin.trim().length > 192 ||
        hasUnsafeControlText(rawPlugin))
    ) {
      throw capabilityError(`${path}.plugin is not bounded text.`);
    }
    const schemaSource =
      raw.parameters !== undefined
        ? raw.parameters
        : raw.inputSchema !== undefined
          ? raw.inputSchema
          : raw.input_schema !== undefined
            ? raw.input_schema
            : raw.schema !== undefined
              ? raw.schema
              : { type: "object", additionalProperties: false };
    assertCompatibleAnalyticsMetadata(raw.analytics, `${path}.analytics`);
    const rawUiType = raw.execution?.ui?.type || raw.ui?.type || raw.renderer;
    if (
      rawUiType != null &&
      (typeof rawUiType !== "string" ||
        rawUiType.trim().length > MAX_CAPABILITY_NAME ||
        !CAPABILITY_NAME_RE.test(rawUiType.trim()))
    ) {
      throw capabilityError(`${path}.renderer is not a portable identifier.`);
    }

    const name = sanitizeIdentifier(raw.name || raw.id);
    if (seen.has(name)) {
      throw capabilityError(`Runtime capability name "${name}" is duplicated.`);
    }

    const description = boundedText(raw.description, MAX_DESCRIPTION_CHARS);
    const category = boundedText(raw.category, 64);
    const plugin = boundedText(
      raw.plugin || raw.pluginId || raw.plugin_id || raw.namespace,
      192,
    );
    const parameters = sanitizeJsonSchema(
      schemaSource,
    );
    const uiType = sanitizeIdentifier(
      raw.execution?.ui?.type || raw.ui?.type || raw.renderer,
    );
    const analytics = sanitizeAnalyticsMetadata(raw.analytics);

    const capability = {
      name,
      description: description || `Client-provided MMGIS capability ${name}.`,
      category: category || "application",
      plugin: plugin || null,
      parameters,
      ...(analytics ? { analytics } : {}),
      source: "client-runtime",
      execution: {
        adapter: "client",
        ...(uiType ? { ui: { type: uiType } } : {}),
      },
    };
    capabilities.push(capability);
    seen.add(name);
  }
  return capabilities;
}

function mergeToolRegistries(staticRegistry, runtimeCapabilities) {
  const base =
    staticRegistry && typeof staticRegistry === "object"
      ? staticRegistry
      : { tools: [] };
  const staticTools = Array.isArray(base.tools) ? base.tools : [];
  const names = new Set(staticTools.map((tool) => tool?.name).filter(Boolean));
  const dynamicTools = sanitizeRuntimeCapabilities(runtimeCapabilities).filter(
    (tool) => !names.has(tool.name),
  );
  return {
    ...base,
    tools: [...staticTools, ...dynamicTools],
  };
}

module.exports = {
  CAPABILITY_NAME_RE,
  RUNTIME_CAPABILITY_TRANSPORT_VERSION,
  MAX_RUNTIME_CAPABILITIES,
  MAX_CAPABILITY_NAME,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PROPERTIES,
  MAX_SCHEMA_PROPERTY_NAME,
  MAX_ENUM_VALUES,
  MAX_ANALYTICS_VALUES,
  sanitizeAnalyticsMetadata,
  sanitizeJsonSchema,
  sanitizeRuntimeCapabilities,
  mergeToolRegistries,
};
