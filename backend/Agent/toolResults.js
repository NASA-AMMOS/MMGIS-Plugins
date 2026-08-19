"use strict";

const MAX_TOOL_RESULTS = 32;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const MAX_RESULT_DEPTH = 6;
const MAX_COLLECTION_ITEMS = 64;
const MAX_RESULT_STRING = 4000;
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function validationError(message) {
  const error = new Error(message);
  error.code = "InvalidToolResults";
  error.status = 400;
  return error;
}

function redactSensitiveText(value, maxLength = MAX_RESULT_STRING) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(
      /([?&](?:token|key|api_key|apikey|secret|signature|sig|password|credential)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s]+/g, "[redacted path]")
    .replace(
      /(^|\s)\/(?:home|Users|var|etc|tmp|opt|srv|root)\/[^\s]+/g,
      "$1[redacted path]",
    )
    .replace(/\n\s*at\s+[^\n]+(?=\n|$)/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanString(value, field, maxLength = MAX_RESULT_STRING) {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`);
  }
  const sanitized = redactSensitiveText(value, Number.MAX_SAFE_INTEGER);
  if (sanitized.length > maxLength) {
    throw validationError(`${field} exceeds ${maxLength} characters.`);
  }
  return sanitized;
}

function sanitizeJsonValue(value, depth = 0, seen = new WeakSet()) {
  if (depth > MAX_RESULT_DEPTH) {
    throw validationError("Tool result data is nested too deeply.");
  }
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError("Tool result data contains a non-finite number.");
    }
    return value;
  }
  if (typeof value === "string") {
    return cleanString(value, "Tool result string");
  }
  if (typeof value !== "object") {
    throw validationError("Tool result data must contain JSON-compatible values.");
  }
  if (seen.has(value)) throw validationError("Tool result data is cyclic.");
  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_ITEMS) {
      throw validationError(
        `Tool result arrays may contain at most ${MAX_COLLECTION_ITEMS} items.`,
      );
    }
    const result = value.map((entry) => sanitizeJsonValue(entry, depth + 1, seen));
    seen.delete(value);
    return result;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_COLLECTION_ITEMS) {
    throw validationError(
      `Tool result objects may contain at most ${MAX_COLLECTION_ITEMS} fields.`,
    );
  }
  const result = {};
  for (const [key, entry] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue;
    if (key.length > 128) {
      throw validationError("Tool result field names may not exceed 128 characters.");
    }
    result[key] = sanitizeJsonValue(entry, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function sanitizeToolResults(rawResults) {
  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    throw validationError("toolResults must be a non-empty array.");
  }
  if (rawResults.length > MAX_TOOL_RESULTS) {
    throw validationError(`toolResults may contain at most ${MAX_TOOL_RESULTS} entries.`);
  }

  const results = rawResults.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw validationError(`toolResults[${index}] must be an object.`);
    }
    const tool = cleanString(raw.tool, `toolResults[${index}].tool`, 64);
    if (!TOOL_NAME_RE.test(tool)) {
      throw validationError(`toolResults[${index}].tool is not a valid capability name.`);
    }
    if (typeof raw.ok !== "boolean") {
      throw validationError(`toolResults[${index}].ok must be a boolean.`);
    }

    const result = { tool, ok: raw.ok };
    if (raw.callId != null) {
      const callId = cleanString(raw.callId, `toolResults[${index}].callId`, 200);
      if (!callId || !/^[A-Za-z0-9_.:-]+$/.test(callId)) {
        throw validationError(`toolResults[${index}].callId is invalid.`);
      }
      result.callId = callId;
    }
    if (raw.message != null) {
      result.message = cleanString(
        raw.message,
        `toolResults[${index}].message`,
        1200,
      );
    }
    if (raw.data !== undefined) {
      result.data = sanitizeJsonValue(raw.data);
    }
    if (raw.error != null) {
      if (!raw.error || typeof raw.error !== "object" || Array.isArray(raw.error)) {
        throw validationError(`toolResults[${index}].error must be an object.`);
      }
      result.error = {
        code: cleanString(
          raw.error.code || "ToolExecutionFailed",
          `toolResults[${index}].error.code`,
          100,
        ),
        message: cleanString(
          raw.error.message || "The capability could not be completed.",
          `toolResults[${index}].error.message`,
          1200,
        ),
      };
    }
    return result;
  });

  if (Buffer.byteLength(JSON.stringify(results), "utf8") > MAX_TOOL_RESULT_BYTES) {
    throw validationError(
      `toolResults exceeds the ${MAX_TOOL_RESULT_BYTES}-byte limit.`,
    );
  }
  return results;
}

module.exports = {
  MAX_TOOL_RESULTS,
  MAX_TOOL_RESULT_BYTES,
  sanitizeJsonValue,
  sanitizeToolResults,
  redactSensitiveText,
};
