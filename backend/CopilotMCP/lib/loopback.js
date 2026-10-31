// Calls MMGIS's own HTTP interfaces (the Agent plugin's /api/agent routes and
// core endpoints) from inside the server, forwarding the MCP caller's
// credentials so the existing authentication middleware and route handlers run
// exactly as they do for the Copilot UI.

const http = require("http");
const https = require("https");
const { CopilotMcpError, ERROR_CODES } = require("./results");

const FORWARDED_HEADERS = ["authorization", "cookie"];

function createLoopback(cfg) {
  const transport = cfg.https ? https : http;

  function request(method, pathAndQuery, { caller = {}, body = undefined, timeoutMs = 180000 } = {}) {
    const headers = { accept: "application/json" };
    for (const name of FORWARDED_HEADERS) {
      if (caller.headers && caller.headers[name]) headers[name] = caller.headers[name];
    }
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    const options = {
      host: "127.0.0.1",
      port: cfg.port,
      method,
      path: `${cfg.rootPath}${pathAndQuery}`,
      headers,
      timeout: timeoutMs,
    };
    if (cfg.https) options.rejectUnauthorized = false; // loopback to this same process

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch (_) {
            json = null;
          }
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json, text });
        });
      });
      req.on("timeout", () => req.destroy(new Error(`Loopback request timed out after ${timeoutMs} ms`)));
      req.on("error", (err) =>
        reject(new CopilotMcpError(ERROR_CODES.UPSTREAM_ERROR, `MMGIS endpoint ${pathAndQuery.split("?")[0]} is unreachable: ${err.message}`))
      );
      if (payload) req.write(payload);
      req.end();
    });
  }

  // MMGIS gates answer HTTP 200 with { status: "failure" } (or an HTML page)
  // when they reject a request; surface those as errors.
  function unwrap(res, label) {
    const body = res.json;
    if (!body && /<html/i.test(res.text || "")) {
      throw new CopilotMcpError(ERROR_CODES.UPSTREAM_ERROR, `${label} returned an HTML page (status ${res.status}); the caller is probably not authenticated.`);
    }
    if (body && body.status === "failure") {
      throw new CopilotMcpError(ERROR_CODES.UPSTREAM_ERROR, `${label}: ${body.message || "request rejected"}`, { status: res.status });
    }
    return body;
  }

  return { request, unwrap };
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

module.exports = { createLoopback, buildQuery };
