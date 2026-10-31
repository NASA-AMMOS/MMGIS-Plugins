// Streamable HTTP MCP endpoint, stateless: each POST gets its own server and
// transport bound to the authenticated MMGIS caller, and responses are plain
// JSON (no long-lived SSE stream to keep through MMGIS's proxies/compression).

const { requireFromMmgis } = require("../lib/host");
const express = requireFromMmgis("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { createMcpServer } = require("../lib/mcpServer");
const { getCaller, jsonRpcErrorBody } = require("../lib/access");

function createMcpRouter({ catalog, log }) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const caller = getCaller(req);
    const server = createMcpServer({ catalog, caller });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (log) log("error", `MCP request failed: ${err && err.message}`);
      if (!res.headersSent) res.status(500).json(jsonRpcErrorBody(req, -32603, "Internal error"));
    }
  });

  const methodNotAllowed = (req, res) => {
    res.status(405).set("Allow", "POST").json(jsonRpcErrorBody(req, -32000, "Method not allowed: this MCP endpoint is stateless and only accepts POST."));
  };
  router.get("/", methodNotAllowed);
  router.delete("/", methodNotAllowed);

  return router;
}

module.exports = { createMcpRouter };
