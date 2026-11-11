#!/usr/bin/env node
// Minimal MCP client for the MMGIS Copilot MCP endpoint (official SDK).
//
//   MMGIS_MCP_URL=http://localhost:8888/api/copilot-mcp/mcp \
//   MMGIS_MCP_TOKEN=<MMGIS long-term token> \
//   node examples/mcp-client.mjs [tool] ['{"json":"args"}']
//
// Without arguments it lists the tools and the caller's browser sessions.
// Run from backend/CopilotMCP after `npm run plugins:install` in the MMGIS root.
// Use a token of a dedicated non-admin user, limited to the missions it needs.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const url = new URL(process.env.MMGIS_MCP_URL || 'http://localhost:8888/api/copilot-mcp/mcp')
const token = process.env.MMGIS_MCP_TOKEN
if (!token) {
    console.error('Set MMGIS_MCP_TOKEN to an MMGIS long-term token (Configure → API Tokens).')
    process.exit(2)
}

const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
})
const client = new Client({ name: 'mmgis-mcp-example', version: '0.1.0' })
await client.connect(transport)

const [tool, rawArgs] = process.argv.slice(2)
if (!tool) {
    const { tools } = await client.listTools()
    console.log(`${tools.length} tools:`)
    for (const t of tools) console.log(`  ${t.name.padEnd(28)} ${t.description.split('. ')[0]}`)
    const sessions = await client.callTool({ name: 'mmgis_list_sessions', arguments: {} })
    console.log('\nmmgis_list_sessions ->', JSON.stringify(sessions.structuredContent, null, 2))
} else {
    const result = await client.callTool({ name: tool, arguments: rawArgs ? JSON.parse(rawArgs) : {} })
    console.log(JSON.stringify({ isError: !!result.isError, structuredContent: result.structuredContent }, null, 2))
}
await client.close()
