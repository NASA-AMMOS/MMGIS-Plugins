// MCP exposure of the MMGIS Copilot registry tools. Every registry tool is
// executed in a live MMGIS browser session by the CopilotMCPBridge component,
// through the same AgentChat handlers the Copilot uses (window.mmgisAPI adapter
// or RENDERERS[execution.ui.type]); the browser reports the handler output and
// the verified resulting map state.

const { CopilotMcpError, ERROR_CODES, toolSuccess, toolError } = require("./results");

// Data provenance of each Copilot handler, from the capability inventory.
const PROVENANCE = Object.freeze({
  calculate_layer_mean: "server raster statistics (/api/agent/analytics/statistics, rasterio); falls back to in-browser COG sampling",
  calculate_layer_difference: "server raster difference (/api/agent/analytics/difference, rasterio)",
  multilayer_statistics: "in-browser COG pixel sampling (geotiff.js)",
  temporal_trends: "in-browser COG pixel sampling per time step (geotiff.js)",
  spatial_statistics: "in-browser COG pixel sampling (geotiff.js)",
  change_detection: "in-browser COG pixel sampling at two times (geotiff.js)",
  detect_anomalies: "SIMULATED: the existing Copilot handler reports fixed placeholder statistics, not raster data",
  data_export: "SYNTHETIC: the existing Copilot handler exports generated sample values, not raster data",
  threshold_highlight: "TiTiler expression overlay on the layer's COG",
});

const READ_ONLY = new Set(["list_layers", "list_analyzable_layers", "describe_layer", "layer_information"]);
const IDEMPOTENT = new Set(["toggle_layer", "set_layer_opacity", "zoom_to", "set_time", "highlight_clear", "threshold_highlight"]);
const LONG_RUNNING = new Set([
  "calculate_layer_mean",
  "calculate_layer_difference",
  "multilayer_statistics",
  "temporal_trends",
  "spatial_statistics",
  "change_detection",
  "time_series_animation",
  "data_export",
  "run_analysis",
]);

function describeTool(spec) {
  const ui = spec.execution && spec.execution.ui && spec.execution.ui.type;
  const adapter = spec.execution && spec.execution.adapter;
  const how = adapter === "mmgisAPI"
    ? `window.mmgisAPI.${spec.execution.method}()`
    : `the Copilot '${ui}' handler`;
  const parts = [
    spec.description || spec.name,
    `MMGIS Copilot tool executed in a connected MMGIS browser session via ${how}; returns the handler output and the verified resulting state.`,
  ];
  if (PROVENANCE[spec.name]) parts.push(`Data: ${PROVENANCE[spec.name]}.`);
  return parts.join(" ");
}

function annotationsFor(spec) {
  return {
    title: `Copilot: ${spec.name.replace(/_/g, " ")}`,
    readOnlyHint: READ_ONLY.has(spec.name),
    destructiveHint: false,
    idempotentHint: IDEMPOTENT.has(spec.name),
    openWorldHint: spec.name === "layer_information",
  };
}

function executionSpec(spec) {
  const x = spec.execution || {};
  return {
    adapter: x.adapter || null,
    method: x.method || null,
    argOrder: Array.isArray(x.argOrder) ? x.argOrder : [],
    nameResolution: x.nameResolution || null,
    uiType: (x.ui && x.ui.type) || null,
  };
}

function timeoutFor(name, cfg) {
  return LONG_RUNNING.has(name) ? Math.max(cfg.resultTimeoutMs, 180000) : cfg.resultTimeoutMs;
}

// Builds the MCP result from the browser's report. A handler failure, a
// failed verification or an unresolvable layer is a tool error.
function browserResult({ tool, session, payload }) {
  const status = payload.status || (payload.ok ? "succeeded" : "failed");
  const structured = {
    status,
    tool,
    mission: session.mission,
    session_id: session.id,
    command_id: payload.commandId,
    delivered_at: payload.deliveredAt ? new Date(payload.deliveredAt).toISOString() : null,
    verification: payload.verification || null,
    output: payload.output || [],
    data: payload.returnValue === undefined ? null : payload.returnValue,
    api_calls: payload.apiCalls || [],
    effects: payload.effects || null,
    state: payload.state || null,
    resolved_args: payload.resolvedArgs || null,
    layer_matches: payload.layerMatches || [],
    provenance: PROVENANCE[tool] || null,
    duration_ms: payload.durationMs,
  };
  if (status === "failed" || status === "no_effect") {
    const err = new CopilotMcpError(
      payload.error && payload.error.code && ERROR_CODES[payload.error.code] ? payload.error.code : ERROR_CODES.EXECUTION_FAILED,
      (payload.error && payload.error.message) || `Copilot tool '${tool}' failed in the browser session.`,
      payload.error && payload.error.details
    );
    return toolError(err, structured);
  }
  const verified = payload.verification && payload.verification.verified;
  const summary = `${tool}: ${status}${verified === true ? " (state verified)" : verified === false ? " (state NOT verified)" : ""} in session ${session.id} [${session.mission}]`;
  return toolSuccess(structured, summary);
}

module.exports = { PROVENANCE, describeTool, annotationsFor, executionSpec, timeoutFor, browserResult };
