// MCP server (official @modelcontextprotocol/sdk). The low-level Server is used
// so the Copilot registry's JSON Schemas are advertised verbatim.

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} = require("@modelcontextprotocol/sdk/types.js");

const PLUGIN_VERSION = require("../plugin.json").version;

const INSTRUCTIONS = [
  "Tools for the MMGIS Copilot of this MMGIS instance.",
  "Copilot registry tools (list_layers, toggle_layer, zoom_to, set_time, threshold_highlight, calculate_layer_mean, …) run in a live MMGIS browser session",
  "that has the CopilotMCPBridge component enabled; use mmgis_list_sessions to find session_id/mission and mmgis_get_map_state to inspect the map.",
  "Each browser tool result reports status, the Copilot handler output, structured data and the verified resulting state.",
  "copilot_raster_statistics, copilot_raster_difference, copilot_analytics_layers and the other copilot_* tools run on the server without a browser session.",
].join(" ");

function createMcpServer({ catalog, caller }) {
  const server = new Server(
    { name: "mmgis-copilot-mcp", title: "MMGIS Copilot", version: PLUGIN_VERSION },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: catalog.list() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!catalog.has(name)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    return catalog.call(name, args || {}, caller);
  });

  return server;
}

module.exports = { createMcpServer, INSTRUCTIONS };
