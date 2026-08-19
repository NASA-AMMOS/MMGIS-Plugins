"use strict";

const MAX_RUNTIME_CAPABILITIES = 64;
const MAX_CAPABILITY_NAME = 64;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_PROPERTIES = 48;
const MAX_SCHEMA_BRANCHES = 8;
const MAX_ENUM_VALUES = 48;
const MAX_ANALYTICS_VALUES = 16;
const MAX_ANALYTICS_VALUE_CHARS = 80;

const CAPABILITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

function boundedText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function sanitizeIdentifier(value, maxLength = MAX_CAPABILITY_NAME) {
  const text = boundedText(value, maxLength);
  return text && CAPABILITY_NAME_RE.test(text) ? text : "";
}

function sanitizeMetadataList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          boundedText(entry, MAX_ANALYTICS_VALUE_CHARS)
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter(Boolean),
    ),
  ).slice(0, MAX_ANALYTICS_VALUES);
}

function sanitizeAnalyticsMetadata(value) {
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

function sanitizePrimitive(value) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, 240);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function sanitizeSchemaType(value) {
  if (typeof value === "string" && SCHEMA_TYPES.has(value)) return value;
  if (Array.isArray(value)) {
    const types = value.filter(
      (entry, index) =>
        typeof entry === "string" &&
        SCHEMA_TYPES.has(entry) &&
        value.indexOf(entry) === index,
    );
    return types.length ? types : undefined;
  }
  return undefined;
}

function sanitizeJsonSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", additionalProperties: false };
  }
  if (depth > MAX_SCHEMA_DEPTH) return {};

  const clean = {};
  const type = sanitizeSchemaType(schema.type);
  if (type) clean.type = type;

  const description = boundedText(schema.description, MAX_DESCRIPTION_CHARS);
  if (description) clean.description = description;

  if (schema.properties && typeof schema.properties === "object") {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties).slice(
      0,
      MAX_SCHEMA_PROPERTIES,
    )) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      properties[key] = sanitizeJsonSchema(value, depth + 1);
    }
    if (Object.keys(properties).length) clean.properties = properties;
  }

  if (Array.isArray(schema.required)) {
    const required = Array.from(
      new Set(
        schema.required.filter(
          (key) =>
            typeof key === "string" &&
            key.length <= 64 &&
            (!clean.properties || Object.hasOwn(clean.properties, key)),
        ),
      ),
    ).slice(0, MAX_SCHEMA_PROPERTIES);
    if (required.length) clean.required = required;
  }

  if (schema.items && typeof schema.items === "object") {
    clean.items = sanitizeJsonSchema(schema.items, depth + 1);
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    if (Array.isArray(schema[keyword])) {
      const branches = schema[keyword]
        .slice(0, MAX_SCHEMA_BRANCHES)
        .map((branch) => sanitizeJsonSchema(branch, depth + 1));
      if (branches.length) clean[keyword] = branches;
    }
  }

  if (Array.isArray(schema.enum)) {
    const values = schema.enum
      .map(sanitizePrimitive)
      .filter((value) => value !== undefined)
      .slice(0, MAX_ENUM_VALUES);
    if (values.length) clean.enum = values;
  }

  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
  ]) {
    const value = schema[keyword];
    if (typeof value === "number" && Number.isFinite(value)) {
      clean[keyword] = value;
    }
  }
  if (
    typeof schema.multipleOf === "number" &&
    Number.isFinite(schema.multipleOf) &&
    schema.multipleOf > 0
  ) {
    clean.multipleOf = schema.multipleOf;
  }

  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]) {
    const value = schema[keyword];
    if (Number.isInteger(value) && value >= 0) {
      clean[keyword] = value;
    }
  }

  if (typeof schema.additionalProperties === "boolean") {
    clean.additionalProperties = schema.additionalProperties;
  } else if (clean.type === "object" || clean.properties) {
    clean.additionalProperties = false;
  }

  const format = boundedText(schema.format, 40);
  if (/^(date|date-time|time|duration|email|hostname|ipv4|ipv6|uri|uuid)$/.test(format)) {
    clean.format = format;
  }

  const defaultValue = sanitizePrimitive(schema.default);
  if (defaultValue !== undefined) clean.default = defaultValue;

  if (!clean.type && !clean.oneOf && !clean.anyOf && !clean.allOf) {
    clean.type = clean.properties ? "object" : "object";
    if (clean.additionalProperties === undefined) {
      clean.additionalProperties = false;
    }
  }
  return clean;
}

function sanitizeRuntimeCapabilities(rawCapabilities) {
  if (!Array.isArray(rawCapabilities)) return [];
  const capabilities = [];
  const seen = new Set();

  for (const raw of rawCapabilities.slice(0, MAX_RUNTIME_CAPABILITIES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const name = sanitizeIdentifier(raw.name || raw.id);
    if (!name || seen.has(name)) continue;

    const description = boundedText(raw.description, MAX_DESCRIPTION_CHARS);
    const category = boundedText(raw.category, 64);
    const plugin = boundedText(
      raw.plugin || raw.pluginId || raw.plugin_id || raw.namespace,
      96,
    );
    const schemaSource =
      raw.parameters || raw.inputSchema || raw.input_schema || raw.schema;
    const parameters = sanitizeJsonSchema(
      schemaSource || { type: "object", additionalProperties: false },
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
  MAX_RUNTIME_CAPABILITIES,
  sanitizeAnalyticsMetadata,
  sanitizeJsonSchema,
  sanitizeRuntimeCapabilities,
  mergeToolRegistries,
};
