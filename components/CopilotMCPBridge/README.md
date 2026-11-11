# CopilotMCPBridge (component)

Browser half of the MMGIS Copilot MCP interface. When the
[CopilotMCP backend](../../backend/CopilotMCP/README.md) is enabled (`WITH_COPILOT_MCP=true`)
and the user is logged in, this component registers the page as a browser session for its
mission. It then runs the MCP commands sent to that session with the AgentChat Copilot's
own handlers, and reports the verified resulting map state.

* Enable it per mission (Configure → Components → **MMGIS MCP Bridge**, the manifest's
  `display_name`). The mission also needs the AgentChat tool; the manifest declares it and
  the CopilotMCP backend in `pluginDependencies`.
* Variables: `autoConnect` (default true), `showIndicator` (default true; the `MCP · …`
  indicator shows the state, and clicking it pauses or resumes MCP control of this page),
  `mirrorToCopilotPanel` (default false; when true, MCP output is also written into the chat
  history).
* Without the backend enabled it makes a single status request and stays dormant.

Files: `CopilotMCPBridge.js` (register, long-poll, acknowledge, report), `executor.js` (runs
commands with `tools/AgentChat` code), `capture.js` (handler output and analytics responses),
`stateSnapshot.js` / `stateDiff.js` (map state), `verifiers.js` (per-tool confirmation).
Unit tests: `tests/verifiers.spec.js` (`@unit`). Coverage: [COVERAGE.md](../../backend/CopilotMCP/COVERAGE.md).
