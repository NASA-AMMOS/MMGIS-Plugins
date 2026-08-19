require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  haveFasEnv,
  runAgentMessage,
  continueAgentRun,
  streamAgentMessage,
  extractOutputText,
  extractFunctionCalls,
} = require("./azureService");
const { redactSensitiveText } = require("./toolResults");
const gemini = require("./geminiService");

function inferToolCategory(name) {
  if (
    /stat|mean|analyzable|anomal|change|analysis|trend|difference|threshold/.test(
      name,
    )
  ) {
    return "analytics";
  }
  if (/zoom|map|region/.test(name)) return "map-navigation";
  if (/time|temporal|animation/.test(name)) return "temporal";
  if (/layer|opacity|highlight|contour/.test(name)) return "layers-visualization";
  if (/export/.test(name)) return "data";
  return "application";
}

function loadRegistry() {
  const registryPath = path.join(__dirname, "tool-registry.json");
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch (error) {
    // Keep the message generic (no absolute paths); detail goes to server logs.
    const err = new Error("Unable to read tool registry.");
    err.code = "ToolRegistryReadError";
    err.detail = `${registryPath}: ${error.message}`;
    err.cause = error;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tools)) {
      throw new Error("Registry must provide a 'tools' array.");
    }
    return {
      ...parsed,
      tools: parsed.tools.map((tool) => ({
        ...tool,
        category: tool.category || inferToolCategory(tool.name),
      })),
    };
  } catch (error) {
    const err = new Error("Invalid tool registry JSON.");
    err.code = "ToolRegistryParseError";
    err.detail = `${registryPath}: ${error.message}`;
    err.cause = error;
    throw err;
  }
}

// Default registry loaded from file at startup; can be overridden at call time
// with live registry from app.locals (for dynamic tool registration).
const _defaultRegistry = loadRegistry();
const _defaultToolsList = _defaultRegistry.tools || [];
const _defaultToolNames = new Set(_defaultToolsList.map((t) => t.name));
const _defaultToolNameList = _defaultToolsList.map((t) => t.name).sort();

function formatToolDescription(tool) {
  const category = tool.category ? ` | category: ${tool.category}` : "";
  const plugin = tool.plugin ? ` | plugin: ${tool.plugin}` : "";
  const analyticsOperations = Array.isArray(tool.analytics?.operations)
    ? tool.analytics.operations.join(", ")
    : "";
  const analyticsDataKinds = Array.isArray(tool.analytics?.dataKinds)
    ? tool.analytics.dataKinds.join(", ")
    : "";
  const analyticsRequiresScalar =
    typeof tool.analytics?.requiresScalar === "boolean"
      ? tool.analytics.requiresScalar
      : null;
  const analytics =
    analyticsOperations ||
    analyticsDataKinds ||
    analyticsRequiresScalar !== null
      ? ` | analytics applicability: operations [${analyticsOperations || "unspecified"}], data kinds [${analyticsDataKinds || "unspecified"}], requires scalar: ${analyticsRequiresScalar === null ? "unspecified" : analyticsRequiresScalar}`
      : "";
  const schema =
    tool.parameters ||
    { type: "object", additionalProperties: false };
  let schemaText;
  try {
    schemaText = JSON.stringify(schema);
  } catch (_) {
    schemaText = '{"type":"object"}';
  }
  if (schemaText.length > 2400) schemaText = `${schemaText.slice(0, 2399)}…`;
  return `- ${tool.name}${category}${plugin}${analytics}: ${tool.description || "No description provided."}\n  Parameters: ${schemaText}`;
}

function formatToolDescriptions(tools, maxChars = 48000, maxTools = 64) {
  const lines = [];
  let chars = 0;
  let omitted = 0;
  for (const tool of tools || []) {
    const line = formatToolDescription(tool);
    if (lines.length >= maxTools || chars + line.length > maxChars) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    chars += line.length;
  }
  if (omitted) {
    lines.push(
      `- ${omitted} additional capabilities omitted from this request due to the prompt budget.`,
    );
  }
  return lines.join("\n");
}

const _defaultToolDescriptions = formatToolDescriptions(_defaultToolsList);

function resolveToolInfo(options = {}) {
  const toolsArray = options.registry?.tools || _defaultToolsList;
  const toolNames = options.toolNames || _defaultToolNames;
  const toolNameList = options.toolNames
    ? [...options.toolNames].sort()
    : _defaultToolNameList;
  const toolDescriptions = options.registry
    ? formatToolDescriptions(toolsArray)
    : _defaultToolDescriptions;
  return { toolNames, toolNameList, toolDescriptions };
}

function formatLayerCatalog(layerHints = []) {
  if (!Array.isArray(layerHints) || layerHints.length === 0) return "";
  const lines = layerHints.slice(0, 120).map((layer, index) => {
    const display = layer.displayName || layer.display_name || layer.name || "";
    const canonical = layer.canonicalName || layer.canonical_name || "";
    const aliases = Array.isArray(layer.aliases) ? layer.aliases : [];
    const visible =
      typeof layer.visible === "boolean"
        ? layer.visible
        : typeof layer.isVisible === "boolean"
          ? layer.isVisible
          : undefined;
    const aliasText = aliases.length
      ? ` | aliases: ${aliases.slice(0, 6).join(", ")}`
      : "";
    const canonicalText =
      canonical && canonical !== display ? ` | canonical: ${canonical}` : "";
    const visibleText =
      visible === undefined ? "" : ` | visible: ${visible ? "true" : "false"}`;
    const type = layer.type || layer.layerType || "";
    const sourceType = layer.sourceType || layer.source_type || "";
    const source = layer.source || "";
    const analyzable =
      typeof layer.analyzable === "boolean" ? layer.analyzable : undefined;
    const analytics = Array.isArray(layer.analysisCapabilities)
      ? layer.analysisCapabilities
      : Array.isArray(layer.analytics)
        ? layer.analytics
        : [];
    const time = layer.time && typeof layer.time === "object" ? layer.time : null;
    const typeText = type ? ` | type: ${type}` : "";
    const sourceText = sourceType
      ? ` | source type: ${sourceType}`
      : source
        ? ` | source: ${source}`
        : "";
    const groupText = layer.groupPath
      ? ` | group: ${layer.groupPath}`
      : "";
    const analyzableText =
      analyzable === undefined
        ? ""
        : ` | analyzable: ${analyzable ? "true" : "false"}`;
    const analyticsText = analytics.length
      ? ` | analytics: ${analytics.slice(0, 12).join(", ")}`
      : "";
    const analysisReasonText = layer.analysisReason
      ? ` | analysis limitation: ${layer.analysisReason}`
      : "";
    const analysisSourceText = layer.analysisSource
      ? ` | analysis source: ${layer.analysisSource}`
      : "";
    const scalarText =
      typeof layer.scalar === "boolean"
        ? ` | scalar values: ${layer.scalar ? "true" : "false"}`
        : "";
    const timeText = time
      ? ` | time: ${JSON.stringify(time)}`
      : "";
    const bboxValues =
      Array.isArray(layer.bbox) && layer.bbox.length === 4
        ? layer.bbox.map((value) => Number(value))
        : [];
    const bbox =
      bboxValues.length === 4 && bboxValues.every((value) => Number.isFinite(value))
        ? ` | bbox: [${bboxValues
            .map((value) => value.toFixed(4))
            .join(", ")}]`
        : "";
    return `${index + 1}. ${display}${canonicalText}${aliasText}${visibleText}${typeText}${sourceText}${groupText}${analyzableText}${analyticsText}${analysisReasonText}${analysisSourceText}${scalarText}${timeText}${bbox}`;
  });
  return lines.join("\n");
}

function formatLayerSummaries(layerSummaries = []) {
  if (!Array.isArray(layerSummaries) || layerSummaries.length === 0) return "";
  const lines = layerSummaries.slice(0, 80).map((item) => {
    const cite = item.citation ? ` (source: ${item.citation})` : "";
    const metadata = [
      item.type ? `type=${item.type}` : "",
      item.sourceType ? `sourceType=${item.sourceType}` : "",
      typeof item.analyzable === "boolean"
        ? `analyzable=${item.analyzable}`
        : "",
      item.timeEnabled ? "timeEnabled=true" : "",
    ].filter(Boolean);
    return `- ${item.name}${metadata.length ? ` [${metadata.join(", ")}]` : ""}: ${item.summary}${cite}`;
  });
  return lines.join("\n");
}

function formatConversationHistory(history = []) {
  if (!Array.isArray(history) || history.length === 0) return "";
  return history
    .slice(-16)
    .map((entry) => `${entry.role}: ${entry.text}`)
    .join("\n");
}

function formatRuntimeContext(runtime) {
  if (!runtime || typeof runtime !== "object") return "";
  try {
    return JSON.stringify(runtime);
  } catch (_) {
    return "";
  }
}

function haveAzureEnv() {
  const fas = haveFasEnv();
  return { ok: fas.ok, missing: fas.missing, ver: fas.apiVersion };
}

function buildPrompt(message, context = {}, toolOptions = {}) {
  const { toolDescriptions, toolNames } = resolveToolInfo(toolOptions);
  const layerCatalog = formatLayerCatalog(context.layerHints);
  const layerSummaries = formatLayerSummaries(context.layerSummaries);
  const conversationHistory = formatConversationHistory(context.history);
  const runtimeContext = formatRuntimeContext(context.runtime);
  const promptParts = [
    "You are the MMGIS Copilot assisting users inside the MMGIS web app.",
    "Available tools:",
    toolDescriptions || "- (none)",
  ];
  if (layerCatalog) {
    promptParts.push(
      "Layer catalog (display names, aliases, and visibility):",
      layerCatalog,
    );
  }
  if (layerSummaries) {
    promptParts.push(
      "Layer reference summaries:",
      layerSummaries,
    );
  }
  if (runtimeContext) {
    promptParts.push(
      "Current sanitized MMGIS UI state:",
      runtimeContext,
    );
  }
  if (conversationHistory) {
    promptParts.push(
      "Recent conversation context (oldest to newest):",
      conversationHistory,
    );
  }
  promptParts.push(
    "Always respond with minified JSON on a single line that matches this schema:",
    '{"actions":[{"tool":"string","args":{}}],"reply":"optional markdown string","citations":[{"title":"string","url":"string"}]}',
    "Guidelines:",
    "- Use actions for map-centric requests (layer visibility, opacity, zoom, etc.).",
    "- Normalize typos or paraphrasing to identify the correct tool and layer.",
    "- Resolve layer names using the catalog above; prefer exact display_name matches when possible.",
    "- Proceed without confirmation when a unique, high-confidence alias, typo-normalized, or paraphrased layer match is available. Ask a concise clarification only when multiple plausible candidates remain or every candidate is low confidence.",
    "- STATE-AWARE VISIBILITY MUTATIONS: Before every toggle_layer action, compare the requested visible value with the matched layer's current visible state in the sanitized layer catalog. NEVER emit a redundant toggle when the layer is already in the requested state, and never claim it 'is now' visible/hidden or was turned on/off. Return actions:[] and accurately say it is already visible/hidden.",
    "- For an under-specified request to turn on/enable a data layer to analyze (no layer name), consider only catalog-grounded analyzable/scalar layers. If exactly one compatible hidden layer is available, toggle that layer visible. If multiple compatible hidden layers remain, return actions:[] and ask which one. If none is hidden but a compatible layer is already visible, return actions:[] and identify the already-visible analyzable layer. If no compatible layer exists, explain that limitation. Do not toggle imagery/header/reference layers merely because they are visible.",
    "- Apply the same no-op rule to hide/off requests: a matched layer that is already hidden produces actions:[] and an already-hidden reply. For unnamed/current-layer requests, resolve one grounded target first and clarify genuine ambiguity rather than mutating an arbitrary layer.",
    "- SPATIAL TARGET IDENTITY: 'area of interest'/'AOI', 'selected area', and 'selection extent' mean an explicit user-defined target, not the current viewport. Use zoom_to for these phrases only when Current sanitized MMGIS UI state contains runtime.areaOfInterest.bbox or runtime.selectionExtent.bbox, and copy that dedicated bbox exactly. runtime.map.bounds is never evidence of an AOI/selection and MUST NOT be substituted or described as one.",
    "- If an AOI/selected-area/selection-extent request has no matching dedicated bbox in context, return actions:[] and concisely say that no AOI/selection is currently available; offer the current map view, a named region, or explicit coordinates/bbox. Only an explicit request for 'current view', 'viewport', or 'map bounds' may use runtime.map.bounds.",
    "- IMPORTANT: For 'turn off all layers' or 'disable all layers' requests, create multiple toggle_layer actions (one for each visible layer) with visible:false. Do not just list layers.",
    "- For 'current time setting' or 'what time is it' queries: Look at the layer catalog's temporal information. Report the current temporal setting of visible layers based on their data ranges. NEVER use new Date() or system time. If no temporal information is available, state that explicitly.",
    "- For spatial analysis with no named area, use 'current view'. With no named layer, choose the active layer only if analytically compatible, otherwise the first visible analyzable/scalar layer; clarify if none or multiple equally plausible layers remain. The statistics_first_visible discovery rule below is an explicit exception and does not require layer context at planning time.",
    '- FULL-LAYER STATISTICS SCOPE: When statistics, mean, average, percentiles, or a statistical summary names a layer and explicitly requests its whole/full/entire layer, full raster, entire coverage, or complete dataset extent, use calculate_layer_mean with geographical_area:"full layer extent". Always emit that canonical value even when the user uses an alias.',
    "- 'full layer extent' means the selected layer's own data footprint. It is not the current viewport/runtime.map.bounds, not an AOI/selection extent, and not permission to substitute a generic global bbox. Do not add zoom_to or synthesize coordinates for this statistics scope; the renderer resolves and clamps the layer extent.",
    "- LAYER INVENTORY VS ANALYTICS COMPATIBILITY: Requests to list, show, browse, or inventory the mission's loaded/available layers MUST use list_layers. This includes phrases such as 'available data layers', 'show data layers', and 'which data layers are loaded'; the word 'data' alone does not imply analytical compatibility.",
    "- When an inventory request specifically says 'data layers', inspect the list_layers result/catalog and report the complete set whose declared layer type is data. Do not substitute list_analyzable_layers and do not include non-data imagery merely because it may expose some analysis operation.",
    "- Use list_analyzable_layers only when the user explicitly asks which layers can be analyzed, support analysis/statistics, or are analytically compatible/analyzable. Phrases such as 'which layers can I analyze', 'what data supports analysis', and 'which layers support statistics' are compatibility requests; an unqualified available/list/show inventory is not.",
    toolNames.has("statistics_first_visible")
      ? "- For any statistics, statistical-summary, average, or general-stats request that refers generically to the visible, current, active, first visible, or first data layer and supplies no layer name, MUST use statistics_first_visible. This tool discovers visible layers at execution time and skips incompatible layers, so missing layer catalog/runtime context is not a reason to clarify or ask for a layer name. Pass geographical_area only when the user names an area; otherwise omit it so the renderer uses the current view."
      : "- For unnamed visible/current-layer statistics, use a registered execution-time layer-discovery statistics capability when present; otherwise ask which layer to analyze.",
    "- When asked what 'this/current layer' shows, resolve the sanitized active layer first, then one visible layer; ask a concise clarification rather than describing every visible layer.",
    "- Resolve 'this/current/active layer' from Current sanitized MMGIS UI state first; otherwise use one visible compatible layer, and ask a concise clarification if more than one remains plausible.",
    "- If no available tool precisely satisfies the request, suggest the closest supported tool in the reply and wait for explicit user confirmation (keep actions empty until confirmed).",
    "- For informational questions, set actions to [] and populate reply with a concise, grounded summary.",
    "- When reply cites external knowledge, include 2-4 representative citations array entries (title + URL).",
    "- Prefer sources from the MMGIS documentation and GitHub repositories surfaced via your Bing grounding connection.",
    "- Never invent tool names; only use those listed above. Omit actions if none are required.",
    "- Use only registered capabilities. Native function calls are allowed; JSON-plan mode must place requested calls in actions.",
    "- After any registered UI-handoff capability reports success, confirm only the prepared/opened state and repeat the manual next step reported by that capability. Do not invent key values, patterns, chart findings, or completed exports. Summarize analytical findings only when structured tool result data actually contains them.",
    "- Highlight intent detection: Treat requests phrased as \"highlight ...\", \"show me the areas/region where ...\", or any comparative statements (\"greater than\", \"less than\", \"at least\", \"at most\", etc.) as threshold_highlight actions. Extract the variable/layer, operator (> ≥ < ≤ = between), and numeric value(s) (strip unit words such as \"meters\").",
    toolNames.has("highlight_relative_to_mean")
      ? "- For above/below-average requests without a numeric value, use highlight_relative_to_mean; do not invent a threshold."
      : "- For above/below-average requests without a numeric value, use a registered relative-statistics capability if present; otherwise explain the unsupported operation.",
    "- For range requests (\"between A and B\"), set operator:\"between\" and supply both bounds via value_min/value_max. For single-sided comparisons, place the numeric threshold in value.",
    "- Convert relative temporal phrases into explicit ISO timestamps anchored to the sanitized current UI time. If current UI time is unavailable, ask for dates; never use server/system time.",
    "- ANALYSIS INTENT DISAMBIGUATION (takes precedence over generic analysis tools): A bare request to 'analyze'/'analyse' a layer, with no requested operation, metric, relationship, threshold, spatial scope, temporal goal, chart, or explicitly named registered capability, is materially ambiguous. Return actions:[] and ask one concise clarification about which grounded registered analysis the user wants. Offer only relevant capabilities actually listed above (for example statistics, a temporal trend, threshold/highlight, or layer comparison when registered).",
    "- Never select statistics, trends, thresholds, comparisons, a plug-in action, or another hidden/default operation merely because the word 'analyze' appears or because one capability seems convenient. Once the user states a specific analytical goal, route it to that precise registered capability.",
    "- TEMPORAL ANALYTICS ROUTING: A request for one named layer's changes, trend, evolution, progression, or behavior over time MUST use temporal_trends when it is registered; do not substitute a generic UI handoff. Use the user's explicit time_start/time_end, or grounded available start/end from sanitized layer/runtime temporal context. If neither provides a valid range, return actions:[] and ask for a concise start/end range; never invent dates.",
    "- Use change_detection only to compare the same layer at two explicit snapshots (before_time versus after_time). Use calculate_layer_difference only to compare two layers at one map time. These snapshot tools are not substitutes for a one-layer trend across an interval.",
    "- Comparison/difference intent: For a two-layer comparison at one instant, use calculate_layer_difference with the two layer names as layer_a and layer_b. layer_a is the minuend (e.g. prediction), layer_b is the subtrahend (e.g. ground truth). calculate_layer_difference is a single-time snapshot at the current map time. Do NOT include a set_time action unless the user explicitly asks for one exact date. 'Current date' or 'for now' means use whatever time is already set on the map.",
    "- TEMPORAL COMPARISON SAFETY: A request to compare two layers over a duration/window/range (for example throughout a week/month, over a date range, or from one date through another) MUST NOT be represented by calculate_layer_difference at an arbitrary/representative date, and MUST NOT add set_time merely to collapse the interval into one instant. Use a true interval-aware two-layer comparison capability only when its registered description/schema explicitly accepts both compared layers and a start/end or duration. A single-layer trend/change tool is not a substitute. If no such capability is registered, return actions:[] and concisely explain that only a single-time comparison is available; ask whether to use the current map time or a specific exact date. Never describe a snapshot result as covering the requested interval.",
    "Tool usage quick reference:",
    '  * Mission/loaded/available layer inventory, including "available data layers" -> {"actions":[{"tool":"list_layers","args":{}}]}; apply an explicit type:data qualifier when summarizing the returned inventory',
    '  * Analysis/statistics-compatible layers -> {"actions":[{"tool":"list_analyzable_layers","args":{}}]}',
    '  * Toggle visibility -> {"actions":[{"tool":"toggle_layer","args":{"name":"Layer","visible":true}}]}',
    '  * Desired visibility already matches catalog state -> {"actions":[],"reply":"That layer is already in the requested visibility state."}',
    '  * Unnamed analyzable enable request -> toggle only one uniquely hidden compatible layer; otherwise report an already-visible compatible layer or clarify among hidden candidates',
    '  * Turn off ALL layers -> {"actions":[{"tool":"toggle_layer","args":{"name":"Layer1","visible":false}},{"tool":"toggle_layer","args":{"name":"Layer2","visible":false}},...]}',
    '  * Set time -> {"actions":[{"tool":"set_time","args":{"time":"February 2024"}}]}',
    '  * Adjust opacity -> {"actions":[{"tool":"set_layer_opacity","args":{"name":"Layer","opacity":0.5}}]}',
    '  * Zoom -> {"actions":[{"tool":"zoom_to","args":{"center":[lon,lat],"zoom":12}}]}',
    '  * Explicit AOI/selection with dedicated context bbox -> copy runtime.areaOfInterest.bbox or runtime.selectionExtent.bbox exactly into zoom_to.bbox',
    '  * AOI/selection without dedicated context bbox -> {"actions":[],"reply":"No area of interest or selection extent is currently available. Should I use the current map view, a named region, or coordinates/bbox?"}',
    '  * Explicit current viewport/map-bounds request -> copy runtime.map.bounds exactly into zoom_to.bbox',
    '  * Layer info -> {"actions":[{"tool":"layer_information","args":{"layer_name":"Air Quality Index"}}]}',
    '  * Mean value -> {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Sea Surface Temperature","geographical_area":"Beaufort Sea"}}]}',
    '  * Whole/full/entire-layer statistics -> {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Sea Surface Temperature","geographical_area":"full layer extent"}}]}',
    toolNames.has("statistics_first_visible")
      ? '  * Statistics for an unnamed visible/current/first data layer -> {"actions":[{"tool":"statistics_first_visible","args":{}}]}'
      : "  * Statistics for an unnamed visible/current layer -> clarify only when no discovery capability is registered.",
    '  * Highlight threshold -> {"actions":[{"tool":"threshold_highlight","args":{"layer_name":"ice thickness","variable":"ice_thickness","operator":">=","value":3}}]}',
    '  * Detect anomalies -> {"actions":[{"tool":"detect_anomalies","args":{"layer_name":"<first visible analyzable layer>"}}]}',
    '  * One-layer change/trend/evolution over a grounded interval -> {"actions":[{"tool":"temporal_trends","args":{"layer_name":"Sea Ice","time_start":"2024-01-01","time_end":"2024-12-31"}}]}',
    '  * Same layer at two explicit snapshots -> {"actions":[{"tool":"change_detection","args":{"layer_name":"Sea Ice","before_time":"2024-01-01","after_time":"2024-02-01"}}]}',
    '  * Difference -> {"actions":[{"tool":"calculate_layer_difference","args":{"layer_a":"Precipitation Rate","layer_b":"Vegetation Index"}}]}',
    '  * Two-layer comparison over a duration with no registered interval-aware two-layer tool -> {"actions":[],"reply":"I can compare these layers at one map time, but not across the requested interval. Would you like the current map time or a specific date?"}',
    '  * Export animation -> {"actions":[{"tool":"open_animation_tool","args":{"layer_name":"SIC forecast","start_date":"2024-01-01","end_date":"2024-12-31","region":"Beaufort Sea","format":"gif"}}]}',
    '  * Bare "analyze <layer>" with no analytical goal -> {"actions":[],"reply":"Which supported analysis would you like for that layer?"}',
    "Examples:",
    'User: "Please list layers."\nAssistant: {"actions":[{"tool":"list_layers","args":{}}]}',
    'User: "Show available data layers."\nAssistant: {"actions":[{"tool":"list_layers","args":{}}],"reply":"I’ll inspect the loaded layer inventory and report every layer whose declared type is data."}',
    'User: "Which data layers are loaded in this mission?"\nAssistant: {"actions":[{"tool":"list_layers","args":{}}],"reply":"I’ll inspect the mission layer inventory and report its data layers."}',
    'User: "Which layers support statistics?"\nAssistant: {"actions":[{"tool":"list_analyzable_layers","args":{}}],"reply":"I’ll check which currently loaded layers expose compatible statistical analysis."}',
    'Context: Scalar Data A is visible and analyzable; no compatible analyzable layer is hidden.\nUser: "Turn on a data layer to analyze"\nAssistant: {"actions":[],"reply":"Scalar Data A is already visible and supports analysis."}',
    'Context: Scalar Data B is the only hidden analyzable layer; visible imagery is not analytically compatible.\nUser: "Enable something I can run statistics on."\nAssistant: {"actions":[{"tool":"toggle_layer","args":{"name":"Scalar Data B","visible":true}}],"reply":"Turning on Scalar Data B, the uniquely matched hidden analyzable layer."}',
    'Context: Scalar Data C is already hidden.\nUser: "Hide Scalar Data C."\nAssistant: {"actions":[],"reply":"Scalar Data C is already hidden."}',
    'User: "Turn off all layers."\nAssistant: {"actions":[{"tool":"toggle_layer","args":{"name":"Areas of Interest","visible":false}},{"tool":"toggle_layer","args":{"name":"Primary Layer","visible":false}}],"reply":"Turning off all visible layers."}',
    'Context: runtime.map.bounds=[-180,70,180,90] and no runtime.areaOfInterest/runtime.selectionExtent.\nUser: "Take me to the selected area."\nAssistant: {"actions":[],"reply":"No selected area or AOI extent is currently available. Should I use the current map view, a named region, or coordinates/bbox?"}',
    'Context: runtime.map.bounds=[-125,30,-110,45].\nUser: "Fit to the current map bounds."\nAssistant: {"actions":[{"tool":"zoom_to","args":{"bbox":[-125,30,-110,45]}}],"reply":"Fitting the map to the current viewport bounds."}',
    'User: "Calculate mean for [Layer A]"\nAssistant: {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"[Layer A]","geographical_area":"current view"}}],"reply":"Calculating statistics for [Layer A] in the current view."}',
    'User: "Show statistics for Snow Depth"\nAssistant: {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Snow Depth Over Ice","geographical_area":"current view"}}],"reply":"Computing statistics for Snow Depth Over Ice layer."}',
    'User: "Compute a statistical summary across all of Snow Depth\'s coverage."\nAssistant: {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Snow Depth","geographical_area":"full layer extent"}}],"reply":"Computing statistics across the full Snow Depth layer extent."}',
    toolNames.has("statistics_first_visible")
      ? 'User: "Summarize the statistics for whichever data layer is currently visible."\nAssistant: {"actions":[{"tool":"statistics_first_visible","args":{}}],"reply":"I’ll find the first visible layer with compatible scalar data and calculate its statistics."}'
      : "",
    'User: "Contrast the forecast and observed layers throughout February."\nAssistant: {"actions":[],"reply":"The available layer-difference capability compares one map time, not a full interval. Would you like to compare the current map time or choose a specific date?"}',
    'Context: Ice Forecast has available time range 2024-01-01 through 2024-12-31.\nUser: "Show Ice Forecast changes over time."\nAssistant: {"actions":[{"tool":"temporal_trends","args":{"layer_name":"Ice Forecast","time_start":"2024-01-01","time_end":"2024-12-31"}}],"reply":"Analyzing Ice Forecast trends across its available time range."}',
    'User: "How has Snow Depth evolved from March through September 2024?"\nAssistant: {"actions":[{"tool":"temporal_trends","args":{"layer_name":"Snow Depth","time_start":"2024-03-01","time_end":"2024-09-30"}}],"reply":"Analyzing how Snow Depth evolved over the requested interval."}',
    'User: "How did Snow Depth differ between 2024-03-01 and 2024-09-30?"\nAssistant: {"actions":[{"tool":"change_detection","args":{"layer_name":"Snow Depth","before_time":"2024-03-01","after_time":"2024-09-30"}}],"reply":"Comparing Snow Depth at the two requested snapshots."}',
    'User: "Analyze Ice Forecast."\nAssistant: {"actions":[],"reply":"Which supported analysis would you like for Ice Forecast—for example statistics, a temporal trend, a threshold/highlight, or a comparison?"}',
    'User: "Please perform an analysis on Snow Depth."\nAssistant: {"actions":[],"reply":"What analytical goal should I use for Snow Depth? I can use the relevant registered capabilities once you choose the operation."}',
    'User: "What is the current time setting?"\nAssistant: {"actions":[],"reply":"Based on the visible layers, the current temporal setting shows data from [examine layer catalog for actual time ranges of the visible layers]."}',
    'User: "Explain what this layer shows"\nAssistant: {"actions":[{"tool":"layer_information","args":{"layer_name":"[active layer]"}}],"reply":"I\'ll explain the active layer."}',
    'User: "What does this show?"\nAssistant: {"actions":[{"tool":"layer_information","args":{"layer_name":"[first visible layer]"}}],"reply":"Let me look up the currently visible layer."}',
    'User: "What is MMGIS?"\nAssistant: {"actions":[],"reply":"<short grounded answer>","citations":[{"title":"MMGIS GitHub Repository","url":"https://github.com/NASA-AMMOS/MMGIS"}]}',
    `User request: ${String(message).slice(0, 1000)}`,
  );
  return promptParts.join("\n");
}

function extractAssistantText(message) {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const candidate =
        (part &&
          part.text &&
          typeof part.text.value === "string" &&
          part.text.value) ||
        (part && typeof part.text === "string" && part.text) ||
        (part && typeof part.value === "string" && part.value) ||
        (part && typeof part.content === "string" && part.content) ||
        (part &&
          part.content &&
          typeof part.content.text === "string" &&
          part.content.text) ||
        "";
      if (candidate) {
        return candidate;
      }
    }
  }
  if (typeof message.text === "string") return message.text;
  return "";
}

function extractBalancedJsonObject(value) {
  const text = String(value || "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          json: text.slice(start, index + 1),
          prefix: text.slice(0, start),
          suffix: text.slice(index + 1),
        };
      }
    }
  }
  return null;
}

function extractJsonPlanCandidate(rawAssistantText) {
  const trimmed = rawAssistantText.trim();
  const fence = trimmed.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60\s*$/i);
  const source = fence ? fence[1].trim() : trimmed;
  const balanced = extractBalancedJsonObject(source);
  if (!balanced || balanced.suffix.trim()) {
    const err = new Error("Response does not contain one complete JSON object.");
    err.code = "InvalidAgentPlan";
    throw err;
  }
  return balanced.json;
}

function looksLikeStructuredPlan(text) {
  const trimmed = String(text || "").trim();
  return (
    trimmed.startsWith("{") ||
    /^\x60\x60\x60(?:json)?\b/i.test(trimmed) ||
    /^[^{]{0,500}\{/.test(trimmed)
  );
}

function parseAgentPlan(rawAssistantText) {
  const trimmed =
    typeof rawAssistantText === "string" ? rawAssistantText.trim() : "";
  if (!trimmed) {
    throw new Error("Azure Agent Service returned an empty response.");
  }
  try {
    const jsonCandidate = extractJsonPlanCandidate(trimmed);
    const plan = JSON.parse(jsonCandidate);
    if (!plan || typeof plan !== "object") {
      throw new Error("Plan must be a JSON object.");
    }
    return plan;
  } catch (error) {
    const err = new Error(
      `Azure Agent Service returned non-JSON response: ${error.message}`,
    );
    err.code = "InvalidAgentPlan";
    err.raw = rawAssistantText;
    err.cause = error;
    throw err;
  }
}

function normalizeActions(actions, toolOptions = {}) {
  if (actions == null) return [];
  if (!Array.isArray(actions)) {
    throw new Error("Azure Agent Service plan missing 'actions' array.");
  }
  const { toolNames } = resolveToolInfo(toolOptions);
  return actions.map((action, index) => {
    if (!action || typeof action !== "object") {
      throw new Error(`Plan action at index ${index} is not an object.`);
    }
    if (typeof action.tool !== "string" || !action.tool.trim()) {
      throw new Error(`Plan action at index ${index} missing 'tool' name.`);
    }
    if (!toolNames.has(action.tool)) {
      throw new Error(
        `Plan action references unknown tool '${action.tool}'. Valid tools: ${[...toolNames].join(", ")}`,
      );
    }
    if (action.args && typeof action.args !== "object") {
      throw new Error(`Plan action '${action.tool}' has non-object args.`);
    }
    const normalized = { tool: action.tool, args: action.args || {} };
    if (typeof action.callId === "string" && action.callId.trim()) {
      normalized.callId = action.callId.trim();
    }
    return normalized;
  });
}

function normalizeCitations(citations) {
  if (!Array.isArray(citations)) return [];
  const normalized = [];
  const seen = new Set();
  for (const entry of citations.slice(0, 8)) {
    const value =
      typeof entry === "string" ? { title: entry, url: entry } : entry;
    if (
      value &&
      typeof value.title === "string" &&
      value.title.trim() &&
      typeof value.url === "string"
    ) {
      const title = value.title.trim().slice(0, 300);
      const url = value.url.trim().slice(0, 2048);
      let safe = false;
      try {
        safe = ["http:", "https:"].includes(new URL(url).protocol);
      } catch (_) {}
      if (safe && !seen.has(url)) {
        seen.add(url);
        normalized.push({ title, url });
      }
    }
  }
  return normalized;
}

function fallbackMessage(toolOptions = {}) {
  const { toolNameList } = resolveToolInfo(toolOptions);
  const list =
    toolNameList.length > 0 ? toolNameList.join(", ") : "(no tools)";
  return `I'm sorry, I can't perform that operation. Here are the available tools: ${list}.`;
}

// The model's few-shot examples intentionally omit "reply" for purely
// action-driven requests (e.g. "list layers" -> {"actions":[...]} with no
// reply). Never fall back to the raw JSON plan text in that case — describe
// the planned actions in plain language instead.
function describeActionsReply(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "";
  const uniqueTools = [...new Set(actions.map((a) => a.tool))];
  return `Running ${uniqueTools.join(", ")}.`;
}

function normalizeReplyProseLineBreaks(value) {
  const source = String(value || "");
  let output = "";
  let index = 0;
  while (index < source.length) {
    if (source[index] !== "\\") {
      output += source[index];
      index += 1;
      continue;
    }
    const slashStart = index;
    while (index < source.length && source[index] === "\\") index += 1;
    const slashCount = index - slashStart;
    const marker = source[index];
    if (
      slashCount % 2 === 1 &&
      (marker === "n" || marker === "r")
    ) {
      // Decode one model-added escaping layer only. An even slash pair is a
      // literal backslash and must remain untouched.
      output += "\\".repeat(slashCount - 1);
      if (
        marker === "r" &&
        source[index + 1] === "\\" &&
        source[index + 2] === "n"
      ) {
        index += 3;
      } else {
        index += 1;
      }
      output += "\n";
      continue;
    }
    output += "\\".repeat(slashCount);
  }
  return output;
}

function normalizeUserReplyLineBreaks(value) {
  if (typeof value !== "string" || !value) return value || "";
  // Preserve markdown code spans/fences where a literal backslash-n may be
  // part of a path, command, or example. Only prose is a formatting surface.
  const code = /```[\s\S]*?```|`[^`\r\n]*`/g;
  let output = "";
  let previous = 0;
  for (const match of value.matchAll(code)) {
    output += normalizeReplyProseLineBreaks(
      value.slice(previous, match.index),
    );
    output += match[0];
    previous = match.index + match[0].length;
  }
  output += normalizeReplyProseLineBreaks(value.slice(previous));
  return output;
}

function resolveReplyText(plan, actions, toolOptions) {
  if (typeof plan?.reply === "string" && plan.reply.trim().length > 0) {
    return normalizeUserReplyLineBreaks(plan.reply.trim());
  }
  const describedActions = describeActionsReply(actions);
  return describedActions || fallbackMessage(toolOptions);
}

function normalizeTextPlan(rawAssistantText, toolOptions, { allowPlainText = false } = {}) {
  const text =
    typeof rawAssistantText === "string" ? rawAssistantText.trim() : "";
  if (!text) {
    const err = new Error("The model returned an empty response.");
    err.code = "EmptyModelResponse";
    throw err;
  }
  try {
    const plan = parseAgentPlan(text);
    const actions = normalizeActions(plan.actions, toolOptions);
    return {
      actions,
      reply: resolveReplyText(plan, actions, toolOptions),
      citations: normalizeCitations(plan.citations),
      raw: text,
      fallbackApplied:
        actions.length === 0 &&
        !(typeof plan.reply === "string" && plan.reply.trim()),
    };
  } catch (error) {
    if (!allowPlainText || looksLikeStructuredPlan(text)) throw error;
    return {
      actions: [],
      reply: normalizeUserReplyLineBreaks(text),
      citations: [],
      raw: text,
      fallbackApplied: false,
    };
  }
}

function normalizeAzureProviderResult(
  azure,
  toolOptions,
  { allowPlainText = false } = {},
) {
  const nativeActions = normalizeActions(azure?.actions || [], toolOptions);
  const rawAssistantText = extractAssistantText(azure?.message);
  let textPlan = null;
  if (rawAssistantText && rawAssistantText.trim()) {
    textPlan = normalizeTextPlan(rawAssistantText, toolOptions, {
      allowPlainText: allowPlainText || nativeActions.length > 0,
    });
  }

  const actions = nativeActions.length
    ? nativeActions
    : textPlan?.actions || [];
  const reply = textPlan?.reply || resolveReplyText({}, actions, toolOptions);
  if (!reply || !reply.trim()) {
    const err = new Error("The model returned a blank reply.");
    err.code = "EmptyModelResponse";
    throw err;
  }
  return {
    actions,
    reply: reply.trim(),
    citations: textPlan?.citations || [],
    rawAssistantText: textPlan?.raw || "",
    responseId: azure?.responseId || azure?.run?.id || null,
    fallbackApplied: textPlan ? textPlan.fallbackApplied : true,
  };
}

function buildToolResultContinuationPrompt(toolResults, context, toolOptions) {
  const resultJson = JSON.stringify(toolResults);
  return [
    "The MMGIS client has completed the actions from your previous plan.",
    "Use the structured results below to provide a useful user-facing reply.",
    "If another registered action is genuinely necessary, return it in actions; otherwise return actions:[] and a final reply.",
    "Never claim a failed action succeeded. Explain safe, actionable failure reasons.",
    `Tool results: ${resultJson}`,
  ].join("\n");
}

function buildAzureInstructions(context, toolOptions) {
  return buildPrompt("", context, toolOptions)
    .replace(/\nUser request:\s*$/, "")
    .trim();
}

function resolveProviderSelection(env = process.env) {
  const configured = String(env.LLM_PROVIDER || "").trim().toLowerCase();
  if (configured && !["azure", "gemini"].includes(configured)) {
    const err = new Error(
      "LLM_PROVIDER must be either 'azure' or 'gemini'.",
    );
    err.code = "InvalidProviderConfig";
    throw err;
  }
  if (configured) {
    return { provider: configured, automatic: false };
  }
  const azureReady = ["PROJECT_ENDPOINT", "AGENT_NAME", "AGENT_VERSION"].every(
    (key) => typeof env[key] === "string" && env[key].trim(),
  );
  if (azureReady) return { provider: "azure", automatic: true };
  if (typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim()) {
    return { provider: "gemini", automatic: true };
  }
  const err = new Error("No LLM provider is configured.");
  err.code = "ProviderUnavailable";
  throw err;
}

async function planWithProvider(message, context = {}, { threadId, registry, toolNames } = {}) {
  const toolOptions = { registry, toolNames };
  const prompt = buildPrompt(message, context, toolOptions);
  const azureInstructions = buildAzureInstructions(context, toolOptions);
  const resolved = resolveToolInfo(toolOptions);
  const selection = resolveProviderSelection();
  const providerTools = buildProviderTools(registry || _defaultRegistry);

  let rawAssistantText;
  let useGemini = selection.provider === "gemini";

  if (selection.provider === "azure") {
    // ── Azure AI Foundry ──────────────────────────────────────────────────────
    try {
      const azureAttempt = await runAzureWithToolFallback(
        String(message).slice(0, 2000),
        {
          threadId,
          instructions: azureInstructions,
          compatibilityPrompt: prompt,
          keepThread: true,
        },
        providerTools,
      );
      const azure = azureAttempt.result;
      const normalized = normalizeAzureProviderResult(azure, toolOptions, {
        allowPlainText: true,
      });

      return {
        actions: normalized.actions,
        reply: normalized.reply,
        citations: normalized.citations,
        provider: "azure",
        threadId: azure?.threadId || null,
        responseId: normalized.responseId,
        debug: {
          request: {
            toolCount: resolved.toolNames.size,
            registeredToolCount: providerTools.tools.length,
            omittedToolCount: providerTools.omittedCount,
            capabilityMode: azureAttempt.capabilityMode,
          },
          response: { status: 200 },
          message: normalized.rawAssistantText,
          run: azure?.run ? { id: azure.run.id, status: azure.run.status } : undefined,
          fallbackApplied: normalized.fallbackApplied,
        },
      };
    } catch (azureError) {
      if (!selection.automatic || !process.env.GEMINI_API_KEY) {
        throw azureError;
      }
      useGemini = true;
      console.warn(
        `[provider] Azure failed, falling back to Gemini: ${azureError.message}`,
      );
    }
  }

  if (useGemini && process.env.GEMINI_API_KEY) {
    // ── Google Gemini ─────────────────────────────────────────────────────────
    const { text } = await gemini.generateContent(prompt);
    rawAssistantText = text;

    const normalized = normalizeTextPlan(rawAssistantText, toolOptions, {
      allowPlainText: true,
    });

    return {
      actions: normalized.actions,
      reply: normalized.reply,
      citations: normalized.citations,
      provider: "gemini",
      threadId: null,
      responseId: null,
      debug: {
        request: { toolCount: resolved.toolNames.size },
        response: { status: 200 },
        message: rawAssistantText,
        fallbackApplied: normalized.fallbackApplied,
      },
    };

  } else {
    const err = new Error(
      "No LLM provider configured. Set Azure env vars (PROJECT_ENDPOINT, AGENT_NAME, AGENT_VERSION) or GEMINI_API_KEY.",
    );
    err.code = "ProviderUnavailable";
    throw err;
  }
}

async function continueWithProvider(
  toolResults,
  context = {},
  { threadId, responseId, registry, toolNames } = {},
) {
  const toolOptions = { registry, toolNames };
  const resolved = resolveToolInfo(toolOptions);
  const selection = resolveProviderSelection();
  const azureInstructions = buildAzureInstructions(context, toolOptions);
  const providerTools = buildProviderTools(registry || _defaultRegistry);
  const isNativeContinuation =
    toolResults.length > 0 && toolResults.every((result) => result.callId);

  if (isNativeContinuation) {
    if (selection.provider !== "azure") {
      const err = new Error(
        "Native function-call continuation requires the Azure provider.",
      );
      err.code = "ProviderContinuationMismatch";
      throw err;
    }
    const azureAttempt = await continueAzureWithToolFallback(
      toolResults,
      {
        responseId,
        threadId,
        keepThread: true,
        instructions: azureInstructions,
      },
      providerTools,
    );
    const azure = azureAttempt.result;
    const normalized = normalizeAzureProviderResult(azure, toolOptions, {
      allowPlainText: true,
    });
    return {
      actions: normalized.actions,
      reply: normalized.reply,
      citations: normalized.citations,
      provider: "azure",
      threadId: azure?.threadId || threadId || null,
      responseId: normalized.responseId,
      debug: {
        request: {
          toolCount: resolved.toolNames.size,
          continuation: "function_call_output",
          capabilityMode: azureAttempt.capabilityMode,
          omittedToolCount: providerTools.omittedCount,
        },
        response: { status: 200 },
        message: normalized.rawAssistantText,
        run: azure?.run
          ? { id: azure.run.id, status: azure.run.status }
          : undefined,
        fallbackApplied: normalized.fallbackApplied,
      },
    };
  }

  if (toolResults.some((result) => result.callId)) {
    const err = new Error(
      "A continuation may not mix Azure-correlated and uncorrelated tool results.",
    );
    err.code = "InvalidToolResults";
    throw err;
  }

  const prompt = buildToolResultContinuationPrompt(
    toolResults,
    context,
    toolOptions,
  );
  let useGemini = selection.provider === "gemini";
  if (selection.provider === "azure") {
    try {
      const azureAttempt = await runAzureWithToolFallback(
        prompt,
        {
          threadId,
          instructions: azureInstructions,
          compatibilityPrompt: prompt,
          keepThread: true,
        },
        providerTools,
      );
      const azure = azureAttempt.result;
      const normalized = normalizeAzureProviderResult(azure, toolOptions, {
        allowPlainText: true,
      });
      return {
        actions: normalized.actions,
        reply: normalized.reply,
        citations: normalized.citations,
        provider: "azure",
        threadId: azure?.threadId || threadId || null,
        responseId: normalized.responseId,
        debug: {
          request: {
            toolCount: resolved.toolNames.size,
            continuation: "tool_result_summary",
            capabilityMode: azureAttempt.capabilityMode,
            omittedToolCount: providerTools.omittedCount,
          },
          response: { status: 200 },
          message: normalized.rawAssistantText,
          run: azure?.run
            ? { id: azure.run.id, status: azure.run.status }
            : undefined,
          fallbackApplied: normalized.fallbackApplied,
        },
      };
    } catch (azureError) {
      if (
        !selection.automatic ||
        !process.env.GEMINI_API_KEY
      ) {
        throw azureError;
      }
      useGemini = true;
      console.warn(
        `[provider] Azure continuation failed, falling back to Gemini: ${azureError.message}`,
      );
    }
  }

  if (useGemini && process.env.GEMINI_API_KEY) {
    const { text } = await gemini.generateContent(
      `${azureInstructions}\n\nUser continuation:\n${prompt}`,
    );
    const normalized = normalizeTextPlan(text, toolOptions, {
      allowPlainText: true,
    });
    return {
      actions: normalized.actions,
      reply: normalized.reply,
      citations: normalized.citations,
      provider: "gemini",
      threadId: null,
      responseId: null,
      debug: {
        request: {
          toolCount: resolved.toolNames.size,
          continuation: "tool_result_summary",
        },
        response: { status: 200 },
        message: normalized.raw,
        fallbackApplied: normalized.fallbackApplied,
      },
    };
  }

  const err = new Error(
    "No LLM provider configured for Copilot continuation.",
  );
  err.code = "ProviderUnavailable";
  throw err;
}

const MAX_RESPONSE_TOOLS = 64;
const MAX_RESPONSE_TOOL_SCHEMA_CHARS = 48000;
let azureRequestToolsSupported = null;

function buildProviderTools(registry = _defaultRegistry) {
  const result = [];
  let schemaChars = 0;
  let omittedCount = 0;
  for (const tool of registry?.tools || []) {
    const parameters =
      tool.parameters || { type: "object", additionalProperties: false };
    const serialized = JSON.stringify(parameters);
    if (
      result.length >= MAX_RESPONSE_TOOLS ||
      schemaChars + serialized.length > MAX_RESPONSE_TOOL_SCHEMA_CHARS
    ) {
      omittedCount += 1;
      continue;
    }
    schemaChars += serialized.length;
    result.push({
      type: "function",
      name: tool.name,
      description: (tool.description || tool.name).slice(0, 600),
      parameters,
      strict: false,
    });
  }
  return { tools: result, omittedCount, schemaChars };
}

function listProviderTools(registry) {
  return buildProviderTools(registry).tools;
}

function isRequestToolsUnsupported(error) {
  const status = error?.status || error?.statusCode || error?.response?.status;
  const message = String(error?.message || "").toLowerCase();
  return (
    (status == null || [400, 404, 422].includes(status)) &&
    /tool|function/.test(message) &&
    /unsupported|not supported|not allowed|agent.reference|agent_reference/.test(
      message,
    )
  );
}

function azureStreamEventError(event) {
  const detail = event?.error || event?.response?.error || {};
  const error = new Error(
    detail.message || "Azure Agent run failed during streaming.",
  );
  error.code = "AzureAgentRunFailed";
  error.providerCode = detail.code || null;
  error.status =
    detail.status || event?.status || event?.response?.statusCode || null;
  error._threadId = event?._threadId || null;
  return error;
}

async function runAzureWithToolFallback(
  message,
  options,
  toolSet,
  runAgent = runAgentMessage,
) {
  const {
    compatibilityPrompt,
    publishedAgent = true,
    ...baseOptions
  } = options || {};
  const conversationMessage = compatibilityPrompt || message;
  // This backend is configured with AGENT_NAME, so it uses the published-agent
  // Responses contract. The installed SDK permits only the conversation in
  // the request payload; put the bounded policy/tool catalog in that single
  // conversation item and plan through validated JSON.
  if (publishedAgent) {
    return {
      result: await runAgent(message, {
        ...baseOptions,
        conversationMessage,
        instructions: undefined,
        tools: [],
      }),
      capabilityMode: "prompt-json-published-agent",
    };
  }

  const requestTools =
    azureRequestToolsSupported === false ? [] : toolSet.tools;
  try {
    const result = await runAgent(message, {
      ...baseOptions,
      conversationMessage,
      tools: requestTools,
    });
    if (requestTools.length) azureRequestToolsSupported = true;
    return {
      result,
      capabilityMode: requestTools.length ? "responses-tools" : "prompt-json",
    };
  } catch (error) {
    if (!requestTools.length || !isRequestToolsUnsupported(error)) throw error;
    azureRequestToolsSupported = false;
    console.warn(
      "[provider] Azure published agent rejected request-scoped tools; using validated JSON-plan mode.",
    );
    const retryThreadId = error._threadId || baseOptions.threadId || null;
    return {
      result: await runAgent(message, {
        ...baseOptions,
        threadId: retryThreadId,
        messageAlreadyAdded: Boolean(retryThreadId),
        conversationMessage,
        tools: [],
      }),
      capabilityMode: "prompt-json",
    };
  }
}

async function continueAzureWithToolFallback(
  toolResults,
  options,
  toolSet,
  continueAgent = continueAgentRun,
) {
  const { publishedAgent = true, ...baseOptions } = options || {};
  if (publishedAgent) {
    return {
      result: await continueAgent(toolResults, {
        ...baseOptions,
        instructions: undefined,
        tools: [],
      }),
      capabilityMode: "published-agent-continuation",
    };
  }

  const requestTools =
    azureRequestToolsSupported === false ? [] : toolSet.tools;
  try {
    const result = await continueAgent(toolResults, {
      ...baseOptions,
      tools: requestTools,
    });
    if (requestTools.length) azureRequestToolsSupported = true;
    return {
      result,
      capabilityMode: requestTools.length ? "responses-tools" : "prompt-json",
    };
  } catch (error) {
    if (!requestTools.length || !isRequestToolsUnsupported(error)) throw error;
    azureRequestToolsSupported = false;
    console.warn(
      "[provider] Azure continuation rejected request-scoped tools; retrying without them.",
    );
    return {
      result: await continueAgent(toolResults, {
        ...baseOptions,
        tools: [],
      }),
      capabilityMode: "prompt-json",
    };
  }
}

function normalizeStreamingCompletion(response, streamedText, toolOptions) {
  try {
    const responseText = extractOutputText(response);
    const text = (streamedText || responseText || "").trim();
    const nativeActions = normalizeActions(
      extractFunctionCalls(response),
      toolOptions,
    );
    if (!text && nativeActions.length === 0) {
      const err = new Error("The streaming model response was empty.");
      err.code = "EmptyModelResponse";
      throw err;
    }
    let textPlan = null;
    if (text) {
      textPlan = normalizeTextPlan(text, toolOptions, {
        allowPlainText: true,
      });
    }
    const actions = nativeActions.length
      ? nativeActions
      : textPlan?.actions || [];
    const reply = textPlan?.reply || resolveReplyText({}, actions, toolOptions);
    if (!reply || !reply.trim()) {
      const err = new Error("The streaming model response was empty.");
      err.code = "EmptyModelResponse";
      throw err;
    }
    return {
      actions,
      reply: reply.trim(),
      citations: textPlan?.citations || [],
      responseId: response?.id || null,
    };
  } catch (error) {
    // Keep malformed structured output and unknown actions diagnosable when
    // the streaming route converts them into a safe SSE error.
    if (!error.code) error.code = "InvalidModelResponse";
    throw error;
  }
}

async function* streamWithProvider(
  message,
  context = {},
  {
    threadId,
    registry,
    toolNames,
    streamAgent = streamAgentMessage,
  } = {},
) {
  const toolOptions = { registry, toolNames };
  const prompt = buildPrompt(message, context, toolOptions);
  const selection = resolveProviderSelection();

  if (selection.provider === "azure") {
    // ── Azure AI Foundry (streaming) ──────────────────────────────────────────
    let fullText = "";
    let resolvedThreadId = threadId || null;
    let attemptThreadId = threadId || null;
    let messageAlreadyAdded = false;
    let emittedOutput = false;
    let sawTerminal = false;
    // AGENT_NAME selects a published agent. Its documented Responses payload
    // does not permit per-request instructions/tools, so use the same full
    // bounded JSON-planning prompt as the non-stream path.
    let requestTools = [];
    let requestInstructions;

    while (true) {
      let retryError = null;
      try {
        for await (const event of streamAgent(
          String(message).slice(0, 2000),
          {
            threadId: attemptThreadId,
            keepThread: true,
            instructions: requestInstructions,
            tools: requestTools,
            messageAlreadyAdded,
            conversationMessage: prompt,
          },
        )) {
          if (!resolvedThreadId && event._threadId) {
            resolvedThreadId = event._threadId;
          }

          // New @azure/ai-projects Responses stream events
          if (event.type === "response.output_text.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (delta) {
              fullText += delta;
              emittedOutput = true;
              yield { type: "token", data: delta };
            }
          } else if (
            event.type === "response.output_text.done" ||
            event.type === "response.completed"
          ) {
            if (!fullText) {
              fullText =
                (typeof event.text === "string" && event.text) ||
                (typeof event.response?.output_text === "string" &&
                  event.response.output_text) ||
                "";
            }
            if (event.type === "response.completed") {
              sawTerminal = true;
              try {
                const normalized = normalizeStreamingCompletion(
                  event.response,
                  fullText,
                  toolOptions,
                );
                emittedOutput = true;
                yield {
                  type: "plan",
                  data: {
                    actions: normalized.actions,
                    reply: normalized.reply,
                    citations: normalized.citations,
                    threadId: resolvedThreadId,
                    responseId: normalized.responseId,
                    provider: "azure",
                  },
                };
              } catch (error) {
                emittedOutput = true;
                yield {
                  type: "error",
                  code: error.code || "InvalidModelResponse",
                  data:
                    "Copilot returned a malformed or empty streaming response.",
                };
              }
            }
          } else if (
            event.type === "response.failed" ||
            event.type === "error"
          ) {
            const streamError = azureStreamEventError(event);
            if (
              !emittedOutput &&
              requestTools.length &&
              isRequestToolsUnsupported(streamError)
            ) {
              retryError = streamError;
              break;
            }
            sawTerminal = true;
            emittedOutput = true;
            // eslint-disable-next-line no-console
            console.warn(
              "[provider] Azure stream failed:",
              redactSensitiveText(streamError.message, 500),
            );
            yield {
              type: "error",
              code: "CopilotProviderFailed",
              data:
                "Copilot's language-model provider could not complete the streamed request.",
            };
          }
        }
      } catch (error) {
        if (
          !emittedOutput &&
          requestTools.length &&
          isRequestToolsUnsupported(error)
        ) {
          retryError = error;
        } else {
          throw error;
        }
      }

      if (retryError) {
        azureRequestToolsSupported = false;
        // eslint-disable-next-line no-console
        console.warn(
          "[provider] Azure streaming rejected request-scoped tools; retrying in validated JSON-plan mode.",
        );
        const retryThreadId =
          resolvedThreadId || retryError._threadId || attemptThreadId || null;
        resolvedThreadId = retryThreadId;
        attemptThreadId = retryThreadId;
        messageAlreadyAdded = Boolean(retryThreadId);
        requestTools = [];
        requestInstructions = undefined;
        fullText = "";
        sawTerminal = false;
        continue;
      }

      if (requestTools.length && sawTerminal) {
        azureRequestToolsSupported = true;
      }
      if (!sawTerminal) {
        const code = fullText.trim()
          ? "InvalidModelResponse"
          : "EmptyModelResponse";
        yield {
          type: "error",
          code,
          data: "Copilot returned a malformed or empty streaming response.",
        };
      }
      break;
    }

    yield { type: "done", data: { threadId: resolvedThreadId } };

  } else if (
    selection.provider === "gemini" &&
    process.env.GEMINI_API_KEY
  ) {
    // ── Google Gemini (streaming) ─────────────────────────────────────────────
    let fullText = "";

    for await (const chunk of gemini.streamContent(prompt)) {
      fullText += chunk;
      yield { type: "token", data: chunk };
    }

    try {
      const normalized = normalizeTextPlan(fullText, toolOptions, {
        allowPlainText: true,
      });
      yield {
        type: "plan",
        data: {
          actions: normalized.actions,
          reply: normalized.reply,
          citations: normalized.citations,
          threadId: null,
          responseId: null,
          provider: "gemini",
        },
      };
    } catch (error) {
      yield {
        type: "error",
        code: error.code || "InvalidModelResponse",
        data: "Copilot returned a malformed or empty streaming response.",
      };
    }

    yield { type: "done", data: { threadId: null } };

  } else {
    const err = new Error(
      "No LLM provider configured. Set Azure env vars (PROJECT_ENDPOINT, AGENT_NAME, AGENT_VERSION) or GEMINI_API_KEY.",
    );
    err.code = "ProviderUnavailable";
    throw err;
  }
}

module.exports = {
  planWithProvider,
  continueWithProvider,
  streamWithProvider,
  haveAzureEnv,
  listProviderTools,
  parseAgentPlan,
  normalizeActions,
  resolveReplyText,
  describeActionsReply,
  fallbackMessage,
  normalizeTextPlan,
  normalizeAzureProviderResult,
  normalizeStreamingCompletion,
  buildToolResultContinuationPrompt,
  buildAzureInstructions,
  resolveProviderSelection,
  formatToolDescription,
  formatToolDescriptions,
  buildProviderTools,
  extractBalancedJsonObject,
  extractJsonPlanCandidate,
  looksLikeStructuredPlan,
  normalizeCitations,
  inferToolCategory,
  runAzureWithToolFallback,
  continueAzureWithToolFallback,
  normalizeUserReplyLineBreaks,
};
