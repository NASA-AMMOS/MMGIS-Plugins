# MMGIS MCP

MMGIS MCP lets [Model Context Protocol](https://modelcontextprotocol.io) clients (VS Code, Claude,
any MCP SDK client) drive an MMGIS map with the same tools the MMGIS Copilot uses: list and toggle
layers, move the time slider, zoom, run raster statistics, and more. Map actions run in a live,
logged-in MMGIS browser tab and report the verified resulting state.

In the repository the pieces are named `CopilotMCP` (backend) and `CopilotMCPBridge` (component).
In Configure, the component card is labelled **MMGIS MCP Bridge**. The names in config files and
`plugin.json` are unchanged.

For the full tool list and failure codes see [README.md](README.md) and [COVERAGE.md](COVERAGE.md).

## How it fits together

```
MCP client ──Bearer token──▶ MMGIS MCP backend (/api/copilot-mcp/mcp)
                                   │
        server tools (copilot_*) ◀─┤  run on the backend, with the caller's credentials
        map tools (toggle_layer…) ─┘
                 │ queued per browser session
                 ▼
        MMGIS MCP Bridge (component in the open mission page)
                 └─ runs the Copilot handlers, reports before/after state
```

| Tool kind | Needs the MMGIS MCP Bridge and an open browser tab? |
| --------- | ---------------------------------------------------- |
| Map tools (`list_layers`, `toggle_layer`, `zoom_to`, `set_time`, …) | Yes |
| Session tools (`mmgis_get_map_state`, `mmgis_undo_last_action`) | Yes |
| Server tools (`copilot_*`: layer catalog, raster statistics, region resolver, …) | No |

## Requirements

- MMGIS 5.x with this plugin container installed, including the `Agent` backend and `AgentChat` tool
  (`WITH_AGENT=true`). An LLM is only needed for `copilot_ask` requests that go to the planner.
- Node.js 20 or newer.
- The MCP SDK installed inside the plugin (it is deliberately not hoisted to MMGIS's root
  `node_modules`; see the README):

  ```bash
  cd plugins/midatm1234--MMGIS-Plugins/backend/CopilotMCP && npm ci --omit=dev
  ```

## Enable it

1. **Activate the component** (adds the bridge to `src/pre/components.js`) from the MMGIS root:

   ```bash
   npm run plugins -- activate
   ```

2. **Turn it on in `.env`** and restart MMGIS:

   ```
   WITH_COPILOT_MCP=true
   COPILOT_MCP_ALLOW_REMOTE=false
   ```

   The log should show `Copilot MCP enabled at /api/copilot-mcp/mcp (local connections only).`
   Leave `COPILOT_MCP_ALLOW_REMOTE` at `false` unless other machines must connect.

3. **Add the bridge to each mission** you want clients to drive: Configure → mission →
   **Components** → **MMGIS MCP Bridge** → switch on → save. The mission also needs the
   **AgentChat** tool. Equivalent config JSON:

   ```json
   { "on": true, "name": "CopilotMCPBridge", "icon": "lan-connect", "js": "CopilotMCPBridge", "variables": {} }
   ```

4. **Create a long-term token**: Configure → **API Tokens**, or
   `POST /api/longtermtoken/generate` with an admin session. The token acts as the user who
   created it, so treat it like a password and never commit it.

5. **Open the mission in a browser** logged in as the same user. An `MCP · connected` indicator
   appears; click it to pause or resume MCP control of that page.

Per-mission settings (Components tab): *Auto Connect*, *Show Indicator*, and *Mirror to Copilot
Chat* (off by default).

## Connect a client

Node SDK example, from `backend/CopilotMCP`:

```bash
MMGIS_MCP_TOKEN=<token> node examples/mcp-client.mjs                  # list tools and sessions
MMGIS_MCP_TOKEN=<token> node examples/mcp-client.mjs toggle_layer '{"name":"<layer>","visible":true}'
```

VS Code (`.vscode/mcp.json`):

```json
{
  "inputs": [{ "type": "promptString", "id": "mmgis-token", "description": "MMGIS long-term token", "password": true }],
  "servers": {
    "mmgis": {
      "type": "http",
      "url": "http://localhost:8888/api/copilot-mcp/mcp",
      "headers": { "Authorization": "Bearer ${input:mmgis-token}" }
    }
  }
}
```

Typical flow: `mmgis_list_sessions` → (optional) `mmgis_get_map_state` → a map tool with
`session_id` (or `mission`) → `mmgis_undo_last_action`.

## Check that it is working

```bash
curl -s http://localhost:8888/api/copilot-mcp/status          # HTTP 200 when enabled
curl -s -X POST http://localhost:8888/api/copilot-mcp/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without a token the second call must return a JSON-RPC error saying authentication failed.
That is the expected result: the endpoint refuses unauthenticated callers.

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| `NO_BROWSER_SESSION` | No logged-in tab has the mission open, or the bridge is not enabled for that mission. |
| `AMBIGUOUS_BROWSER_SESSION` | More than one session matches; pass `session_id` or `mission` (see `mmgis_list_sessions`). |
| `SESSION_NOT_FOUND` / `MISSION_FORBIDDEN` | The tab is logged in as a different user than the token, or the user cannot view the mission. |
| HTTP 401 | Missing or invalid token. |
| HTTP 404 on `/api/copilot-mcp/status` | `WITH_COPILOT_MCP` is not `true`, or MMGIS was not restarted after changing it. |
| Cannot find module `@modelcontextprotocol/...` | The SDK is not installed; run `npm ci --omit=dev` in `backend/CopilotMCP`. |
| Bridge missing from Configure | Run `npm run plugins -- activate`, rebuild `configure/`, and restart. |

## Security notes

- Authentication uses MMGIS's own session and long-term-token gates; mission permissions apply to
  every call.
- Connections are local-only by default (`127.0.0.1` / `::1`, with a local `Host` and `Origin`).
- A browser session belongs to the user and Express session that registered it; other users'
  sessions behave as if they do not exist.
