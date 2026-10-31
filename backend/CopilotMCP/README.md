# CopilotMCP — Model Context Protocol interface for the MMGIS Copilot

CopilotMCP exposes every capability of the MMGIS Copilot (the `Agent` backend and
`AgentChat` tool in this repository) to [Model Context Protocol](https://modelcontextprotocol.io)
clients such as VS Code, Claude or any MCP SDK client. It is **disabled by default**
and does not change MMGIS, the Copilot or any other plugin unless `WITH_COPILOT_MCP=true`.

It consists of two plugins and two shared AgentChat modules:

| Part | Path | Role |
| ---- | ---- | ---- |
| CopilotMCP (backend) | `backend/CopilotMCP/` | Streamable HTTP MCP server at `{ROOT_PATH}/api/copilot-mcp/mcp`, browser-session registry and bridge API. Built with the official `@modelcontextprotocol/sdk`. |
| CopilotMCPBridge (component) | `components/CopilotMCPBridge/` | Runs in a logged-in MMGIS page of a mission. Executes MCP commands with the Copilot's own handlers and reports the verified resulting map state. |
| Shared Copilot code | `tools/AgentChat/agentActions.js`, `tools/AgentChat/localCommands.js` | Layer resolution, conflict rules, planner context and local fast-path commands, moved verbatim out of `AgentChatTool.js` so the chat and MCP use identical code. |

See [COVERAGE.md](COVERAGE.md) for the capability-to-MCP coverage table and verification status.

```
MCP client ──POST /api/copilot-mcp/mcp (Bearer token)──▶ CopilotMCP backend
                                                         │
     server tools (copilot_*) ◀── loopback with the ─────┤  Agent API: /api/agent, /api/agent/analytics/*, …
                                  caller's credentials   │
     browser tools (registry tools, mmgis_*) ────────────┘
         │ queued per browser session
         ▼
  CopilotMCPBridge in the user's MMGIS page ──long-poll / ack / result──▶ CopilotMCP backend
         │ runs AgentChat handlers (RENDERERS / window.mmgisAPI) exactly like the chat
         └─ snapshots the map before/after → verification → MCP tool result
```

## How tools execute

* **Copilot registry tools** (`list_layers`, `toggle_layer`, `zoom_to`, `set_time`,
  `threshold_highlight`, `calculate_layer_mean`, …, 23 in total) have the same names and
  input schemas as the Copilot registry (`backend/Agent/tool-registry.json`) plus two
  optional routing fields, `session_id` and `mission`. Inputs are validated with the Agent
  plugin's own compiled Ajv validators, the same `validateAction()` rules the Copilot
  planner uses. The validated arguments are then executed in a live browser session:
  `mmgisAPI` adapters through `window.mmgisAPI` with the chat's argument mapping and
  conflict rules, and custom adapters through the same `RENDERERS[execution.ui.type]`
  handler the chat calls.
* **Server tools** (`copilot_*`) run the Copilot backend operations (planner, raster
  statistics and difference, analytics layer catalog, COG resolution, region resolver,
  layer info, conversations, registry, example queries) by calling the Agent plugin's HTTP
  API in-process, with the MCP caller's credentials. MMGIS authentication, mission
  permissions and rate limits apply unchanged.
* **Session tools** (`mmgis_list_sessions`, `mmgis_get_map_state`, `mmgis_undo_last_action`)
  list the caller's browser sessions, read a session's map state, and undo MCP actions.

A browser command is **never reported as done because it was queued**. The page
acknowledges each command it receives and runs only acknowledged commands. The MCP
result is returned only after the page reports what the handler did:

* `status` is `succeeded`, `failed`, `no_effect` or `error`.
* `verification` lists the checks against the before/after state snapshot, for example
  the layer is visible, the map center/zoom match, the highlight expression is active, or
  a statistic equals the analytics API response.
* `output` holds the Copilot handler's text and `data` its structured return value.
* `api_calls` lists the analytics responses used.
* `effects` is the state diff and `state` the resulting map state.
* `provenance` labels results the existing handlers compute in-browser, simulate or
  synthesize.

Failures carry an `error.code`:

| Code | Meaning |
| ---- | ------- |
| `INVALID_INPUT` | Arguments rejected by the Copilot planner's schema/validator, or a layer name the Copilot cannot resolve. |
| `NO_BROWSER_SESSION` / `AMBIGUOUS_BROWSER_SESSION` | No (or more than one) connected session matches; pass `session_id`/`mission` (see `mmgis_list_sessions`). |
| `SESSION_NOT_FOUND` / `MISSION_MISMATCH` / `MISSION_FORBIDDEN` | Unknown or other user's session; session shows another mission; mission not viewable by the caller. |
| `NOT_DELIVERED` | The session did not receive/acknowledge the command in time; it was withdrawn and **nothing ran**. |
| `RESULT_TIMEOUT` / `SESSION_CLOSED` | The page received the command but reported no result / closed; the outcome is reported as unknown. |
| `EXECUTION_FAILED` | The handler failed or the resulting state does not match the request. |
| `CAPABILITY_UNAVAILABLE` | E.g. Agent backend not running, or a tool (Animation) not enabled in the mission. |
| `UPSTREAM_ERROR` | The Copilot backend endpoint failed (HTTP status and details included). |

Unknown tool names are JSON-RPC errors (`-32602`), as the MCP specification requires.

## Requirements

* MMGIS 5.x (verified with MMGIS `development` @ `c576fe49`, v5.4.6) and this plugin container
  installed through the MMGIS plugin CLI.
* The `Agent` backend and `AgentChat` tool plugins (`WITH_AGENT=true`). LLM credentials are only
  needed for `copilot_ask` requests that go to the planner. All registry, server and session
  tools work without an LLM.
* Node.js ≥ 20 (MMGIS `.nvmrc` pins 22.20.0).

## Installation

From the MMGIS root:

```bash
# 1. Install this container with the MMGIS plugin CLI (a git clone under plugins/)
npm run plugins -- install https://github.com/midatm1234/MMGIS-Plugins.git
npm run plugins:install            # root-level deps of the other plugins

# 2. Install CopilotMCP's own runtime dependency (the MCP SDK) inside the plugin
cd plugins/midatm1234--MMGIS-Plugins/backend/CopilotMCP && npm ci --omit=dev && cd -

# 3. Activate the component (adds CopilotMCPBridge to src/pre/components.js) and build
npm run plugins -- activate
npm run build                      # not needed for `npm start` (dev server builds on the fly)
```

The SDK is installed **plugin-locally on purpose**. Declaring it in `plugin.json` would make
`install-plugin-deps` hoist the SDK's `ajv@8` into MMGIS's root `node_modules`. That
changes how the Agent plugin validates Copilot actions (for example, `date-time` formats
would stop being enforced). The plugin's `node_modules/` is git-ignored, and its HTTP
routes use MMGIS's own Express instance.

Then enable it:

1. In `.env` set `WITH_COPILOT_MCP=true` and restart MMGIS. The log shows
   `Copilot MCP enabled at /api/copilot-mcp/mcp (local connections only).`
2. Enable the **CopilotMCPBridge** component for each mission that MCP clients should drive
   (Configure → mission → Components). Equivalent config JSON:
   `{"on": true, "name": "CopilotMCPBridge", "icon": "lan-connect", "js": "CopilotMCPBridge", "variables": {}}`.
   The mission must also have the **AgentChat** tool.
3. Create a long-term token for the MCP client. Use Configure → API Tokens, or call the
   endpoint with an admin session:
   `curl -b admin.cookies -H 'Content-Type: application/json' -d '{"name":"mcp","period":"never"}' http://localhost:8888/api/longtermtoken/generate`.
   The token acts as the admin user who created it.
4. Open the mission in a browser and log in as the **same user** as the token. A small
   `MCP · connected` indicator appears; click it to pause or resume MCP control of that page.

With `WITH_COPILOT_MCP` unset or `false`, the plugin mounts no routes and does not load
the SDK. On missions where the bridge component is enabled, each page load makes one
`GET /api/copilot-mcp/status` request. It returns 404, and the component then stays dormant.

### Configuration (`.env`)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `WITH_COPILOT_MCP` | `false` | Enables the MCP endpoint and bridge. |
| `COPILOT_MCP_ALLOW_REMOTE` | `false` | Accept non-loopback connections. By default requests must come from 127.0.0.1/::1 with a local `Host` and `Origin` and no non-local `X-Forwarded-For`, which also blocks DNS rebinding. |
| `COPILOT_MCP_POLL_TIMEOUT_MS` | `25000` | Long-poll hold time for browser sessions. |
| `COPILOT_MCP_DELIVERY_TIMEOUT_MS` | `15000` | Max wait for a session to receive and acknowledge a command; it is then withdrawn unexecuted (extended while the page runs an earlier command). |
| `COPILOT_MCP_RESULT_TIMEOUT_MS` | `120000` | Max wait for an acknowledged command's result (analysis tools use at least 180000). |
| `COPILOT_MCP_LIVENESS_GRACE_MS` | `20000` | A session with no open poll, no running command and no request for this long is closed (tab closed, crashed, or a proxy hid the disconnect). |
| `COPILOT_MCP_MAX_SESSIONS_PER_USER` | `10` | Browser sessions kept per user. |

### Security model

* **Authentication**: MMGIS's own `ensureUser()` and `stopGuests` gates (the Copilot's
  `/api/agent` gates) protect the MCP endpoint. Use `Authorization: Bearer <long-term token>`
  or an MMGIS session cookie. Failures return HTTP 401 with a JSON-RPC error.
* **Mission permissions**: every mission-scoped call is checked against MMGIS's
  `/api/configure/missions` for the caller, and server tools forward the caller's
  credentials to the Agent API.
* **Session boundaries**: browser sessions belong to the MMGIS user and Express session
  that registered them. Bridge requests need that login plus a per-session secret. Another
  user's session behaves as if it did not exist (`SESSION_NOT_FOUND`), and `mmgis_list_sessions`
  only shows the caller's own sessions.
* **Local by default**: see `COPILOT_MCP_ALLOW_REMOTE`. The endpoint is stateless
  (`POST` only, JSON responses), and each request gets its own MCP server bound to the caller.
* **Visibility**: the page indicator shows which mission and session MCP controls.
  MCP command output is not written into the user's chat history unless
  `mirrorToCopilotPanel` is set.

## Local development environment (micromamba `mmgis-mcp`)

The environment specification lives in [`environment/`](environment):
`mmgis-mcp.yml` (derived from MMGIS `python-environment.yml` + `.nvmrc` + PostGIS),
an osx-arm64 explicit lock file, and the pip requirements.

```bash
# Create the env (explicit lock = exact, offline-friendly; or use the .yml on other platforms)
micromamba create -y -n mmgis-mcp -f environment/mmgis-mcp-osx-arm64.explicit.txt
micromamba run -n mmgis-mcp python -m pip install -r environment/mmgis-mcp-pip-requirements.txt
# other platforms: micromamba create -y -f environment/mmgis-mcp.yml

# Isolated PostgreSQL + PostGIS cluster for development (port 5434, never the system cluster)
export DEV=$HOME/mmgis-mcp-dev PGDATA=$HOME/mmgis-mcp-dev/pgdata
ENV_PREFIX=$(micromamba run -n mmgis-mcp python -c 'import sys; print(sys.prefix)')
mkdir -p "$DEV" && (umask 077; printf '%s' "<db password>" > "$DEV/.dbpass")
micromamba run -n mmgis-mcp initdb -D "$PGDATA" -U mmgis_mcp --pwfile="$DEV/.dbpass" --auth=scram-sha-256
printf "listen_addresses = 'localhost'\nport = 5434\nextension_control_path = '\$system:%s/share/postgresql'\n" "$ENV_PREFIX" >> "$PGDATA/postgresql.conf"
micromamba run -n mmgis-mcp pg_ctl -D "$PGDATA" -l "$DEV/postgres.log" start
PGPASSWORD="$(cat "$DEV/.dbpass")" micromamba run -n mmgis-mcp createdb -h 127.0.0.1 -p 5434 -U mmgis_mcp mmgis_mcp   # role-named DB used by init-db
```

In MMGIS `.env` (start from `sample.env`), set `DB_HOST=127.0.0.1`, `DB_PORT=5434`,
`DB_NAME=<dev database>`, `DB_USER=mmgis_mcp`, `DB_PASS=…`, a `SECRET` of at least 24
characters, `WITH_AGENT=true`, `MMGIS_PYTHON=<env>/bin/python`, `WITH_STAC=true`,
`WITH_TITILER=true` and `WITH_COPILOT_MCP=true`. The adjacent servers (`adjacent-servers/*/.env`)
must point at the same cluster. Then run:

```bash
cd <MMGIS root>
npm ci && (cd configure && npm ci && npm run build)
micromamba run -n mmgis-mcp npm start      # API + MCP on :8888, app on http://localhost:8889
```

Always start MMGIS through `micromamba run -n mmgis-mcp …` (or an activated env). A shell
that exports `PROJ_LIB`/`GDAL_DATA` from another environment breaks TiTiler's projections.

## Connecting an MCP client

**Node SDK** (verified; [`examples/mcp-client.mjs`](examples/mcp-client.mjs)):

```bash
cd plugins/midatm1234--MMGIS-Plugins/backend/CopilotMCP
MMGIS_MCP_TOKEN=<token> node examples/mcp-client.mjs                       # list tools + sessions
MMGIS_MCP_TOKEN=<token> node examples/mcp-client.mjs toggle_layer '{"name":"SWOT freeboard","visible":true}'
MMGIS_MCP_TOKEN=<token> node examples/mcp-client.mjs copilot_raster_statistics '{"mission":"frozon","layer_name":"SWOT freeboard","region":"Beaufort Sea"}'
```

**VS Code** (`.vscode/mcp.json`, see [`examples/vscode-mcp.json`](examples/vscode-mcp.json)):

```json
{
  "inputs": [{ "type": "promptString", "id": "mmgis-token", "description": "MMGIS long-term token", "password": true }],
  "servers": {
    "mmgis-copilot": {
      "type": "http",
      "url": "http://localhost:8888/api/copilot-mcp/mcp",
      "headers": { "Authorization": "Bearer ${input:mmgis-token}" }
    }
  }
}
```

**Raw JSON-RPC** (stateless endpoint, no `initialize` needed for a single call):

```bash
curl -s http://localhost:8888/api/copilot-mcp/mcp \
  -H "Authorization: Bearer $MMGIS_MCP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mmgis_list_sessions","arguments":{}}}'
```

Typical flow: `mmgis_list_sessions` → (optional) `mmgis_get_map_state` → registry tools with
`session_id` (or `mission`, or nothing when exactly one session is connected) →
`mmgis_undo_last_action`. `copilot_ask` accepts free text like the chat. `undo last` and the
chat's local commands run without an LLM, and other requests are planned by the Copilot
planner and executed in the session (`execute: false` returns the plan only).

## Tests

Unit and HTTP integration tests (no MMGIS server, database or browser needed). These
cover the session registry and acknowledgement protocol, config, the auth/loopback gates,
the MCP endpoint through the SDK client with simulated bridge pages, the bridge verifiers,
and the shared AgentChat helpers:

```bash
# from the MMGIS root
npm run test:plugins:unit
# or only this feature
npx cross-env PLAYWRIGHT_TEST_UNIT_ONLY=true npx playwright test \
  plugins/midatm1234--MMGIS-Plugins/backend/CopilotMCP/tests \
  plugins/midatm1234--MMGIS-Plugins/components/CopilotMCPBridge/tests \
  plugins/midatm1234--MMGIS-Plugins/tools/AgentChat/tests --grep @unit
```

Live end-to-end verification against a running MMGIS with `WITH_COPILOT_MCP=true` and the
bridge enabled on the `frozon` mission and `Reference-Mission`. For every Copilot registry
tool it runs the existing chat in one browser session (only the LLM planner response is
mocked, so the chat's own `exec()` runs) and MCP in another, and compares the resulting map
state and output. It also checks that idle sessions, another mission and another user are
unaffected, that the server tools match the Copilot endpoints, and local commands and undo:

```bash
COPILOT_MCP_LIVE=1 PLAYWRIGHT_TEST_UNIT_ONLY=true \
MMGIS_USER=<user> MMGIS_PASSWORD=<password> MMGIS_MCP_TOKEN=<token of that user> \
MMGIS_USER2=<second non-admin user> MMGIS_PASSWORD2=<password> \
COPILOT_MCP_LIVE_REPORT=/tmp/copilot-mcp-live.json \
npx playwright test plugins/midatm1234--MMGIS-Plugins/backend/CopilotMCP/tests/live.spec.js --workers=1
```

(`PLAYWRIGHT_TEST_UNIT_ONLY=true` skips MMGIS's global test setup, which would otherwise start
a separate test server and database.)

## Limitations

Pre-existing Copilot issues stay visible: MCP reports them, it does not hide them. They are
detailed in [COVERAGE.md](COVERAGE.md#pre-existing-copilot-issues-observed). In short:
`detect_anomalies` is simulated, `data_export` is synthetic, `layer_information` cannot read
database-only missions, the region resolver's MarineRegions endpoint is retired, and
`open_animation_tool` claims success when the mission lacks the Animation tool. MCP
`undo` covers MCP actions in that session; the chat's own undo stack is private to the chat.
