// Error codes and MCP tool-result builders shared by every Copilot MCP tool.

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "INVALID_INPUT",
  CAPABILITY_UNAVAILABLE: "CAPABILITY_UNAVAILABLE",
  NO_BROWSER_SESSION: "NO_BROWSER_SESSION",
  AMBIGUOUS_BROWSER_SESSION: "AMBIGUOUS_BROWSER_SESSION",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_FORBIDDEN: "SESSION_FORBIDDEN",
  MISSION_MISMATCH: "MISSION_MISMATCH",
  MISSION_FORBIDDEN: "MISSION_FORBIDDEN",
  NOT_DELIVERED: "NOT_DELIVERED",
  RESULT_TIMEOUT: "RESULT_TIMEOUT",
  SESSION_CLOSED: "SESSION_CLOSED",
  EXECUTION_FAILED: "EXECUTION_FAILED",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
});

class CopilotMcpError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CopilotMcpError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const MAX_STRING = 20000;
const MAX_ARRAY = 500;
const MAX_DEPTH = 8;

// JSON-safe copy that drops functions/DOM-ish objects and bounds size, so tool
// results stay small enough for MCP clients.
function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value === undefined ? undefined : null;
  const t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : null;
  if (t === "boolean") return value;
  if (t === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (t === "bigint") return value.toString();
  if (t === "function" || t === "symbol") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => {
      const s = sanitize(v, depth + 1, seen);
      return s === undefined ? null : s;
    });
    if (value.length > MAX_ARRAY) out.push(`…[${value.length - MAX_ARRAY} more items]`);
    return out;
  }
  if (ArrayBuffer.isView(value)) return `[${value.constructor?.name || "TypedArray"} length=${value.length}]`;
  const out = {};
  for (const key of Object.keys(value)) {
    const s = sanitize(value[key], depth + 1, seen);
    if (s !== undefined) out[key] = s;
  }
  return out;
}

function textBlock(summary, structured) {
  const json = JSON.stringify(structured, null, 2);
  return { type: "text", text: summary ? `${summary}\n\n${json}` : json };
}

function toolSuccess(structured, summary = "") {
  const clean = sanitize(structured);
  return { content: [textBlock(summary, clean)], structuredContent: clean };
}

function toolError(err, extra = {}) {
  const code = err && err.code && ERROR_CODES[err.code] ? err.code : ERROR_CODES.EXECUTION_FAILED;
  const message = (err && err.message) || "Unknown error";
  const structured = sanitize({
    status: "error",
    ...extra,
    error: { code, message, ...(err && err.details !== undefined ? { details: err.details } : {}) },
  });
  return { isError: true, content: [textBlock(`Error (${code}): ${message}`, structured)], structuredContent: structured };
}

module.exports = { ERROR_CODES, CopilotMcpError, sanitize, toolSuccess, toolError };
