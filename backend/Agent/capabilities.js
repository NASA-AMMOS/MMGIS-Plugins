"use strict";

// This is the bounded subset of host Copilot action descriptors that can be
// transported without changing the schema the host enforces at execution.
const RUNTIME_CAPABILITY_TRANSPORT_VERSION = 1;
const MAX_RUNTIME_CAPABILITIES = 128;
const MAX_CAPABILITY_NAME = 64;
const MAX_DESCRIPTION_CHARS = 4096;
const MAX_SCHEMA_DESCRIPTION_CHARS = 4096;
const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_PROPERTY_NAME = 128;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_SCHEMA_STRING_CHARS = 8192;
const MAX_ENUM_VALUES = 128;
const MAX_ANALYTICS_VALUES = 32;
const MAX_ANALYTICS_VALUE_CHARS = 64;

const CAPABILITY_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const TRANSPORT_SCHEMA_KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

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

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function assertPrimitive(value, path) {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value === "string" &&
    value.length <= MAX_SCHEMA_STRING_CHARS &&
    !hasUnsafeControlText(value)
  ) {
    return;
  }
  throw capabilityError(`${path} must be a bounded JSON primitive.`);
}

function assertNonNegativeInteger(schema, keyword, path) {
  if (!Object.hasOwn(schema, keyword)) return;
  if (!Number.isInteger(schema[keyword]) || schema[keyword] < 0) {
    throw capabilityError(`${path}.${keyword} must be a non-negative integer.`);
  }
}

function assertFiniteNumber(schema, keyword, path, positive = false) {
  if (!Object.hasOwn(schema, keyword)) return;
  const value = schema[keyword];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (positive && value <= 0)
  ) {
    throw capabilityError(
      `${path}.${keyword} must be a ${positive ? "positive " : ""}finite number.`,
    );
  }
}

function assertCompatibleJsonSchema(schema, depth = 0, path = "$", root = true) {
  if (!isPlainObject(schema)) {
    throw capabilityError(`${path} must be a plain JSON Schema object.`);
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw capabilityError(
      `${path} exceeds the runtime schema depth limit of ${MAX_SCHEMA_DEPTH}.`,
    );
  }
  if (root) {
    let serialized;
    try {
      serialized = JSON.stringify(schema);
    } catch (_) {
      throw capabilityError("Runtime capability parameters must be JSON serializable.");
    }
    if (
      typeof serialized !== "string" ||
      Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES
    ) {
      throw capabilityError(
        `Runtime capability parameters exceed ${MAX_SCHEMA_BYTES} bytes.`,
      );
    }
  }

  for (const keyword of Object.keys(schema)) {
    if (!TRANSPORT_SCHEMA_KEYWORDS.has(keyword)) {
      throw capabilityError(
        `${path} uses unsupported transport keyword "${keyword}".`,
      );
    }
  }

  if (typeof schema.type !== "string" || !SCHEMA_TYPES.has(schema.type)) {
    throw capabilityError(`${path}.type must be one supported JSON type.`);
  }
  if (root && schema.type !== "object") {
    throw capabilityError("Runtime capability parameters.type must be \"object\".");
  }
  if (Object.hasOwn(schema, "description")) {
    if (
      typeof schema.description !== "string" ||
      schema.description.length > MAX_SCHEMA_DESCRIPTION_CHARS ||
      hasUnsafeControlText(schema.description)
    ) {
      throw capabilityError(`${path}.description is not bounded safe text.`);
    }
  }

  if (Object.hasOwn(schema, "enum")) {
    if (
      !Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > MAX_ENUM_VALUES
    ) {
      throw capabilityError(
        `${path}.enum must contain 1 to ${MAX_ENUM_VALUES} primitive values.`,
      );
    }
    const values = new Set();
    for (const value of schema.enum) {
      assertPrimitive(value, `${path}.enum`);
      if (!schemaTypeMatches(value, schema.type)) {
        throw capabilityError(`${path}.enum contains a value outside its type.`);
      }
      const serialized = JSON.stringify(value);
      if (values.has(serialized)) {
        throw capabilityError(`${path}.enum contains duplicate values.`);
      }
      values.add(serialized);
    }
  }
  if (Object.hasOwn(schema, "const")) {
    assertPrimitive(schema.const, `${path}.const`);
    if (!schemaTypeMatches(schema.const, schema.type)) {
      throw capabilityError(`${path}.const is outside its type.`);
    }
  }
  if (Object.hasOwn(schema, "default")) {
    assertPrimitive(schema.default, `${path}.default`);
    if (!schemaTypeMatches(schema.default, schema.type)) {
      throw capabilityError(`${path}.default is outside its type.`);
    }
  }

  const objectKeywords = [
    "properties",
    "required",
    "additionalProperties",
    "minProperties",
    "maxProperties",
  ];
  if (
    objectKeywords.some((keyword) => Object.hasOwn(schema, keyword)) &&
    schema.type !== "object"
  ) {
    throw capabilityError(`${path} uses object keywords without type \"object\".`);
  }
  if (Object.hasOwn(schema, "properties")) {
    if (!isPlainObject(schema.properties)) {
      throw capabilityError(`${path}.properties must be a plain object.`);
    }
    const entries = Object.entries(schema.properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      throw capabilityError(
        `${path}.properties exceeds ${MAX_SCHEMA_PROPERTIES} fields.`,
      );
    }
    for (const [key, value] of entries) {
      if (
        !key ||
        key.length > MAX_SCHEMA_PROPERTY_NAME ||
        UNSAFE_OBJECT_KEYS.has(key)
      ) {
        throw capabilityError(`${path}.properties contains an unsafe field name.`);
      }
      assertCompatibleJsonSchema(value, depth + 1, `${path}.properties.${key}`, false);
    }
  }
  if (Object.hasOwn(schema, "required")) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.length > MAX_SCHEMA_PROPERTIES
    ) {
      throw capabilityError(`${path}.required must be a bounded array.`);
    }
    const required = new Set();
    for (const key of schema.required) {
      if (
        typeof key !== "string" ||
        !key ||
        key.length > MAX_SCHEMA_PROPERTY_NAME ||
        UNSAFE_OBJECT_KEYS.has(key) ||
        required.has(key)
      ) {
        throw capabilityError(`${path}.required must contain unique safe names.`);
      }
      required.add(key);
    }
  }
  if (Object.hasOwn(schema, "additionalProperties")) {
    if (typeof schema.additionalProperties !== "boolean") {
      assertCompatibleJsonSchema(
        schema.additionalProperties,
        depth + 1,
        `${path}.additionalProperties`,
        false,
      );
    }
  }
  assertNonNegativeInteger(schema, "minProperties", path);
  assertNonNegativeInteger(schema, "maxProperties", path);

  const arrayKeywords = ["items", "minItems", "maxItems", "uniqueItems"];
  if (
    arrayKeywords.some((keyword) => Object.hasOwn(schema, keyword)) &&
    schema.type !== "array"
  ) {
    throw capabilityError(`${path} uses array keywords without type \"array\".`);
  }
  if (Object.hasOwn(schema, "items")) {
    assertCompatibleJsonSchema(schema.items, depth + 1, `${path}.items`, false);
  }
  assertNonNegativeInteger(schema, "minItems", path);
  assertNonNegativeInteger(schema, "maxItems", path);
  if (
    Object.hasOwn(schema, "uniqueItems") &&
    typeof schema.uniqueItems !== "boolean"
  ) {
    throw capabilityError(`${path}.uniqueItems must be a boolean.`);
  }

  const stringKeywords = ["minLength", "maxLength"];
  if (
    stringKeywords.some((keyword) => Object.hasOwn(schema, keyword)) &&
    schema.type !== "string"
  ) {
    throw capabilityError(`${path} uses string keywords without type \"string\".`);
  }
  assertNonNegativeInteger(schema, "minLength", path);
  assertNonNegativeInteger(schema, "maxLength", path);

  const numericKeywords = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ];
  if (
    numericKeywords.some((keyword) => Object.hasOwn(schema, keyword)) &&
    !["number", "integer"].includes(schema.type)
  ) {
    throw capabilityError(`${path} uses numeric keywords without a numeric type.`);
  }
  for (const keyword of numericKeywords.slice(0, -1)) {
    assertFiniteNumber(schema, keyword, path);
  }
  assertFiniteNumber(schema, "multipleOf", path, true);

  for (const [minimum, maximum] of [
    ["minProperties", "maxProperties"],
    ["minItems", "maxItems"],
    ["minLength", "maxLength"],
    ["minimum", "maximum"],
  ]) {
    if (
      Object.hasOwn(schema, minimum) &&
      Object.hasOwn(schema, maximum) &&
      schema[minimum] > schema[maximum]
    ) {
      throw capabilityError(`${path}.${minimum} exceeds ${maximum}.`);
    }
  }
}

function boundedText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
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

function sanitizePrimitive(value) {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return value.slice(0, MAX_SCHEMA_STRING_CHARS);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function sanitizeSchemaType(value) {
  if (typeof value === "string" && SCHEMA_TYPES.has(value)) return value;
  return undefined;
}

function sanitizeJsonSchema(schema, depth = 0) {
  if (depth === 0) assertCompatibleJsonSchema(schema);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", additionalProperties: false };
  }
  if (depth > MAX_SCHEMA_DEPTH) return {};

  const clean = {};
  const type = sanitizeSchemaType(schema.type);
  if (type) clean.type = type;

  if (Object.hasOwn(schema, "description")) {
    clean.description = schema.description;
  }

  if (schema.properties && typeof schema.properties === "object") {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties).slice(
      0,
      MAX_SCHEMA_PROPERTIES,
    )) {
      if (!key || key.length > MAX_SCHEMA_PROPERTY_NAME) continue;
      if (UNSAFE_OBJECT_KEYS.has(key)) continue;
      properties[key] = sanitizeJsonSchema(value, depth + 1);
    }
    clean.properties = properties;
  }

  if (Array.isArray(schema.required)) {
    const required = Array.from(
      new Set(
        schema.required.filter(
          (key) =>
            typeof key === "string" &&
            key.length <= MAX_SCHEMA_PROPERTY_NAME,
        ),
      ),
    ).slice(0, MAX_SCHEMA_PROPERTIES);
    clean.required = required;
  }

  if (schema.items && typeof schema.items === "object") {
    clean.items = sanitizeJsonSchema(schema.items, depth + 1);
  }


  if (Array.isArray(schema.enum)) {
    const values = schema.enum
      .map(sanitizePrimitive)
      .filter((value) => value !== undefined)
      .slice(0, MAX_ENUM_VALUES);
    if (values.length) clean.enum = values;
  }

  if (Object.hasOwn(schema, "const")) {
    const value = sanitizePrimitive(schema.const);
    if (value !== undefined) clean.const = value;
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

  if (typeof schema.uniqueItems === "boolean") {
    clean.uniqueItems = schema.uniqueItems;
  }

  if (typeof schema.additionalProperties === "boolean") {
    clean.additionalProperties = schema.additionalProperties;
  } else if (isPlainObject(schema.additionalProperties)) {
    clean.additionalProperties = sanitizeJsonSchema(
      schema.additionalProperties,
      depth + 1,
    );
  }


  const defaultValue = sanitizePrimitive(schema.default);
  if (defaultValue !== undefined) clean.default = defaultValue;

  return clean;
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
    assertCompatibleJsonSchema(schemaSource);
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
