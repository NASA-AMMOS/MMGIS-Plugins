# MMGIS Copilot → MCP coverage

This table maps every capability of the MMGIS Copilot (as implemented in this repository) to
its MCP tool or operation, with implementation and verification status. The inventory comes
from the code: `backend/Agent/tool-registry.json`, `backend/Agent/routes/agent.js`,
`tools/AgentChat/AgentChatTool.js`, `tools/AgentChat/renderers.js`,
`tools/AgentChat/agentActions.js` / `localCommands.js`, and the existing tests and demo queries.

**Verification baseline**: MMGIS `development` @ `c576fe49` (v5.4.6), MMGIS-Plugins `master` @
`d58f249b` plus this branch. Local install with an isolated PostGIS database, the `frozon` mission (EPSG:3413, local monthly freeboard COGs) and the built-in
`Reference-Mission` (EPSG:3857), in headless Chromium (SwiftShader WebGL).
The live run (`tests/live.spec.js`, 48 cases: 45 verified, 2 reproduced upstream
failures, 1 blocked on LLM credentials) is summarized in the pull request description.

## How capabilities were verified

| Mark | Meaning |
| ---- | ------- |
| **E** | **Live equivalence**: the existing Copilot chat ran the action in one browser session (only the LLM planner response was mocked, so the chat's own `exec()` ran) and MCP ran it in a second session of the same mission from the same starting state. The resulting map state (center/zoom, every layer's visibility/opacity/time window, global time, highlight overlay, analysis overlays, animation UI, active tool) and the Copilot output text were identical. The MCP result's own state verification passed where a state change is expected. |
| **P** | **Live endpoint parity**: the MCP server tool returned exactly the JSON of the corresponding Copilot backend endpoint, called directly with a browser session. |
| **U** | Covered by the `@unit` suites (session protocol, MCP over HTTP with simulated bridge pages, verifiers, shared AgentChat helpers). |
| **X** | Pre-existing Copilot limitation reproduced faithfully: the MCP result reports the same failure as the chat or endpoint. |
| **B** | Blocked in this environment by unavailable credentials or services (stated in the row). |

All browser-tool results share one structure (`structuredContent`): `status`, `tool`, `mission`,
`session_id`, `command_id`, `delivered_at`, `verification {verified, checks[], notes[]}`,
`output[]` (Copilot handler text), `data` (handler return value), `api_calls[]` (analytics/TiTiler
responses the handler used), `effects` (state diff), `state` (resulting state, visible layers),
`resolved_args`, `layer_matches[]`, `provenance`, `duration_ms`. Failures add
`error {code, message, details}` and set `isError`.
Dependencies common to all browser tools: CopilotMCP enabled, a logged-in MMGIS page of the
mission with the CopilotMCPBridge component and AgentChat tool, and the Agent backend
(`WITH_AGENT=true`) for registry and validation.

## A. Copilot registry tools (executed in a live browser session)

Inputs are the Copilot registry schema, validated with the Agent's own Ajv validators, plus
optional `session_id` and `mission` routing fields.

| # | Capability | Copilot implementation (entry point) | MCP tool | Inputs (required; optional) | Tool-specific output and checks | Extra dependencies | Impl. | Verified |
| - | ---------- | ------------------------------------ | -------- | --------------------------- | ------------------------------- | ------------------ | ----- | -------- |
| 1 | Layer discovery: list layers with on/off state | registry `list_layers` → `RENDERERS.layers_line` (`render_layers_line`, renderers.js) | `list_layers` | — | `output`: layer list with on/off | — | ✅ | E, U |
| 2 | Layer discovery: analyzable vs visualization-only layers | `list_analyzable_layers` → `RENDERERS.list_analyzable_layers` | `list_analyzable_layers` | — | `output`: data layers (COG/STAC, units, ranges) vs visualization layers | — | ✅ | E |
| 3 | Layer metadata summary | `describe_layer` → `RENDERERS.layer_summary` (`render_layer_summary`) | `describe_layer` | `name`: string | `data` incl. `actual_state` (true type/visibility/time from the map) + note when the handler's printed visibility is wrong | — | ✅ | E, U |
| 4 | Layer reference information (+ web-grounded fallback) | `layer_information` → `RENDERERS.layer_information` → `/api/agent/layer-info`, fallback `POST /api/agent` | `layer_information` | `layer_name`; optional `original_query` | `api_calls` show both upstream responses | Agent layer-info source file; LLM for fallback | ✅ | E, X (fails identically: layer-info reads `Missions/<mission>/config.json`, fallback omits `mission` → HTTP 400) |
| 5 | Layer control: visibility | `toggle_layer` → adapter `mmgisAPI.toggleLayer(uuid, visible)` (`execMmgisApi`, name → UUID, conflict rules) | `toggle_layer` | `name`, `visible`: boolean | check: layer visible = requested; `data.conflicts_turned_off`; undo entry | — | ✅ | E, U |
| 6 | Layer control: opacity | `set_layer_opacity` → `RENDERERS.opacity` (`set_opacity` → `L_.setLayerOpacity`) | `set_layer_opacity` | `name`, `opacity`: 0..1 | check: layer opacity = requested | — | ✅ | E, U |
| 7 | Map navigation: center + zoom | `zoom_to` (center form) → `RENDERERS.zoom_view` (`map.setView`) | `zoom_to` | `center`: [lon, lat], `zoom`: 0..22 | checks: map center and zoom; undo entry | — | ✅ | E (EPSG:3413), U |
| 8 | Map navigation: bounding box | `zoom_to` (bbox form) → `RENDERERS.zoom_view` (`map.fitBounds`) | `zoom_to` | `bbox`: [w, s, e, n] | check: center and zoom where Leaflet `fitBounds` puts the bbox (projection independent) | — | ✅ | E (EPSG:3413 and EPSG:3857) |
| 9 | Time selection (global and per layer, cadence snapping) | `set_time` → `RENDERERS.set_visible_layers_time` (`executeVisibleLayersTimeChange`) | `set_time` | `time`; optional `layers`: string[] | `data {ok, lines, updates[], skipped[]}`; checks: ≥1 layer updated, time windows changed; skipped layers as notes | time-enabled layers | ✅ | E, U |
| 10 | Threshold highlighting (raster expression overlay) | `threshold_highlight` → `RENDERERS.threshold_highlight` (TiTiler `expression` tiles) | `threshold_highlight` | `layer_name`, `variable`, `operator`; optional `value`, `value_min/max`, `unit`, `time*`, `geographical_area`, `name` | `data {expression, operator, source_url…}`; checks: overlay active with the handler's expression; note when `=`, `==` or `between` ran as another operator | TiTiler, local COG | ✅ | E, U |
| 11 | Highlight opacity adjust | `highlight_opacity` → `RENDERERS.highlight_opacity` | `highlight_opacity` | `delta`: number | check: overlay opacity; note when clamped to [0.05, 0.4] | existing highlight | ✅ | E, U |
| 12 | Highlight hide/show | `highlight_toggle` → `RENDERERS.highlight_toggle` | `highlight_toggle` | — | check: overlay opacity 0 / restored; `no_effect` without overlay | existing highlight | ✅ | E (hide and show), U |
| 13 | Highlight clear | `highlight_clear` → `RENDERERS.highlight_clear` | `highlight_clear` | — | check: overlay removed | — | ✅ | E, U |
| 14 | Statistics: regional mean/std/percentiles | `calculate_layer_mean` → `RENDERERS.layer_mean` → `GET /api/agent/analytics/statistics` (rasterio), fallback in-browser COG sampling; analysis area drawn | `calculate_layer_mean` | `layer_name`, `geographical_area`; optional `time_start/end` (date-time) | `data.stats`; checks: mean equals the analytics API response, area overlay drawn; `api_calls` | Agent analytics (Python/rasterio), local COG, region presets/resolver | ✅ | E, U |
| 15 | Comparison: pixel-wise layer difference | `calculate_layer_difference` → `RENDERERS.layer_difference` → `GET /api/agent/analytics/difference` | `calculate_layer_difference` | `layer_a`, `layer_b` | `data {mean, std, …}`; check: equals the analytics API response; turning on `layer_b` appears in `effects` | Agent analytics, local COGs | ✅ | E, U |
| 16 | Statistics: multi-layer + correlation | `multilayer_statistics` → `RENDERERS.multilayer_statistics` (in-browser COG sampling, geotiff.js) | `multilayer_statistics` | `layer_names`: string[≥2]; optional `geographical_area`, `time_range`, `include_correlation`, `include_visualization` | `data` per-layer stats + correlations; checks: results + area drawn | COGs readable by the browser | ✅ | E, U |
| 17 | Analysis: temporal trends | `temporal_trends` → `RENDERERS.temporal_trends` (COG sampling per time step) | `temporal_trends` | `layer_name`; optional `geographical_area`, `time_start/end`, `interval` | `data` series/trend; checks: results + area drawn | time-enabled COGs | ✅ | E, U |
| 18 | Spatial analysis: Moran's I, LISA hot/cold spots | `spatial_statistics` → `RENDERERS.spatial_statistics` | `spatial_statistics` | `layer_name`; optional `geographical_area`, `grid_size`, `analysis_type`, `visualize` | `data.spatialStats`; checks: results + hotspot overlay | COGs | ✅ | E, U |
| 19 | Comparison: change detection between two times | `change_detection` → `RENDERERS.change_detection` | `change_detection` | `layer_name`; optional `geographical_area`, `before_time`, `after_time`, `threshold`, `visualize` | `data` before/after stats, t-test; checks: results + area drawn | time-enabled COGs | ✅ | E, U |
| 20 | Anomaly detection | `detect_anomalies` → `RENDERERS.anomaly_detection` | `detect_anomalies` | `layer_name`; optional `geographical_area`, `method`, `threshold`, `time_*`, `visualize` | `provenance` + note **SIMULATED** (fixed placeholder statistics); `verified: null` | — | ✅ | E, X (simulated in the Copilot) |
| 21 | Animation: time-series animation with controls | `time_series_animation` → `RENDERERS.time_series_animation` | `time_series_animation` | `layer_name`; optional `time_start/end`, `interval`, `frame_rate`, `loop_mode`, `auto_play` | checks: animation created, controls shown; layers it disables appear in `effects` | time-enabled layer | ✅ | E, U |
| 22 | Export | `data_export` → `RENDERERS.data_export` | `data_export` | `layer_name`; optional `format`, `geographical_area`, `resolution`, `include_metadata`, `auto_download`, `time_range` | `data {status:'ready', …}`; `provenance` + note **SYNTHETIC** (generated values) | — | ✅ | E (output structure; values are random by design), X |
| 23 | Integration: Animation tool (GIF/MP4 export) | `open_animation_tool` → `RENDERERS.open_animation_tool` → `ToolController_.makeTool('AnimationTool')` | `open_animation_tool` | `layer_name`; optional `start_date`, `end_date`, `region`, `format` | check: active tool = AnimationTool; `CAPABILITY_UNAVAILABLE` when the mission lacks the tool | Animation tool in the mission | ✅ | E (Reference-Mission: opens), E + X (frozon: chat claims "opened", MCP reports unavailable, same state) |
| 24 | Integration: Analysis tool (time series/histogram/scatter) | `run_analysis` → `RENDERERS.run_analysis` → `ToolController_.makeTool('AnalysisTool')` + form prefill | `run_analysis` | `layer_name`; optional `chart_type`, `mode`, `start_date`, `end_date`, `region` | check: active tool = AnalysisTool; `CAPABILITY_UNAVAILABLE` when absent | Analysis tool in the mission | ✅ | E, U |

## B. Copilot backend operations (executed on the server, no browser session)

| # | Capability | Copilot implementation | MCP tool | Inputs | Output | Dependencies | Impl. | Verified |
| - | ---------- | ---------------------- | -------- | ------ | ------ | ------------ | ----- | -------- |
| 25 | Natural-language request → plan → execution | chat `onSend` → `callAgent` → `POST /api/agent?mission=` (LLM planner, `validateAction`) → `exec()` | `copilot_ask` | `message`; optional `mission`, `session_id`, `conversation_id`, `execute` (default true) | `{handled_locally, reply, text, citations, actions[], conversation_id, executed, results[] (one browser-tool result per action)}`; `execute:false` = plan only | Agent LLM provider (Azure AI Foundry or Gemini) | ✅ | U (planner + per-action execution in the targeted session, plan-only, upstream errors); **B** live: no LLM credentials (Azure CLI token expired, `AGENT_NAME`/`AGENT_VERSION` and `GEMINI_API_KEY` unset). MCP returns `UPSTREAM_ERROR` with the Agent's message. |
| 26 | Streaming planner | `POST /api/agent/stream` (SSE; not used by the chat UI) | covered by `copilot_ask` (same planner, non-streaming like the chat UI) | — | — | LLM | ✅ (via #25) | B |
| 27 | Tool registry | `GET /api/agent/tools` | `copilot_tool_registry` | — | `{count, tools[{name, description, adapter, ui_type, parameters}]}` | Agent | ✅ | P, U |
| 28 | Example (demo) queries / suggestion chips | `GET /api/agent/copilot/demo-queries` (chat chips) | `copilot_demo_queries` | — | `{queries[]}` | Agent | ✅ | P, U |
| 29 | Conversations: list / get / delete | `GET/DELETE /api/agent/conversations[/:id]` | `copilot_conversations` | `action`: list, get or delete; `mission` (list) or `conversation_id` | `{conversations[]}` / `{conversation}` / `{deleted}`; mission permission enforced | Agent DB | ✅ | P (list) |
| 30 | Layer reference info catalog | `GET /api/agent/layer-info` | `copilot_layer_info` | `mission`; optional `name` | endpoint JSON | `Missions/<mission>/config.json` | ✅ | P + X (endpoint returns 404 `LayerInfoUnavailable` for DB-stored missions; MCP mirrors it) |
| 31 | Region resolver (place/sea name → bbox) | `GET /api/agent/regions/resolve` (MarineRegions + built-ins) | `copilot_resolve_region` | `name`; optional `buffer_km` | `{label, bbox, …}` | MarineRegions.org | ✅ | P + X (Agent calls the retired `getGazetteerRecordsByNamesJSON.php` → 404; the chat's built-in presets such as "Beaufort Sea" still work in #14) |
| 32 | Analytics layer catalog | `GET /api/agent/analytics/layers` | `copilot_analytics_layers` | `mission` | `{count, layers[]}` | Agent | ✅ | P |
| 33 | Server raster statistics (full / bbox / named region) | `GET /api/agent/analytics/statistics` (Python/rasterio) | `copilot_raster_statistics` | `mission`, `layer_name`; optional `bbox` or `region` | `{statistics{mean, std, min, max, median, q25, q75, counts…}, region}` | Python env (`MMGIS_PYTHON`), local COG | ✅ | P (full and bbox), U |
| 34 | Server raster difference | `GET /api/agent/analytics/difference` | `copilot_raster_difference` | `mission`, `layer_a`, `layer_b`; optional `time`, `bbox` | `{difference{…}}` | Python env, COGs | ✅ | P |
| 35 | COG resolution for a layer/STAC collection | `GET /api/agent/analytics/resolve-cog` | `copilot_resolve_cog` | `mission`, `layer_name` | endpoint JSON | Agent | ✅ | P |

## C. Copilot chat behaviours outside the registry

| # | Capability | Copilot implementation | MCP exposure | Impl. | Verified |
| - | ---------- | ---------------------- | ------------ | ----- | -------- |
| 36 | Local command: MMGIS overview | `detectMmgisOverviewIntent` / `handleMmgisOverviewIntent` (`agentActions.js`), dispatched by `tryLocalCopilotCommand` | `copilot_ask` (`handled_locally: true`, no LLM call) | ✅ | E, U |
| 37 | Local command: preset region zoom ("zoom to point barrow", "… at zoom level N") | `detectZoomRegionIntent` / `LOCAL_REGION_VIEWS` | `copilot_ask` | ✅ | E, U |
| 38 | Local command: time slider ("set the time slider to March 2024", latest/earliest) | `detectFastTimeIntent` → `fast_visible_layers_time` | `copilot_ask` | ✅ | E, U |
| 39 | Undo last (toggles and zooms, 25 entries) | chat `undoLast()` / `pushUndo()` | `mmgis_undo_last_action`, `copilot_ask "undo last"` (MCP actions in that session) | ✅ | E (3 undos restore the start state; empty stack is `no_effect`), U |
| 40 | Layer-name resolution (aliases, fuzzy match, ambiguity) | `prepareActionLayerArgs` + `layerResolver` (shared `agentActions.js`) | applied to every registry tool; ambiguity is `INVALID_INPUT` with candidates; `layer_matches` in results | ✅ | E, U |
| 41 | Mission conflict rules (`window.mmgisAgentLayerConflicts`) | `applyLayerConflictRules` (shared) after `toggleLayer` | same function in the MCP `mmgisAPI` adapter; `data.conflicts_turned_off` | ✅ | U |
| 42 | Planner layer context | `collectAgentLayers` / `buildAgentContextFromLayers` (shared) | `copilot_ask` sends the session's identical context | ✅ | U |
| 43 | Layer time announcement when a time-enabled layer turns on | chat listener `handleLayerVisibilityChange` → `formatLayerTimeAnnouncement` (system message) | the same listener still runs in the page; MCP results carry the layer time window in `state`/`effects` | ✅ | E (state includes per-layer time windows) |
| 44 | Planner tools named in the prompt but not implemented (vessel tools, `visualize_contours`) | none (no registry entry or renderer) | not exposed: nothing to expose | — | — |

## D. MCP interface infrastructure

| # | Capability | Implementation | Verified |
| - | ---------- | -------------- | -------- |
| 45 | Discovery (`tools/list`: 23 registry + 13 server/session tools, annotations, routing-aware schemas incl. `oneOf` branches) | `lib/catalog.js`, `lib/registry.js`, `lib/mcpServer.js` | live (all registry tools listed), U |
| 46 | Session listing and map state | `mmgis_list_sessions`, `mmgis_get_map_state` | live, U |
| 47 | Routing by `session_id` / `mission`; ambiguity and no-session errors without executing | `lib/sessions.js` `select()` | live, U |
| 48 | Acknowledged delivery: commands run only after the page acknowledges them; unacknowledged ones are re-handed or withdrawn (`NOT_DELIVERED`, nothing ran); `RESULT_TIMEOUT`/`SESSION_CLOSED` report unknown outcomes | `lib/sessions.js`, `routes/bridge.js`, `CopilotMCPBridge.js` | U |
| 49 | Isolation: other session of the same mission, other mission, other user | session ownership + secret + Express session binding | live (25 MCP calls left an idle `frozon` session and a `Reference-Mission` session unchanged; second user sees no sessions and gets `SESSION_NOT_FOUND`), U |
| 50 | Permissions: every route declared with `s.authorize` (`site.view` / `mission.view`); signed-in callers only (401 JSON-RPC for guests and invalid tokens); mission checks with `s.can` for the caller's principal, so token scopes and missions apply, including to browser sessions (`MISSION_FORBIDDEN`); loopback-only + DNS-rebinding checks; POST-only stateless endpoint | `lib/access.js`, `lib/mount.js`, `routes/mcp.js`, `routes/bridge.js` | U (scoped-token and route-declaration tests); live before the `s.authorize` change (token and cookie clients) |
| 51 | Disabled by default: no routes, no SDK loaded; bridge dormant | `plugin.js`, `CopilotMCPBridge.start()` | U; live baseline: the 24 MMGIS/Copilot/plugin checks give identical results without MCP, with MCP disabled and with MCP enabled (see below) |
| 52 | Liveness: closed tabs and proxied disconnects are detected (grace) instead of lingering | `lib/sessions.js` | U; live: a killed browser's session behind the dev-server proxy disappeared after ~50 s (poll hold + grace), and later calls get `SESSION_NOT_FOUND` |

## Pre-existing Copilot issues observed

These exist in the Copilot itself. MCP reports them as they are and does not change them:

1. `detect_anomalies` returns fixed placeholder statistics (labelled **SIMULATED**).
2. `data_export` exports generated random values, not raster pixels (labelled **SYNTHETIC**).
3. `threshold_highlight` implements only `>`, `>=`, `<` and `<=`; `=`, `==` and `between` are executed as `>`. MCP adds a note.
4. `describe_layer` prints `Type: Unknown` and may print the wrong visibility. MCP adds `data.actual_state` and a note.
5. `layer_information`: `/api/agent/layer-info` reads `Missions/<mission>/config.json`, which MMGIS 5 database missions do not have; its fallback `POST /api/agent` omits `mission` and gets HTTP 400.
6. Region resolver: the Agent calls MarineRegions' retired `getGazetteerRecordsByNamesJSON.php` (404). The renderers' built-in area presets still work.
7. `open_animation_tool` reports "Animation Tool opened" even when the mission lacks the Animation tool. MCP returns `CAPABILITY_UNAVAILABLE`.
8. Layer resolution with multi-layer messages: when the user's message names several layers, `resolveLayerSelection` resolves every layer argument to the first one named. For example, "difference between SWOT freeboard and ICESat-2 freeboard" compares SWOT with itself. The chat and `copilot_ask` (which passes the message like the chat) behave identically; direct MCP tool calls resolve by the given names.
9. `calculate_layer_difference` formats differences as percentages, for example freeboard metres as "-17.39%". The raw values are in `data`/`api_calls`.
10. The Agent's conversation endpoints have no per-user ownership check. `copilot_conversations` adds a mission-permission check.
11. The Agent's planner prompt mentions tools that are not implemented (#44).

## Baseline with MCP disabled and enabled

The same 24 checks ran three times against `frozon`: before any change, after this branch
with `WITH_COPILOT_MCP=false`, and with `WITH_COPILOT_MCP=true`. The checks cover login, app
load (WebGL), layer configs, vector features, tiles, navigation, layer toggle, local COG tiles
via TiTiler, the time control, the Copilot registry/demo queries/analytics layers/raster
statistics endpoints, the Copilot panel and suggestion chips, the Layers, Legend, Info, Draw,
Identifier and Analysis tools, and the Workflows backend.

| Run | PASS | KNOWN (pre-existing) | FAIL | New errors |
| --- | ---- | -------------------- | ---- | ---------- |
| Original baseline (no changes) | 21 | 3 | 0 | — |
| This branch, MCP disabled | 21 | 3 | 0 | one `GET /api/copilot-mcp/status` 404 per page load on missions with the bridge enabled (dormancy probe) |
| This branch, MCP enabled | 21 | 3 | 0 | none |

The three KNOWN items are the region resolver, the layer-info endpoint and the LLM answer
(no credentials). They are identical in all runs.

## MCP-specific notes

* The MCP undo stack covers MCP actions in that browser session, with the chat's semantics.
  The chat's own stack is private to the chat.
* Only successfully verified toggles and zooms are recorded for undo. The chat records any
  handler that did not throw.
* In a background tab the browser pauses animation frames. MCP commands there move the map
  without animation, using Leaflet's own `animate:false` option, and say so in
  `verification.notes`.
* The webpack dev server's proxy hides client disconnects. Sessions behind it are closed by
  the liveness grace (`COPILOT_MCP_LIVENESS_GRACE_MS`) instead of instantly.
