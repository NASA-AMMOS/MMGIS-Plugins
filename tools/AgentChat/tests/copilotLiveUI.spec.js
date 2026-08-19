import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLayerArguments } from "../layerArgumentResolver";

const LIVE_ENABLED = process.env.COPILOT_LIVE_UI === "true";
const REAL_PROVIDER_ENABLED = process.env.COPILOT_REAL_PROVIDER === "true";
const REAL_EXAMPLES_ENABLED = process.env.COPILOT_REAL_EXAMPLES === "true";
const LIVE_MISSION = process.env.COPILOT_LIVE_MISSION || "Frozon";
const SYNTHETIC_PROVIDER_MISSION = "CopilotPublicNavigationValidation";
const GENERIC_EMPTY_REPLY =
  "Copilot didn't return a response for that. Please try rephrasing or try again.";
const GENERIC_FAILURE_REPLY =
  /did(?: not|n't) return|try rephrasing|agent request failed|unexpected (?:agent|server|tool) error|internal server error/i;
const INFRASTRUCTURE_ERROR_CODES = new Set([
  "EMPTY_RENDERER_RESULT",
  "INVALID_TOOL_RESULT",
  "MALFORMED_RESPONSE",
  "RENDERER_FAILED",
  "TOOL_NOT_REGISTERED",
  "UNSAFE_MMGIS_API_METHOD",
  "UNSUPPORTED_ADAPTER",
]);
const DETERMINISTIC_UI_TOOLS = new Set([
  "zoom_to",
  "list_layers",
  "list_analyzable_layers",
  "toggle_layer",
  "set_layer_opacity",
  "describe_layer",
]);
const FIXTURE_DEPENDENT_LIMITATIONS = Object.freeze({
  statistics_first_visible: new Set(["NO_VISIBLE_ANALYZABLE_LAYER"]),
  set_time: new Set([
    "TIME_UPDATE_FAILED",
    "LAYER_NOT_FOUND",
    "LAYER_RESOLUTION_FAILED",
  ]),
  highlight_relative_to_mean: new Set([
    "UNSUPPORTED_ANALYSIS",
    "LAYER_NOT_FOUND",
    "LAYER_RESOLUTION_FAILED",
    "AMBIGUOUS_LAYER",
    "HIGHLIGHT_SOURCE_UNAVAILABLE",
  ]),
  threshold_highlight: new Set([
    "UNSUPPORTED_ANALYSIS",
    "LAYER_NOT_FOUND",
    "LAYER_RESOLUTION_FAILED",
    "AMBIGUOUS_LAYER",
    "HIGHLIGHT_SOURCE_UNAVAILABLE",
  ]),
  calculate_layer_difference: new Set([
    "UNSUPPORTED_ANALYSIS",
    "LAYER_NOT_FOUND",
    "LAYER_RESOLUTION_FAILED",
    "AMBIGUOUS_LAYER",
  ]),
});
const CLARIFICATION_OR_LIMITATION_REPLY =
  /\?|please (?:specify|choose|clarify)|no .+ (?:available|visible|selected)|not available|cannot|can't|unsupported|requires?|unable/i;
const RGB_MEAN_QUERY = "Calculate mean for GIBS MODIS True Color";
const FORECAST_JANUARY_QUERY = "Show me the sea ice forecast for January 2024";
const PREDICTION_GROUND_TRUTH_QUERY =
  "Show the difference between predicted and ground truth ice";
const ACTIVE_LAYER_HIGHLIGHT_QUERY =
  "Highlight areas where the current layer exceeds its average value";
const PREDICTED_CONCENTRATION_TODAY_QUERY =
  "What is the predicted sea ice concentration today?";
const LAST_WEEK_COMPARISON_QUERY =
  "Compare the AI prediction with ground truth for last week";
const LAND_MASK_COMPARISON_QUERY = "Compare Land Mask vs Ice Forecast";
const TURN_ON_DATA_LAYER_QUERY = "Turn on a data layer to analyze";
const SHOW_AVAILABLE_DATA_LAYERS_QUERY = "Show available data layers";

const pluginRoot = resolve(process.cwd(), "plugins/NASA-AMMOS--MMGIS-Plugins");
const exampleConfig = JSON.parse(
  readFileSync(
    resolve(pluginRoot, "backend/Agent/config/copilot_demo_queries.json"),
    "utf8",
  ),
);
const registry = JSON.parse(
  readFileSync(resolve(pluginRoot, "backend/Agent/tool-registry.json"), "utf8"),
);
const STATIC_QUERIES = exampleConfig.queries;

function resultErrorCode(result) {
  return result?.error?.code || result?.errorCode || null;
}

function candidateNamed(live, name) {
  const normalized = String(name || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const exact = (live?.candidates || []).find(
    (candidate) => candidate.displayName.toLowerCase() === normalized,
  );
  if (exact) return exact;
  if (/^(?:predicted|prediction|forecast)$/.test(normalized)) {
    return (live?.candidates || []).find((candidate) =>
      /\b(?:prediction|forecast)\b/i.test(candidate.displayName),
    );
  }
  if (/^(?:ground truth(?: ice)?|observed|observation)$/.test(normalized)) {
    return (live?.candidates || []).find((candidate) =>
      /\b(?:ground truth|observed|observation)\b/i.test(candidate.displayName),
    );
  }
  return null;
}

function fixturePrerequisiteFor(action, live) {
  const tool = action?.tool;
  const args = action?.args || {};
  if (tool === "statistics_first_visible") {
    return (live?.analysisLayers || []).some((candidate) => candidate.visible);
  }
  if (tool === "set_time") {
    const requested = Array.isArray(args.layers) ? args.layers : [];
    return requested.length
      ? requested.every(
          (name) => candidateNamed(live, name)?.timeEnabled === true,
        )
      : !!live?.timeLayer;
  }
  if (tool === "highlight_relative_to_mean" || tool === "threshold_highlight") {
    const target = candidateNamed(
      live,
      args.layer_name || args.name || args.layer,
    );
    return target?.analyzable === true && target?.rgb !== true;
  }
  if (tool === "calculate_layer_difference") {
    const first = candidateNamed(live, args.layer_a);
    const second = candidateNamed(live, args.layer_b);
    return (
      first?.analyzable === true &&
      second?.analyzable === true &&
      first.id !== second.id
    );
  }
  return null;
}

function assertMeaningfulToolOutcomes(
  query,
  results,
  { live = null, actions = [] } = {},
) {
  expect(results.length, query).toBeGreaterThan(0);
  for (const result of results) {
    const message = String(result?.message || "").trim();
    expect(message.length, query).toBeGreaterThan(0);
    expect(message, query).not.toMatch(GENERIC_FAILURE_REPLY);
    const action = actions.find(
      (candidate) =>
        candidate.callId === result.callId || candidate.tool === result.tool,
    );
    const prerequisite = fixturePrerequisiteFor(action, live);
    if (prerequisite === true) {
      expect(
        result.ok,
        `${query} (${result.tool}) had a matching live fixture but failed: ${message}`,
      ).toBe(true);
    } else if (
      prerequisite === false &&
      result.ok !== true &&
      FIXTURE_DEPENDENT_LIMITATIONS[result.tool]
    ) {
      const code = resultErrorCode(result);
      expect(
        FIXTURE_DEPENDENT_LIMITATIONS[result.tool].has(code),
        `${query} (${result.tool}): unexpected prerequisite limitation ${code}`,
      ).toBe(true);
    } else if (DETERMINISTIC_UI_TOOLS.has(result.tool)) {
      expect(result.ok, `${query} (${result.tool}): ${message}`).toBe(true);
    } else if (result.ok !== true) {
      const code = resultErrorCode(result);
      expect(code, `${query}: ${message}`).toBeTruthy();
      expect(
        INFRASTRUCTURE_ERROR_CODES.has(code),
        `${query}: unexpected infrastructure failure ${code}`,
      ).toBe(false);
    }
    const statistics = result?.data?.stats || result?.data?.statistics;
    if (result.ok === true && statistics?.valid_range) {
      const [minimum, maximum] = statistics.valid_range.map(Number);
      expect(
        Number(statistics.min),
        `${query}: minimum`,
      ).toBeGreaterThanOrEqual(minimum);
      expect(Number(statistics.max), `${query}: maximum`).toBeLessThanOrEqual(
        maximum,
      );
    }
    if (result.ok === true && statistics?.unit) {
      expect(message, `${query}: declared statistics unit`).toContain(
        statistics.unit,
      );
    }
    if (result.ok === true && statistics?.value_expression) {
      expect(message, `${query}: applied scalar expression`).toContain(
        statistics.value_expression,
      );
    }
  }
}

function contextLayerByRole(context, role) {
  const layers = Array.isArray(context?.layers) ? context.layers : [];
  const pattern =
    role === "prediction"
      ? /\b(?:prediction|predicted|forecast)\b/i
      : /\b(?:ground\s+truth|observed|observation|reference)\b/i;
  const matches = layers.filter((layer) =>
    pattern.test(
      [
        layer?.display_name,
        layer?.canonical_name,
        ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
      ]
        .filter(Boolean)
        .join(" "),
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function contextActiveLayer(context) {
  const activeName =
    typeof context?.activeLayer === "string"
      ? context.activeLayer
      : context?.activeLayer?.name || context?.activeLayer?.display_name;
  if (!activeName) return null;
  const normalized = String(activeName).trim().toLowerCase();
  const matches = (context.layers || []).filter((layer) =>
    [
      layer?.display_name,
      layer?.canonical_name,
      ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
    ].some(
      (candidate) =>
        String(candidate || "")
          .trim()
          .toLowerCase() === normalized,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function isUiAnchoredCurrentDayInterval(action, context) {
  const startText = action?.args?.time_start;
  const endText = action?.args?.time_end;
  const currentText = context?.temporal?.current;
  if (
    typeof startText !== "string" ||
    typeof endText !== "string" ||
    typeof currentText !== "string"
  )
    return false;

  const start = new Date(startText);
  const end = new Date(endText);
  const current = new Date(currentText);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    !Number.isFinite(current.getTime()) ||
    start >= end ||
    current < start ||
    current > end
  )
    return false;

  const utcDay = (date) =>
    [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()].join("-");
  const nextUtcMidnight = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate() + 1,
  );
  return (
    utcDay(start) === utcDay(current) &&
    (utcDay(end) === utcDay(current) || end.getTime() === nextUtcMidnight)
  );
}

function baselineMatchesSanitizedCurrent(context, baselineProof) {
  if (baselineProof?.verified !== true) return false;
  const expected = Date.parse(context?.temporal?.current);
  const globalTime = Date.parse(baselineProof?.globalTime);
  const layerStartTime = Date.parse(baselineProof?.layerStartTime);
  const layerEndTime = Date.parse(baselineProof?.layerEndTime);
  return (
    Number.isFinite(expected) &&
    globalTime === expected &&
    layerStartTime === expected &&
    layerEndTime === expected &&
    baselineProof?.forecastVisible === true
  );
}

function isVerifiedImplicitUiCurrent(action, context, baselineProof) {
  const startText = String(action?.args?.time_start || "").trim();
  const endText = String(action?.args?.time_end || "").trim();
  return (
    !startText &&
    !endText &&
    baselineMatchesSanitizedCurrent(context, baselineProof)
  );
}

function isVerifiedUiCurrentPoint(action, context, baselineProof) {
  const start = Date.parse(action?.args?.time_start);
  const end = Date.parse(action?.args?.time_end);
  const expected = Date.parse(context?.temporal?.current);
  return (
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    Number.isFinite(expected) &&
    start === expected &&
    end === expected &&
    baselineMatchesSanitizedCurrent(context, baselineProof)
  );
}

function hasUiAnchoredStatisticsTime(action, context, baselineProof) {
  const hasStart = !!String(action?.args?.time_start || "").trim();
  const hasEnd = !!String(action?.args?.time_end || "").trim();
  if (hasStart || hasEnd)
    return (
      hasStart &&
      hasEnd &&
      (isUiAnchoredCurrentDayInterval(action, context) ||
        isVerifiedUiCurrentPoint(action, context, baselineProof))
    );
  return isVerifiedImplicitUiCurrent(action, context, baselineProof);
}

function supportedContextLayers(context) {
  return (Array.isArray(context?.layers) ? context.layers : []).filter(
    (layer) =>
      layer?.analysis?.supported === true &&
      layer?.analysis?.scalar === true &&
      Array.isArray(layer?.analysis?.operations) &&
      layer.analysis.operations.length > 0,
  );
}

function contextLayerByName(context, requestedName) {
  const normalized = String(requestedName || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  const matches = (context?.layers || []).filter((layer) =>
    [
      layer?.display_name,
      layer?.canonical_name,
      ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
    ].some(
      (candidate) =>
        String(candidate || "")
          .trim()
          .toLowerCase() === normalized,
    ),
  );
  return matches.length === 1 ? matches[0] : null;
}

function expectedDataLayerActivationPlan(context) {
  return supportedContextLayers(context).length
    ? {
        kind: "analyzable-layer-action",
        tools: [
          "toggle_layer",
          "list_analyzable_layers",
          "calculate_layer_mean",
        ],
      }
    : {
        kind: "clarification-or-action",
        tools: ["list_analyzable_layers"],
      };
}

function expectedStaticPlan(query, context = {}) {
  if (/^(?:What is MMGIS\?|Tell me about MMGIS)$/i.test(query))
    return { kind: "information", tools: [] };
  if (
    /^(?:List layers|What layers are available|Show available data layers)/i.test(
      query,
    )
  )
    return query === SHOW_AVAILABLE_DATA_LAYERS_QUERY
      ? {
          kind: "list-layers-or-grounded-data-inventory",
          tools: ["list_layers"],
        }
      : { kind: "action", tools: ["list_layers"] };
  if (/Which layers can I analyze|Show analyzable layers/i.test(query))
    return { kind: "action", tools: ["list_analyzable_layers"] };
  if (/statistics of the first visible/i.test(query))
    return { kind: "action", tools: ["statistics_first_visible"] };
  if (/^(?:Move the time slider|Set time to)/i.test(query))
    return { kind: "action", tools: ["set_time"] };
  if (/^Turn on the forecast prediction layer/i.test(query))
    return {
      kind: "layer-visible-or-toggle",
      tools: ["toggle_layer"],
      targetLayer: "Ice Forecast",
    };
  if (query === LAND_MASK_COMPARISON_QUERY)
    return {
      kind: "land-mask-limitation",
      tools: ["calculate_layer_difference"],
    };
  if (query === RGB_MEAN_QUERY)
    return {
      kind: "unsupported-tool-or-explanation",
      tools: ["calculate_layer_mean"],
    };
  if (query === FORECAST_JANUARY_QUERY) {
    const forecast = contextLayerByRole(context, "prediction");
    const forecastIsHidden = forecast?.visible === false;
    return {
      kind: "action-required-optional",
      tools: forecastIsHidden ? ["toggle_layer", "set_time"] : ["set_time"],
      optionalTools: forecastIsHidden ? [] : ["toggle_layer"],
      successTools: forecastIsHidden
        ? ["toggle_layer", "set_time"]
        : ["set_time"],
    };
  }
  if (query === PREDICTION_GROUND_TRUTH_QUERY) {
    const prediction = contextLayerByRole(context, "prediction");
    const groundTruth = contextLayerByRole(context, "ground-truth");
    return prediction && groundTruth
      ? { kind: "action", tools: ["calculate_layer_difference"] }
      : {
          kind: "clarification-or-action",
          tools: ["calculate_layer_difference"],
        };
  }
  if (query === ACTIVE_LAYER_HIGHLIGHT_QUERY) {
    const active = contextActiveLayer(context);
    const operations = active?.analysis?.operations || [];
    const grounded =
      active?.analysis?.supported === true &&
      operations.some((operation) =>
        ["threshold", "highlight"].includes(String(operation).toLowerCase()),
      );
    return grounded
      ? {
          kind: "action-any",
          tools: ["highlight_relative_to_mean", "threshold_highlight"],
        }
      : {
          kind: "clarification-or-action",
          tools: ["highlight_relative_to_mean", "threshold_highlight"],
        };
  }
  if (query === PREDICTED_CONCENTRATION_TODAY_QUERY)
    return {
      kind: "action-current-ui-day-or-area-clarification",
      tools: ["calculate_layer_mean"],
      optionalTools: ["set_time"],
    };
  if (query === LAST_WEEK_COMPARISON_QUERY)
    return {
      kind: "last-week-comparison-limitation",
      tools: [],
    };
  if (/sea ice extent trend/i.test(query))
    return {
      kind: "temporal-trend-or-grounded-layer-clarification",
      tools: ["temporal_trends"],
    };
  if (/^Zoom (?:to|into)/i.test(query))
    return /current area of interest/i.test(query)
      ? { kind: "aoi-zoom-or-grounded-clarification", tools: ["zoom_to"] }
      : { kind: "action", tools: ["zoom_to"] };
  if (query === TURN_ON_DATA_LAYER_QUERY)
    return expectedDataLayerActivationPlan(context);
  if (/^Highlight /i.test(query))
    return {
      kind: "clarification-or-action",
      tools: ["highlight_relative_to_mean", "threshold_highlight"],
    };
  if (
    /difference between predicted and ground truth|AI prediction with ground truth/i.test(
      query,
    )
  )
    return {
      kind: "clarification-or-action",
      tools: ["calculate_layer_difference"],
    };
  return { kind: "information-or-clarification", tools: [] };
}

function expectedConfiguredPlan({ family, query }, context = {}) {
  if (family === "static") return expectedStaticPlan(query, context);
  if (family === "zoom") return { kind: "action", tools: ["zoom_to"] };
  if (family === "dynamic:visibleAnalyzable") {
    if (/highlight/i.test(query))
      return {
        kind: "action-any",
        tools: ["highlight_relative_to_mean", "threshold_highlight"],
      };
    if (/changes over time/i.test(query))
      return { kind: "action", tools: ["temporal_trends"] };
    if (/^Analyze\s+/i.test(query))
      return {
        kind: "analysis-action-or-grounded-operation-clarification",
        tools: ["calculate_layer_mean"],
        targetLayer: query.replace(/^Analyze\s+/i, "").trim(),
      };
    return {
      kind: "action-any",
      tools: ["calculate_layer_mean"],
    };
  }
  if (family === "dynamic:timeEnabled") {
    if (/^Animate /i.test(query))
      return { kind: "grounded-animation-unavailable", tools: [] };
    return { kind: "information", tools: [] };
  }
  if (family === "dynamic:comparison")
    return { kind: "action", tools: ["calculate_layer_difference"] };
  if (family === "dynamic:fallback")
    return /^Show available/i.test(query)
      ? { kind: "action", tools: ["list_layers"] }
      : expectedDataLayerActivationPlan(context);
  if (family === "contextual:layers") {
    if (/layers are available/i.test(query))
      return { kind: "action", tools: ["list_layers"] };
    if (/opacity/i.test(query))
      return {
        kind: "clarification-or-action",
        tools: ["set_layer_opacity"],
      };
    return {
      kind: "clarification-or-action",
      tools: ["describe_layer", "layer_information"],
    };
  }
  if (family === "contextual:time") {
    if (/latest|January 2024/i.test(query))
      return {
        kind: "clarification-or-action",
        tools: ["set_time"],
      };
    return { kind: "information", tools: [] };
  }
  if (family === "contextual:analysis") {
    if (/statistics/i.test(query))
      return {
        kind: "action-any",
        tools: ["statistics_first_visible", "calculate_layer_mean"],
      };
    if (/highlight/i.test(query))
      return {
        kind: "clarification-or-action",
        tools: ["highlight_relative_to_mean", "threshold_highlight"],
      };
    if (/visible analyzable layers/i.test(query))
      return {
        kind: "visible-analyzable-comparison",
        tools: ["calculate_layer_difference"],
      };
    return { kind: "clarification", tools: [] };
  }
  if (family === "contextual:navigation")
    return /layers/i.test(query)
      ? { kind: "action", tools: ["list_layers"] }
      : { kind: "action", tools: ["zoom_to"] };
  return { kind: "information-or-clarification", tools: [] };
}

function normalizeSemanticResponse(response) {
  return String(response || "")
    .normalize("NFKC")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[’‘ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/(?:\*\*|__|~~|`)/g, "")
    .replace(/(^|[\s(])[_*](?=\S)/g, "$1")
    .replace(/(?<=\S)[_*](?=$|[\s).,!?;:])/g, "")
    .trim();
}

function isGroundedCurrentLayerAmbiguity(response) {
  const text = normalizeSemanticResponse(response);
  const identifiesAmbiguity = text
    .split(/[.!?\n]+/)
    .some(
      (sentence) =>
        /\b(?:can't|cannot|unable|do not|don't|no|not available|unavailable|unknown)\b/i.test(
          sentence,
        ) &&
        /\blayer\b/i.test(sentence) &&
        /\b(?:current|active|visible|available UI state|layer context)\b/i.test(
          sentence,
        ),
    );
  const requestsLayer =
    /\b(?:please )?(?:name|specify|choose|select)\b[^.]{0,60}\blayer\b/i.test(
      text,
    ) ||
    /\b(?:tell|let) me\b[^.]{0,50}\blayer(?: name)?\b/i.test(text) ||
    /\bwhich layer\b[^?]{0,60}\?/i.test(text);
  return identifiesAmbiguity && requestsLayer;
}

function contextLayerNames(layer) {
  return [
    layer?.display_name,
    layer?.canonical_name,
    ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
  ]
    .map((name) => String(name || "").trim().toLowerCase())
    .filter(Boolean);
}

function textMentionsContextLayer(text, layer) {
  const normalizedText = String(text || "").toLowerCase();
  return contextLayerNames(layer).some((name) => normalizedText.includes(name));
}

function layerSupportsComparison(layer) {
  return (
    layer?.analysis?.supported === true &&
    layer?.analysis?.scalar === true &&
    Array.isArray(layer?.analysis?.operations) &&
    layer.analysis.operations.some(
      (operation) => String(operation).toLowerCase() === "comparison",
    )
  );
}

function classifyVisibleAnalyzableComparisonOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
} = {}) {
  const analyzableLayers = supportedContextLayers(context);
  const visibleLayers = analyzableLayers.filter(
    (layer) => layer?.visible === true,
  );
  const hiddenComparisonLayers = analyzableLayers.filter(
    (layer) => layer?.visible === false && layerSupportsComparison(layer),
  );

  if (actions.length > 0) {
    if (
      visibleLayers.length < 2 ||
      !actions.every((action) => action?.tool === "calculate_layer_difference")
    )
      return null;
    const results = correlateToolResults(actions, toolResults);
    const allActionsAreGrounded = actions.every((action, index) => {
      const layerA = contextLayerByName(context, action?.args?.layer_a);
      const layerB = contextLayerByName(context, action?.args?.layer_b);
      return (
        layerA &&
        layerB &&
        layerA !== layerB &&
        visibleLayers.includes(layerA) &&
        visibleLayers.includes(layerB) &&
        layerSupportsComparison(layerA) &&
        layerSupportsComparison(layerB) &&
        results[index]?.ok === true
      );
    });
    return allActionsAreGrounded ? "tool-success" : null;
  }

  if (toolResults.length > 0 || visibleLayers.length !== 1) return null;
  const text = normalizeSemanticResponse(response);
  if (!textMentionsContextLayer(text, visibleLayers[0])) return null;
  const statesVisibleLayerCardinality =
    /\b(?:only|just)\b[^.!?\n]{0,80}\b(?:one|1)\b[^.!?\n]{0,80}\bvisible\b[^.!?\n]{0,50}\banalyz(?:able|e)\b/i.test(
      text,
    ) ||
    /\bthe only\b[^.!?\n]{0,50}\bvisible\b[^.!?\n]{0,50}\banalyz(?:able|e)\b/i.test(
      text,
    ) ||
    /\b(?:need|require)\b[^.!?\n]{0,50}\b(?:two|2)\b[^.!?\n]{0,80}\bvisible\b[^.!?\n]{0,50}\banalyz(?:able|e)\b/i.test(
      text,
    ) ||
    /\b(?:not|no)\b[^.!?\n]{0,50}\b(?:multiple|two|2|enough)\b[^.!?\n]{0,80}\bvisible\b[^.!?\n]{0,50}\banalyz(?:able|e)\b/i.test(
      text,
    );
  if (!statesVisibleLayerCardinality) return null;

  const sentences = text
    .split(/(?:[\n.!?]+|;\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const offersLayerAction = (sentence) =>
    /\b(?:compare|turn(?:ed)? on|enable|show|add|make\b[^.]{0,30}\bvisible)\b/i.test(
      sentence,
    );
  const offeredHiddenLayers = hiddenComparisonLayers.filter((layer) =>
    sentences.some(
      (sentence) =>
        offersLayerAction(sentence) && textMentionsContextLayer(sentence, layer),
    ),
  );
  const knownInvalidOffer = (Array.isArray(context?.layers)
    ? context.layers
    : []
  )
    .filter(
      (layer) =>
        !hiddenComparisonLayers.includes(layer) &&
        layer !== visibleLayers[0],
    )
    .some((layer) =>
      sentences.some(
        (sentence) =>
          offersLayerAction(sentence) &&
          textMentionsContextLayer(sentence, layer),
      ),
    );
  if (knownInvalidOffer) return null;
  const asksForSecondLayer =
    /\b(?:which|what)\b[^.!?\n]{0,40}\b(?:second|other|additional)\b[^.!?\n]{0,30}\blayer\b/i.test(
      text,
    ) ||
    /\b(?:choose|specify|select|name)\b[^.!?\n]{0,50}\b(?:second|other|additional)\b[^.!?\n]{0,30}\blayer\b/i.test(
      text,
    );
  return offeredHiddenLayers.length === 1 ||
    (offeredHiddenLayers.length === 0 && asksForSecondLayer)
    ? "grounded-clarification"
    : null;
}

function classifyLayerVisibilityOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
  targetLayerName = "",
} = {}) {
  const target = contextLayerByName(context, targetLayerName);
  if (!target) return null;
  if (actions.length > 0) {
    if (
      target.visible !== false ||
      actions.length !== 1 ||
      actions[0]?.tool !== "toggle_layer" ||
      actions[0]?.args?.visible !== true ||
      contextLayerByName(context, actions[0]?.args?.name) !== target
    )
      return null;
    const [result] = correlateToolResults(actions, toolResults);
    return result?.ok === true ? "tool-success" : null;
  }
  if (toolResults.length > 0 || target.visible !== true) return null;

  const text = normalizeSemanticResponse(response);
  const claimSentences = text
    .split(/(?:[\n.!?]+|;\s+)/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        /\balready\b[^.]{0,50}\b(?:visible|on|enabled|turned on)\b/i.test(
          sentence,
        ) ||
        /\b(?:visible|on|enabled|turned on)\b[^.]{0,50}\balready\b/i.test(
          sentence,
        ),
    );
  const claimedLayers = (Array.isArray(context?.layers) ? context.layers : [])
    .filter((layer) =>
      claimSentences.some((sentence) =>
        textMentionsContextLayer(sentence, layer),
      ),
    );
  return claimSentences.length > 0 &&
    claimedLayers.length === 1 &&
    claimedLayers[0] === target
    ? "grounded-already-visible"
    : null;
}

function isGroundedRgbUnsupportedExplanation(response) {
  const text = normalizeSemanticResponse(response);
  return (
    /\b(?:RGB|true color|visualization[- ]only)\b/i.test(text) &&
    /\b(?:scalar|numeric(?:al)?|pixel values?)\b/i.test(text) &&
    /\b(?:mean|average|statistics?|analysis|analyz(?:e|able|ing))\b/i.test(
      text,
    ) &&
    /\b(?:cannot|can't|does not|doesn't|no |not |without|unsupported)\b/i.test(
      text,
    )
  );
}

function classifyDataLayerInventoryOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
} = {}) {
  if (actions.length > 0) {
    if (!actions.every((action) => action?.tool === "list_layers")) return null;
    const results = correlateToolResults(actions, toolResults);
    return results.every((result) => result?.ok === true)
      ? "tool-success"
      : null;
  }
  if (toolResults.length > 0) return null;

  const layers = Array.isArray(context?.layers) ? context.layers : [];
  const dataLayers = layers.filter(
    (layer) => String(layer?.type || "").toLowerCase() === "data",
  );
  if (!dataLayers.length) return null;
  const layerNames = (layer) =>
    [
      layer?.display_name,
      layer?.canonical_name,
      ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
    ]
      .map((name) =>
        String(name || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
  const text = normalizeSemanticResponse(response);
  const normalizedText = text.toLowerCase();
  const nonDataNames = layers
    .filter((layer) => String(layer?.type || "").toLowerCase() !== "data")
    .flatMap(layerNames);
  if (nonDataNames.some((name) => normalizedText.includes(name))) return null;

  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*•]|\d+[.)])\s+/.test(line));
  if (entries.length !== dataLayers.length) return null;
  const matchedLayers = new Set();
  for (const entry of entries) {
    const normalizedEntry = entry.toLowerCase();
    const matchingIndexes = dataLayers
      .map((layer, index) =>
        layerNames(layer).some((name) => normalizedEntry.includes(name))
          ? index
          : -1,
      )
      .filter((index) => index >= 0);
    if (matchingIndexes.length !== 1) return null;
    const index = matchingIndexes[0];
    if (matchedLayers.has(index)) return null;
    const hasVisibilityStatus =
      /\b(?:visible|hidden|enabled|disabled|on|off)\b/i.test(entry);
    const hasCapabilityStatus =
      /\b(?:analyz\w*|analysis|time[- ]enabled|time[- ]invariant|reference mask|scalar|unsupported)\b/i.test(
        entry,
      );
    if (!hasVisibilityStatus || !hasCapabilityStatus) return null;
    matchedLayers.add(index);
  }
  return matchedLayers.size === dataLayers.length ? "grounded-inventory" : null;
}

function isGroundedLastWeekComparisonLimitation(response) {
  const text = normalizeSemanticResponse(response);
  const distinctIsoDates = new Set(text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  const identifiesBothRoles =
    /\b(?:AI )?(?:prediction|forecast)\b/i.test(text) &&
    /\b(?:ground\s+truth|observed|observation)\b/i.test(text);
  const identifiesRequestedWindow =
    /\bweek\b/i.test(text) &&
    (/\b(?:range|window|interval)\b/i.test(text) ||
      /\b(?:across|over) (?:the )?last week\b/i.test(text) ||
      distinctIsoDates.size >= 2);
  const identifiesSingleTimeConstraint =
    (/\b(?:single|one) (?:map )?(?:time|date|timestamp|snapshot)\b/i.test(
      text,
    ) ||
      /\b(?:snapshot|no (?:temporal )?aggregation|does not aggregate)\b/i.test(
        text,
      )) &&
    /\b(?:not|only|support(?:s|ed)?|cannot|can't|unable|limited)\b/i.test(text);
  const offersExplicitAlternative =
    /\bcurrent map time\b/i.test(text) ||
    /\b(?:single|specific(?: exact)?|chosen) date\b/i.test(text) ||
    /\bwhich date\b/i.test(text) ||
    /\bend of (?:the )?(?:last )?week\b/i.test(text);
  return (
    identifiesBothRoles &&
    identifiesRequestedWindow &&
    identifiesSingleTimeConstraint &&
    offersExplicitAlternative
  );
}

function isGroundedPredictedConcentrationAreaClarification(response, context) {
  const text = normalizeSemanticResponse(response);
  const expectedCurrent = String(context?.temporal?.current || "").trim();
  const expectedCurrentDay = Number.isFinite(Date.parse(expectedCurrent))
    ? new Date(expectedCurrent).toISOString().slice(0, 10)
    : "";
  const identifiesRequestedValue =
    /\b(?:prediction|predicted|forecast)\b/i.test(text) &&
    /\bsea\s+ice\b/i.test(text) &&
    /\bconcentration\b/i.test(text);
  const anchorsRequestedTime =
    (expectedCurrent && text.includes(expectedCurrent)) ||
    (expectedCurrentDay &&
      text.includes(expectedCurrentDay) &&
      /\bcurrent\b[^.]{0,40}\b(?:time|date)\b/i.test(text)) ||
    /\b(?:today|current (?:map |temporal )?(?:time|setting))\b/i.test(text);
  const explainsSpatialAmbiguity =
    /\bspatial(?:ly)? (?:variable|varying)\b/i.test(text) ||
    /\b(?:depends?|dependent)\b[^.]{0,30}\bon\b[^.]{0,25}\b(?:location|area|region|extent|scope)\b/i.test(
      text,
    ) ||
    /\b(?:varies|varying|differs)\b[^.]{0,40}\b(?:by|across)\b[^.]{0,30}\b(?:location|area|region|space)\b/i.test(
      text,
    ) ||
    /\bwithout (?:a )?(?:location|area|region|extent)\b/i.test(text) ||
    /\b(?:need|specify|provide|choose|tell me)\b[^.]{0,60}\b(?:location|area|region|extent|scope|bounds)\b/i.test(
      text,
    ) ||
    /\b(?:area|region|extent)\b[^.]{0,80}\b(?:specify|choose|needed|required|missing)\b/i.test(
      text,
    ) ||
    /\b(?:specify|choose)\b[^.]{0,80}\b(?:area|region|extent)\b/i.test(text);
  const offersGroundedAreaChoice =
    /\bcurrent view\b/i.test(text) ||
    /\b(?:named|specific) region\b/i.test(text);
  return (
    identifiesRequestedValue &&
    anchorsRequestedTime &&
    explainsSpatialAmbiguity &&
    offersGroundedAreaChoice
  );
}

function classifyPredictedTodayActionOutcome({
  actions = [],
  toolResults = [],
  context = {},
  baselineProof = null,
} = {}) {
  if (!actions.length) return null;
  const allowedTools = new Set(["set_time", "calculate_layer_mean"]);
  if (!actions.every((action) => allowedTools.has(action?.tool))) return null;
  const meanIndexes = actions
    .map((action, index) =>
      action?.tool === "calculate_layer_mean" ? index : -1,
    )
    .filter((index) => index >= 0);
  const setTimeIndexes = actions
    .map((action, index) => (action?.tool === "set_time" ? index : -1))
    .filter((index) => index >= 0);
  if (
    meanIndexes.length !== 1 ||
    setTimeIndexes.length > 1 ||
    (setTimeIndexes.length === 1 && setTimeIndexes[0] > meanIndexes[0])
  )
    return null;

  const forecast = contextLayerByRole(context, "prediction");
  if (!forecast || !baselineMatchesSanitizedCurrent(context, baselineProof))
    return null;
  const results = correlateToolResults(actions, toolResults);
  if (results.some((result) => result?.ok !== true)) return null;

  const meanAction = actions[meanIndexes[0]];
  if (
    contextLayerByName(context, meanAction?.args?.layer_name) !== forecast ||
    !hasUiAnchoredStatisticsTime(meanAction, context, baselineProof)
  )
    return null;

  if (setTimeIndexes.length === 1) {
    const setTimeAction = actions[setTimeIndexes[0]];
    const requestedTime = Date.parse(setTimeAction?.args?.time);
    const expectedTime = Date.parse(context?.temporal?.current);
    const requestedLayers = Array.isArray(setTimeAction?.args?.layers)
      ? setTimeAction.args.layers
      : [];
    if (
      !Number.isFinite(requestedTime) ||
      !Number.isFinite(expectedTime) ||
      requestedTime !== expectedTime ||
      requestedLayers.length !== 1 ||
      contextLayerByName(context, requestedLayers[0]) !== forecast
    )
      return null;
  }
  return "tool-success";
}

function actionMatchesContextAoi(action, context) {
  if (action?.tool !== "zoom_to") return false;
  const target = context?.areaOfInterest || context?.map?.areaOfInterest;
  if (!target || typeof target !== "object") return false;
  const expectedBbox = Array.isArray(target.bbox)
    ? target.bbox.map(Number)
    : null;
  const actionBbox = Array.isArray(action?.args?.bbox)
    ? action.args.bbox.map(Number)
    : null;
  if (
    expectedBbox?.length === 4 &&
    actionBbox?.length === 4 &&
    expectedBbox.every(
      (value, index) =>
        Number.isFinite(value) &&
        Number.isFinite(actionBbox[index]) &&
        Math.abs(actionBbox[index] - value) <= 1e-8,
    )
  )
    return true;
  const expectedName = String(target.name || target.region || "")
    .trim()
    .toLowerCase();
  const actionRegion = String(action?.args?.region || "")
    .trim()
    .toLowerCase();
  return !!expectedName && actionRegion === expectedName;
}

function classifyAoiZoomOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
} = {}) {
  if (actions.length > 0) {
    if (!actions.every((action) => actionMatchesContextAoi(action, context)))
      return null;
    const results = correlateToolResults(actions, toolResults);
    return results.every((result) => result?.ok === true)
      ? "tool-success"
      : null;
  }
  if (toolResults.length > 0) return null;
  const text = normalizeSemanticResponse(response);
  const identifiesAoi = /\b(?:current )?(?:area of interest|AOI)\b/i.test(text);
  const statesAoiIsMissing =
    /\b(?:no|without|missing|absent|undefined|unselected)\b[^.]{0,80}\b(?:area of interest|AOI|target)\b/i.test(
      text,
    ) ||
    /\b(?:area of interest|AOI|target)\b[^.]{0,80}\b(?:not (?:defined|selected|set)|missing|absent|undefined)\b/i.test(
      text,
    ) ||
    /\b(?:do not|don't|does not|doesn't) have\b[^.]{0,100}\b(?:area of interest|AOI|target)\b/i.test(
      text,
    );
  const offersResolvableTarget =
    /\b(?:named|specific) region\b/i.test(text) ||
    /\bcurrent[- ]view bounds\b/i.test(text) ||
    /\bcoordinates?\b/i.test(text) ||
    /\b(?:bounding box|bbox)\b/i.test(text);
  const requestsOrOffersChoice =
    /\b(?:tell me|specify|choose|select|provide|give me)\b/i.test(text) ||
    /\bif you (?:want|prefer)\b/i.test(text) ||
    /\bwould you like\b/i.test(text) ||
    /\bshould I use\b/i.test(text);
  return identifiesAoi &&
    statesAoiIsMissing &&
    offersResolvableTarget &&
    requestsOrOffersChoice
    ? "grounded-clarification"
    : null;
}

function temporalTrendCandidates(context) {
  return (Array.isArray(context?.layers) ? context.layers : []).filter(
    (layer) =>
      layer?.time?.enabled === true &&
      layer?.analysis?.supported === true &&
      layer?.analysis?.scalar === true &&
      Array.isArray(layer?.analysis?.operations) &&
      layer.analysis.operations.some(
        (operation) => String(operation).toLowerCase() === "temporal-trends",
      ),
  );
}

function classifyTemporalTrendOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
} = {}) {
  const candidates = temporalTrendCandidates(context);
  if (actions.length > 0) {
    if (!actions.every((action) => action?.tool === "temporal_trends"))
      return null;
    const results = correlateToolResults(actions, toolResults);
    const allActionsAreGrounded = actions.every((action, index) => {
      const layer = contextLayerByName(context, action?.args?.layer_name);
      return layer && candidates.includes(layer) && results[index]?.ok === true;
    });
    return allActionsAreGrounded ? "tool-success" : null;
  }

  if (toolResults.length > 0 || candidates.length < 2) return null;
  const text = normalizeSemanticResponse(response);
  const namedCandidates = candidates.filter((layer) =>
    [layer?.display_name, layer?.canonical_name]
      .filter(Boolean)
      .some((name) => text.toLowerCase().includes(String(name).toLowerCase())),
  );
  const distinctNames = new Set(
    namedCandidates.map((layer) =>
      String(layer?.canonical_name || layer?.display_name || "").toLowerCase(),
    ),
  );
  const anchorsRequestedAnalysis =
    /\b2023\b/.test(text) && /\b(?:temporal )?trend\b/i.test(text);
  const requestsLayerChoice =
    /\b(?:which|what) layer\b/i.test(text) ||
    /\bneed (?:the|a) layer\b/i.test(text) ||
    /\bdid you mean\b/i.test(text) ||
    /\b(?:choose|select|specify)\b[^.]{0,60}\blayer\b/i.test(text);
  return anchorsRequestedAnalysis &&
    requestsLayerChoice &&
    distinctNames.size >= 2
    ? "grounded-clarification"
    : null;
}

function normalizeCapabilityText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_/-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function analysisCapabilityDocuments(layer) {
  const operationDocuments = (
    Array.isArray(layer?.analysis?.operations)
      ? layer.analysis.operations
      : []
  ).map((operation) => ({
    id: "operation:" + String(operation),
    name: normalizeCapabilityText(operation),
    text: normalizeCapabilityText(operation),
  }));
  const toolDocuments = (Array.isArray(registry?.tools) ? registry.tools : [])
    .filter((tool) => String(tool?.category).toLowerCase() === "analytics")
    .map((tool) => ({
      id: "tool:" + String(tool?.name || ""),
      name: normalizeCapabilityText(tool?.name),
      text: normalizeCapabilityText(
        String(tool?.name || "") + " " + String(tool?.description || ""),
      ),
    }));
  return [...operationDocuments, ...toolDocuments].filter(
    (document) => document.name,
  );
}

const ANALYSIS_CATEGORY_PATTERNS = new Map([
  [
    "statistics",
    /\b(?:statistics?|mean|average|percentiles?|standard deviation)\b/i,
  ],
  ["threshold", /\b(?:threshold|highlight(?:ing)?)\b/i],
  ["comparison", /\b(?:comparison|compare|difference)\b/i],
  ["change-detection", /\b(?:change detection|changes? between)\b/i],
  [
    "temporal",
    /\b(?:temporal trends?|trends? over time|time[- ]series)\b/i,
  ],
  ["anomaly", /\b(?:anomal(?:y|ies|ous)|outliers?)\b/i],
  [
    "spatial",
    /\b(?:spatial (?:statistics?|patterns?|autocorrelation)|hotspots?|moran)\b/i,
  ],
  ["analysis-ui", /\b(?:analysis tool|chart workflow)\b/i],
]);

function groundedAnalysisCategories(text, documents) {
  const available = new Set();
  for (const document of documents) {
    const capabilityName = normalizeCapabilityText(document.name);
    for (const [category, pattern] of ANALYSIS_CATEGORY_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(capabilityName)) available.add(category);
    }
  }
  const grounded = new Set();
  for (const [category, pattern] of ANALYSIS_CATEGORY_PATTERNS) {
    pattern.lastIndex = 0;
    if (available.has(category) && pattern.test(text)) grounded.add(category);
  }
  return grounded;
}

function classifyGenericLayerAnalysisOutcome({
  actions = [],
  toolResults = [],
  response = "",
  context = {},
  targetLayerName = "",
  allowedTools = [],
} = {}) {
  const target = contextLayerByName(context, targetLayerName);
  if (
    !target ||
    target?.analysis?.supported !== true ||
    target?.analysis?.scalar !== true
  )
    return null;
  if (actions.length > 0) {
    const permitted = new Set(allowedTools);
    if (
      !actions.every(
        (action) =>
          permitted.has(action?.tool) &&
          contextLayerByName(context, action?.args?.layer_name) === target,
      )
    )
      return null;
    const results = correlateToolResults(actions, toolResults);
    return results.every((result) => result?.ok === true)
      ? "tool-success"
      : null;
  }
  if (toolResults.length > 0) return null;

  const text = normalizeSemanticResponse(response);
  const namedLayers = (Array.isArray(context?.layers) ? context.layers : [])
    .filter((layer) => textMentionsContextLayer(text, layer));
  if (namedLayers.length !== 1 || namedLayers[0] !== target) return null;
  const capabilityDocuments = analysisCapabilityDocuments(target);
  const groundedCategories = groundedAnalysisCategories(
    text,
    capabilityDocuments,
  );
  const asksWhichAnalysis =
    /\bwhich\b[^?]{0,50}\b(?:would you like|do you want|should I|analysis|option|one)\b/i.test(
      text,
    ) ||
    /\bwhat (?:kind|type) of (?:analysis|operation)\b[^?]{0,50}\b(?:would you like|do you want|should I (?:run|use))\b/i.test(
      text,
    ) ||
    /\b(?:tell me|choose|select)\b[^.?]{0,30}\bwhich (?:you would|you'd) like\b/i.test(
      text,
    );
  return groundedCategories.size >= 2 && asksWhichAnalysis
    ? "grounded-clarification"
    : null;
}

function auditInitialExampleTraffic(examples = [], traffic = []) {
  const initial = traffic.filter((entry) => entry?.kind === "initial");
  const issues = [];
  for (let index = 0; index < examples.length; index += 1) {
    const expectedQuery = examples[index]?.query;
    const matches = initial.filter((entry) => entry.exampleIndex === index);
    if (matches.length !== 1) {
      issues.push({
        code: matches.length ? "DUPLICATE_INITIAL_REQUEST" : "MISSING_INITIAL_REQUEST",
        index,
        expectedQuery,
        count: matches.length,
        messages: matches.map((entry) => entry.request?.message || null),
      });
      continue;
    }
    if (matches[0].request?.message !== expectedQuery) {
      issues.push({
        code: "INITIAL_REQUEST_QUERY_MISMATCH",
        index,
        expectedQuery,
        actualQuery: matches[0].request?.message || null,
      });
    }
  }
  for (const entry of initial.filter(
    (candidate) =>
      !Number.isInteger(candidate.exampleIndex) ||
      candidate.exampleIndex < 0 ||
      candidate.exampleIndex >= examples.length,
  )) {
    issues.push({
      code: "UNASSIGNED_INITIAL_REQUEST",
      index: entry.exampleIndex ?? null,
      actualQuery: entry.request?.message || null,
      urlPath: entry.urlPath || null,
    });
  }
  return { initial, issues };
}

function classifyRgbMeanUnsupportedOutcome({
  query,
  actions = [],
  toolResults = [],
  response = "",
} = {}) {
  if (query !== RGB_MEAN_QUERY) return null;
  if (actions.length > 0) {
    const selectedMean = actions.some(
      (action) => action?.tool === "calculate_layer_mean",
    );
    const meanResults = toolResults.filter(
      (result) => result?.tool === "calculate_layer_mean",
    );
    if (
      selectedMean &&
      meanResults.length === 1 &&
      meanResults[0].ok === false &&
      resultErrorCode(meanResults[0]) === "UNSUPPORTED_ANALYSIS"
    ) {
      return "tool-unsupported";
    }
    return null;
  }
  if (
    toolResults.length === 0 &&
    isGroundedRgbUnsupportedExplanation(response)
  ) {
    return "grounded-explanation";
  }
  return null;
}

function correlatedToolResult(action, toolResults, usedResultIndexes = null) {
  const expectedCallId = String(action?.callId || "").trim();
  const resultIndex = (toolResults || []).findIndex((result, index) => {
    if (usedResultIndexes?.has(index) || result?.tool !== action?.tool)
      return false;
    return expectedCallId
      ? String(result?.callId || "").trim() === expectedCallId
      : true;
  });
  if (resultIndex < 0) return null;
  usedResultIndexes?.add(resultIndex);
  return toolResults[resultIndex];
}

function correlateToolResults(actions, toolResults) {
  const usedResultIndexes = new Set();
  const plannedActions = actions || [];
  const correlated = new Array(plannedActions.length).fill(null);

  // Reserve exact native-call matches first so an earlier JSON-planned action
  // without an id cannot consume a result belonging to a later native call.
  for (let index = 0; index < plannedActions.length; index += 1) {
    if (!String(plannedActions[index]?.callId || "").trim()) continue;
    correlated[index] = correlatedToolResult(
      plannedActions[index],
      toolResults,
      usedResultIndexes,
    );
  }
  for (let index = 0; index < plannedActions.length; index += 1) {
    if (String(plannedActions[index]?.callId || "").trim()) continue;
    correlated[index] = correlatedToolResult(
      plannedActions[index],
      toolResults,
      usedResultIndexes,
    );
  }
  return correlated;
}

function classifyLandMaskComparisonOutcome({
  query,
  actions = [],
  toolResults = [],
  response = "",
} = {}) {
  if (query !== LAND_MASK_COMPARISON_QUERY) return null;
  if (actions.length > 0) {
    if (
      !actions.every((action) => action?.tool === "calculate_layer_difference")
    )
      return null;
    const results = correlateToolResults(actions, toolResults);
    const grounded = actions.every((_action, index) => {
      const result = results[index];
      return (
        result?.ok === false &&
        resultErrorCode(result) === "UNSUPPORTED_ANALYSIS"
      );
    });
    return grounded ? "tool-unsupported" : null;
  }
  const text = normalizeSemanticResponse(response);
  return toolResults.length === 0 &&
    /\bland mask\b/i.test(text) &&
    /\b(?:scalar|numeric|analyz|analysis|comparison|difference)\w*\b/i.test(
      text,
    ) &&
    /\b(?:cannot|can't|does not|doesn't|no|not|unsupported|unavailable|without)\b/i.test(
      text,
    )
    ? "grounded-explanation"
    : null;
}

function classifyAnimationOutcome({
  actions = [],
  toolResults = [],
  response = "",
} = {}) {
  if (actions.length > 0) return null;
  const text = normalizeSemanticResponse(response);
  return toolResults.length === 0 &&
    /\banimation\b/i.test(text) &&
    /\b(?:tool|mission|available|loaded|enabled)\b/i.test(text) &&
    /\b(?:cannot|can't|does not|doesn't|no|not|unavailable|without)\b/i.test(
      text,
    )
    ? "grounded-explanation"
    : null;
}

function isGroundedAnalyzableLayerAction(action, context) {
  if (action?.tool === "list_analyzable_layers") return true;
  const layerName =
    action?.args?.name || action?.args?.layer_name || action?.args?.layer;
  const layer = contextLayerByName(context, layerName);
  if (!layer || layer.analysis?.supported !== true) return false;
  if (action.tool === "toggle_layer")
    return layer.visible === false && action?.args?.visible !== false;
  if (action.tool === "calculate_layer_mean") return layer.visible === true;
  return false;
}

function hasSuccessfulAnalyzableLayerActions(actions, toolResults, context) {
  const results = correlateToolResults(actions, toolResults);
  return (
    actions.length > 0 &&
    actions.every(
      (action, index) =>
        isGroundedAnalyzableLayerAction(action, context) &&
        results[index]?.ok === true,
    )
  );
}

function isGroundedAlreadyVisibleAnalyzableLayer(response, context) {
  const text = normalizeSemanticResponse(response);
  const sentences = text
    .split(/(?:[\n.!?]+|;\s+)/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const confirmsExistingVisibility = (sentence) =>
    /\balready\b[^.]{0,50}\b(?:on|visible|enabled|turned on)\b/i.test(
      sentence,
    ) ||
    /\b(?:on|visible|enabled|turned on)\b[^.]{0,50}\balready\b/i.test(sentence);
  const confirmsAnalysis = (sentence) =>
    /\b(?:supports? analysis|analyzable|can (?:be )?analyz(?:e|ed)|ready (?:to analyze|for analysis))\b/i.test(
      sentence,
    );
  const matches = (context?.layers || []).filter((layer) => {
    const names = [
      layer?.display_name,
      layer?.canonical_name,
      ...(Array.isArray(layer?.aliases) ? layer.aliases : []),
    ]
      .map((name) =>
        String(name || "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    return sentences.some((sentence) => {
      const normalizedSentence = sentence.toLowerCase();
      return (
        names.some((name) => normalizedSentence.includes(name)) &&
        confirmsExistingVisibility(sentence) &&
        confirmsAnalysis(sentence)
      );
    });
  });
  if (matches.length !== 1) return false;
  const layer = matches[0];
  const operations = layer?.analysis?.operations;
  const contextProvesReady =
    layer?.visible === true &&
    layer?.analysis?.supported === true &&
    layer?.analysis?.scalar === true &&
    Array.isArray(operations) &&
    operations.length > 0;
  return contextProvesReady;
}

test.describe("@unit real-provider example outcome policy", () => {
  test("normalizes presentation markup without dropping semantic content", () => {
    expect(
      normalizeSemanticResponse(
        "**Ice Forecast** can’t compare [current map time](https://example.test/time) over 2024‑01‑08—2024‑01‑15; scalar_value remains.",
      ),
    ).toBe(
      "Ice Forecast can't compare current map time over 2024-01-08-2024-01-15; scalar_value remains.",
    );
    expect(
      isGroundedCurrentLayerAmbiguity(
        "I can’t tell which layer is the current one from the available UI state. Please name the layer you want to hide.",
      ),
    ).toBe(true);
    expect(
      isGroundedCurrentLayerAmbiguity(
        "I can hide the current layer, but no active or visible layer context is available right now. Tell me the layer name you want hidden.",
      ),
    ).toBe(true);
    expect(
      isGroundedCurrentLayerAmbiguity(
        "I can’t identify a current or active layer from the available UI state. Please name the layer you want hidden.",
      ),
    ).toBe(true);
    expect(
      isGroundedCurrentLayerAmbiguity(
        "Please name the layer you want to hide.",
      ),
    ).toBe(false);
    expect(
      isGroundedCurrentLayerAmbiguity(
        "I can't tell which layer is the current one.",
      ),
    ).toBe(false);
  });

  test("accepts only a successful list tool or a complete grounded data-layer inventory", () => {
    const context = boundedValidationContext({}, true);
    const response =
      "Available data layers are:\n- **Land Mask** — visible, reference mask, not analyzable\n- **Ice Forecast** — visible, analyzable, time-enabled\n- **Ice Ground Truth** — hidden, analyzable, time-enabled";
    expect(
      expectedStaticPlan(SHOW_AVAILABLE_DATA_LAYERS_QUERY, context),
    ).toEqual({
      kind: "list-layers-or-grounded-data-inventory",
      tools: ["list_layers"],
    });
    expect(classifyDataLayerInventoryOutcome({ context, response })).toBe(
      "grounded-inventory",
    );
    expect(
      classifyDataLayerInventoryOutcome({
        context,
        actions: [{ tool: "list_layers", callId: "list" }],
        toolResults: [{ tool: "list_layers", callId: "list", ok: true }],
      }),
    ).toBe("tool-success");
    expect(
      classifyDataLayerInventoryOutcome({
        context,
        response:
          "Available data layers are:\n- Land Mask — visible, reference mask, not analyzable\n- Ice Forecast — visible, analyzable, time-enabled",
      }),
    ).toBeNull();
    expect(
      classifyDataLayerInventoryOutcome({
        context,
        response: `${response}\n- Mystery Raster — visible, analyzable`,
      }),
    ).toBeNull();
    expect(
      classifyDataLayerInventoryOutcome({
        context,
        response: `${response}\n- GIBS MODIS True Color — visible, not analyzable`,
      }),
    ).toBeNull();
  });

  test("requires two visible analyzable layers or a grounded single-visible clarification", () => {
    const query = "Compare the visible analyzable layers";
    const context = boundedValidationContext({}, true);
    const exactProviderReply =
      "I only see one **visible analyzable** layer right now: **Ice Forecast**. **Ice Ground Truth** is also analyzable, but it is currently hidden, so there are not multiple visible analyzable layers to compare. If you want, I can compare **Ice Forecast** vs **Ice Ground Truth** at the current map time.";
    expect(
      expectedConfiguredPlan(
        { family: "contextual:analysis", query },
        context,
      ),
    ).toEqual({
      kind: "visible-analyzable-comparison",
      tools: ["calculate_layer_difference"],
    });
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context,
        response: exactProviderReply,
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context,
        response:
          "Ice Forecast is the only visible analyzable layer. Which second layer should I compare it with?",
      }),
    ).toBe("grounded-clarification");

    const twoVisibleContext = {
      ...context,
      layers: context.layers.map((layer) =>
        layer.display_name === "Ice Ground Truth"
          ? { ...layer, visible: true }
          : layer,
      ),
    };
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context: twoVisibleContext,
        actions: [
          {
            tool: "calculate_layer_difference",
            callId: "difference",
            args: {
              layer_a: "Ice Forecast",
              layer_b: "Ice Ground Truth",
            },
          },
        ],
        toolResults: [
          {
            tool: "calculate_layer_difference",
            callId: "difference",
            ok: true,
          },
        ],
      }),
    ).toBe("tool-success");

    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context,
        response: "Which layers do you want to compare?",
      }),
    ).toBeNull();
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context,
        response:
          "Ice Forecast is the only visible analyzable layer. I can compare it with Mystery Raster.",
      }),
    ).toBeNull();
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context,
        response:
          "Ice Forecast is the only visible analyzable layer. I can compare Ice Forecast with Land Mask.",
      }),
    ).toBeNull();
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context: twoVisibleContext,
        response: exactProviderReply,
      }),
    ).toBeNull();
    expect(
      classifyVisibleAnalyzableComparisonOutcome({
        context: twoVisibleContext,
        actions: [
          {
            tool: "calculate_layer_difference",
            callId: "difference",
            args: {
              layer_a: "Ice Forecast",
              layer_b: "Ice Ground Truth",
            },
          },
        ],
        toolResults: [
          {
            tool: "calculate_layer_difference",
            callId: "difference",
            ok: false,
          },
        ],
      }),
    ).toBeNull();
  });

  test("requires a hidden-layer toggle or exact proof that the target is already visible", () => {
    const query = "Turn on the forecast prediction layer";
    const visibleContext = boundedValidationContext({}, true);
    expect(expectedStaticPlan(query, visibleContext)).toEqual({
      kind: "layer-visible-or-toggle",
      tools: ["toggle_layer"],
      targetLayer: "Ice Forecast",
    });
    expect(
      classifyLayerVisibilityOutcome({
        context: visibleContext,
        targetLayerName: "Ice Forecast",
        response: "**Ice Forecast** is already visible.",
      }),
    ).toBe("grounded-already-visible");

    const hiddenContext = {
      ...visibleContext,
      layers: visibleContext.layers.map((layer) =>
        layer.display_name === "Ice Forecast"
          ? { ...layer, visible: false }
          : layer,
      ),
    };
    const toggleAction = {
      tool: "toggle_layer",
      callId: "show-forecast",
      args: { name: "Ice Forecast", visible: true },
    };
    expect(
      classifyLayerVisibilityOutcome({
        context: hiddenContext,
        targetLayerName: "Ice Forecast",
        actions: [toggleAction],
        toolResults: [
          { tool: "toggle_layer", callId: "show-forecast", ok: true },
        ],
      }),
    ).toBe("tool-success");

    expect(
      classifyLayerVisibilityOutcome({
        context: visibleContext,
        targetLayerName: "Ice Forecast",
        response: "Ice Ground Truth is already visible.",
      }),
    ).toBeNull();
    expect(
      classifyLayerVisibilityOutcome({
        context: visibleContext,
        targetLayerName: "Ice Forecast",
        response: "The requested layer is ready.",
      }),
    ).toBeNull();
    expect(
      classifyLayerVisibilityOutcome({
        context: hiddenContext,
        targetLayerName: "Ice Forecast",
        response: "Ice Forecast is already visible.",
      }),
    ).toBeNull();
    expect(
      classifyLayerVisibilityOutcome({
        context: hiddenContext,
        targetLayerName: "Ice Forecast",
        actions: [toggleAction],
        toolResults: [
          { tool: "toggle_layer", callId: "show-forecast", ok: false },
        ],
      }),
    ).toBeNull();
    expect(
      classifyLayerVisibilityOutcome({
        context: visibleContext,
        targetLayerName: "Ice Forecast",
        actions: [toggleAction],
        toolResults: [
          { tool: "toggle_layer", callId: "show-forecast", ok: true },
        ],
      }),
    ).toBeNull();
    expect(
      classifyLayerVisibilityOutcome({
        context: visibleContext,
        targetLayerName: "Ice Forecast",
        response:
          "Ice Forecast and Ice Ground Truth are already visible.",
      }),
    ).toBeNull();
  });

  test("requires a real AOI target or a grounded missing-AOI clarification", () => {
    const context = boundedValidationContext({}, true);
    const query = "Zoom to the current area of interest";
    expect(expectedStaticPlan(query, context)).toEqual({
      kind: "aoi-zoom-or-grounded-clarification",
      tools: ["zoom_to"],
    });
    expect(
      classifyAoiZoomOutcome({
        context,
        response:
          'I can zoom to a named region, coordinates, or a bounding box, but I don’t have a defined "current area of interest" target yet. If you want, tell me a region name or say "zoom to current view bounds".',
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyAoiZoomOutcome({
        context,
        response:
          "No area of interest or selection extent is currently available. Should I use the current map view, a named region, or coordinates/bbox?",
      }),
    ).toBe("grounded-clarification");

    const contextWithAoi = {
      ...context,
      areaOfInterest: {
        name: "Validation AOI",
        bbox: [-160, 72, -130, 82],
      },
    };
    const action = {
      tool: "zoom_to",
      callId: "aoi",
      args: { bbox: [-160, 72, -130, 82] },
    };
    expect(
      classifyAoiZoomOutcome({
        context: contextWithAoi,
        actions: [action],
        toolResults: [{ tool: "zoom_to", callId: "aoi", ok: true }],
      }),
    ).toBe("tool-success");
    expect(
      classifyAoiZoomOutcome({
        context,
        actions: [action],
        toolResults: [{ tool: "zoom_to", callId: "aoi", ok: true }],
      }),
    ).toBeNull();
    expect(
      classifyAoiZoomOutcome({
        context,
        response: "Where would you like to zoom?",
      }),
    ).toBeNull();
    expect(
      classifyAoiZoomOutcome({
        context,
        response:
          "The current area of interest is Beaufort Sea. Choose a named region or current-view bounds.",
      }),
    ).toBeNull();
    expect(
      classifyAoiZoomOutcome({
        context,
        response: "No current area of interest is selected.",
      }),
    ).toBeNull();
  });

  test("accepts only the two grounded RGB mean limitation paths", () => {
    expect(
      classifyRgbMeanUnsupportedOutcome({
        query: RGB_MEAN_QUERY,
        actions: [{ tool: "calculate_layer_mean" }],
        toolResults: [
          {
            tool: "calculate_layer_mean",
            ok: false,
            error: { code: "UNSUPPORTED_ANALYSIS" },
          },
        ],
        response:
          "GIBS MODIS True Color is visualization-only RGB imagery and has no scalar values for statistics.",
      }),
    ).toBe("tool-unsupported");

    expect(
      classifyRgbMeanUnsupportedOutcome({
        query: RGB_MEAN_QUERY,
        response:
          "GIBS MODIS True Color is visualization-only RGB imagery. It does not expose scalar pixel values, so a numerical mean statistic cannot be calculated; choose an analyzable layer.",
      }),
    ).toBe("grounded-explanation");

    expect(
      classifyRgbMeanUnsupportedOutcome({
        query: RGB_MEAN_QUERY,
        response: "That analysis is unavailable. Please try again.",
      }),
    ).toBeNull();
    expect(
      classifyRgbMeanUnsupportedOutcome({
        query: RGB_MEAN_QUERY,
        actions: [{ tool: "calculate_layer_mean" }],
        toolResults: [
          {
            tool: "calculate_layer_mean",
            ok: false,
            error: { code: "RENDERER_FAILED" },
          },
        ],
      }),
    ).toBeNull();
  });

  test("accepts only grounded Land Mask and Animation limitation paths", () => {
    expect(
      classifyLandMaskComparisonOutcome({
        query: LAND_MASK_COMPARISON_QUERY,
        actions: [{ tool: "calculate_layer_difference", callId: "difference" }],
        toolResults: [
          {
            tool: "calculate_layer_difference",
            callId: "difference",
            ok: false,
            error: { code: "UNSUPPORTED_ANALYSIS" },
          },
        ],
      }),
    ).toBe("tool-unsupported");
    expect(
      classifyLandMaskComparisonOutcome({
        query: LAND_MASK_COMPARISON_QUERY,
        response:
          "Land Mask has no scalar analytics source, so a numeric difference comparison with Ice Forecast is unsupported.",
      }),
    ).toBe("grounded-explanation");
    expect(
      classifyLandMaskComparisonOutcome({
        query: LAND_MASK_COMPARISON_QUERY,
        response: "That comparison is unavailable.",
      }),
    ).toBeNull();

    expect(
      classifyAnimationOutcome({
        actions: [{ tool: "open_animation_tool", callId: "animation" }],
      }),
    ).toBeNull();
    expect(
      classifyAnimationOutcome({
        response: "The Animation tool is not available in the current mission.",
      }),
    ).toBe("grounded-explanation");
    expect(
      classifyAnimationOutcome({
        response: "That operation is unavailable.",
      }),
    ).toBeNull();
  });

  test("accepts only successful, context-compatible data-layer fulfillment", () => {
    const context = boundedValidationContext({}, true);
    expect(expectedDataLayerActivationPlan(context)).toEqual({
      kind: "analyzable-layer-action",
      tools: ["toggle_layer", "list_analyzable_layers", "calculate_layer_mean"],
    });
    const actions = [
      {
        tool: "toggle_layer",
        callId: "toggle-ground-truth",
        args: { name: "Ice Ground Truth", visible: true },
      },
      {
        tool: "calculate_layer_mean",
        callId: "mean-forecast",
        args: { layer_name: "Ice Forecast" },
      },
    ];
    expect(
      hasSuccessfulAnalyzableLayerActions(
        actions,
        actions.map((action) => ({
          tool: action.tool,
          callId: action.callId,
          ok: true,
        })),
        context,
      ),
    ).toBe(true);
    expect(
      hasSuccessfulAnalyzableLayerActions(
        [
          {
            tool: "toggle_layer",
            callId: "toggle-land-mask",
            args: { name: "Land Mask", visible: true },
          },
        ],
        [
          {
            tool: "toggle_layer",
            callId: "toggle-land-mask",
            ok: true,
          },
        ],
        context,
      ),
    ).toBe(false);
    const alreadyVisible =
      "Ice Forecast is already turned on and supports analysis, so you can analyze that layer now.";
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(alreadyVisible, context),
    ).toBe(true);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(
        "`Ice Forecast` is already on and supports analysis. If you want, I can also turn on `Ice Ground Truth` for comparison or analysis.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(
        "Ice Forecast and Ice Ground Truth are already on and support analysis.",
        {
          ...context,
          layers: context.layers.map((layer) =>
            layer.display_name === "Ice Ground Truth"
              ? { ...layer, visible: true }
              : layer,
          ),
        },
      ),
    ).toBe(false);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(alreadyVisible, {
        ...context,
        layers: context.layers.map((layer) =>
          layer.display_name === "Ice Forecast"
            ? { ...layer, visible: false }
            : layer,
        ),
      }),
    ).toBe(false);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(alreadyVisible, {
        ...context,
        layers: context.layers.map((layer) =>
          layer.display_name === "Ice Forecast"
            ? {
                ...layer,
                analysis: {
                  ...layer.analysis,
                  supported: false,
                  scalar: false,
                  operations: [],
                },
              }
            : layer,
        ),
      }),
    ).toBe(false);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(alreadyVisible, {
        ...context,
        layers: [
          ...context.layers,
          {
            ...context.layers.find(
              (layer) => layer.display_name === "Ice Forecast",
            ),
          },
        ],
      }),
    ).toBe(false);
    expect(
      isGroundedAlreadyVisibleAnalyzableLayer(
        "A data layer is already available.",
        context,
      ),
    ).toBe(false);
  });

  test("requires a successful grounded trend action or two grounded temporal layer choices", () => {
    const context = boundedValidationContext({}, true);
    const query = "What is the sea ice extent trend over 2023?";
    expect(expectedStaticPlan(query, context)).toEqual({
      kind: "temporal-trend-or-grounded-layer-clarification",
      tools: ["temporal_trends"],
    });
    expect(
      classifyTemporalTrendOutcome({
        context,
        actions: [
          {
            tool: "temporal_trends",
            callId: "trend",
            args: { layer_name: "Ice Forecast" },
          },
        ],
        toolResults: [{ tool: "temporal_trends", callId: "trend", ok: true }],
      }),
    ).toBe("tool-success");
    expect(
      classifyTemporalTrendOutcome({
        context,
        response:
          "I can analyze a 2023 temporal trend, but I need the layer to use. Did you mean Ice Ground Truth (observed sea ice) or Ice Forecast?",
      }),
    ).toBe("grounded-clarification");

    expect(
      classifyTemporalTrendOutcome({
        context,
        response: "Which layer should I use for that trend?",
      }),
    ).toBeNull();
    expect(
      classifyTemporalTrendOutcome({
        context,
        response:
          "For the temporal trend, did you mean Ice Forecast or Ice Ground Truth?",
      }),
    ).toBeNull();
    expect(
      classifyTemporalTrendOutcome({
        context: {
          ...context,
          layers: context.layers.map((layer) =>
            layer.display_name === "Ice Ground Truth"
              ? {
                  ...layer,
                  time: { ...layer.time, enabled: false },
                }
              : layer,
          ),
        },
        response:
          "For the 2023 temporal trend, did you mean Ice Forecast or Ice Ground Truth?",
      }),
    ).toBeNull();
    expect(
      classifyTemporalTrendOutcome({
        context,
        actions: [
          {
            tool: "temporal_trends",
            callId: "trend",
            args: { layer_name: "Ice Forecast" },
          },
        ],
        toolResults: [{ tool: "temporal_trends", callId: "trend", ok: false }],
      }),
    ).toBeNull();
  });

  test("requires a successful generic analysis action or grounded operation choices", () => {
    const query = "Analyze Ice Forecast";
    const context = boundedValidationContext({}, true);
    const plan = expectedConfiguredPlan(
      { family: "dynamic:visibleAnalyzable", query },
      context,
    );
    expect(plan).toEqual({
      kind: "analysis-action-or-grounded-operation-clarification",
      tools: ["calculate_layer_mean"],
      targetLayer: "Ice Forecast",
    });
    const exactProviderReply =
      "Ice Forecast supports several analyses: statistics/mean, threshold highlighting, change detection between two dates, temporal trends, anomalies, or spatial statistics. Which would you like?";
    const questionFirstProviderReply =
      "What kind of analysis would you like for Ice Forecast? I can do statistics, anomaly detection, temporal trends, change detection between two dates, or threshold highlighting.";
    const supportedWaysProviderReply =
      'I can analyze **Ice Forecast** in a few supported ways: statistics, anomalies, spatial patterns, temporal trends, or change detection between two dates. Tell me which you’d like—for example: **"show statistics for Ice Forecast"** or **"analyze Ice Forecast trends over time"**.';
    const exampleListProviderReply =
      "Which supported analysis would you like for Ice Forecast—for example statistics, a temporal trend, a threshold/highlight, anomaly detection, or a comparison?";
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response: exactProviderReply,
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response: exampleListProviderReply,
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response: questionFirstProviderReply,
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response: supportedWaysProviderReply,
      }),
    ).toBe("grounded-clarification");
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        actions: [
          {
            tool: "calculate_layer_mean",
            callId: "mean",
            args: { layer_name: "Ice Forecast" },
          },
        ],
        toolResults: [
          {
            tool: "calculate_layer_mean",
            callId: "mean",
            ok: true,
          },
        ],
      }),
    ).toBe("tool-success");
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        actions: [
          {
            tool: "calculate_layer_mean",
            args: { layer_name: "Ice Forecast" },
          },
        ],
        toolResults: [
          {
            tool: "calculate_layer_mean",
            ok: false,
            error: { code: "ANALYTICS_UNAVAILABLE" },
          },
        ],
        response: "Statistics are not available for this layer.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Which supported analysis would you like—for example statistics, a temporal trend, or a comparison?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Which supported analysis would you like for Ice Ground Truth—for example statistics, a temporal trend, or a comparison?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Which supported analysis would you like for Ice Forecast—for example statistics?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Forecast supports analysis; for example statistics, a temporal trend, or a comparison.",
      }),
    ).toBeNull();

    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Ground Truth supports analyses: statistics, threshold highlighting. Which would you like?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "I can analyze Ice Forecast in a few supported ways: statistics, threshold highlighting.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "I can analyze Ice Ground Truth in a few supported ways: statistics, threshold highlighting. Tell me which you'd like.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "What kind of analysis would you like? I can do statistics, threshold highlighting.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Forecast can be analyzed. I can do statistics, threshold highlighting.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Several analyses are available: statistics, temporal trends. Which would you like?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Forecast supports analyses: statistics/mean. Which would you like?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Forecast supports analyses: moon magic, oracle forecasting. Which would you like?",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        response:
          "Ice Forecast supports analyses: statistics, temporal trends.",
      }),
    ).toBeNull();
    expect(
      classifyGenericLayerAnalysisOutcome({
        context,
        targetLayerName: plan.targetLayer,
        allowedTools: plan.tools,
        actions: [
          {
            tool: "calculate_layer_mean",
            callId: "mean",
            args: { layer_name: "Ice Forecast" },
          },
        ],
        toolResults: [
          {
            tool: "calculate_layer_mean",
            callId: "mean",
            ok: false,
          },
        ],
      }),
    ).toBeNull();
  });

  test("audits initial provider traffic one-to-one by active example", () => {
    const examples = [{ query: "First" }, { query: "Second" }];
    const valid = [
      {
        kind: "initial",
        exampleIndex: 0,
        request: { message: "First" },
      },
      {
        kind: "continue",
        exampleIndex: 0,
        request: { originalMessage: "First" },
      },
      {
        kind: "initial",
        exampleIndex: 1,
        request: { message: "Second" },
      },
    ];
    expect(auditInitialExampleTraffic(examples, valid).issues).toEqual([]);
    expect(
      auditInitialExampleTraffic(examples, [
        ...valid,
        {
          kind: "initial",
          exampleIndex: 1,
          request: { message: "Second" },
        },
      ]).issues,
    ).toContainEqual(
      expect.objectContaining({
        code: "DUPLICATE_INITIAL_REQUEST",
        index: 1,
        count: 2,
      }),
    );
    expect(
      auditInitialExampleTraffic(examples, [
        {
          kind: "initial",
          exampleIndex: 0,
          request: { message: "Wrong" },
        },
        {
          kind: "initial",
          exampleIndex: null,
          request: { message: "Background" },
          urlPath: "/api/agent",
        },
      ]).issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "INITIAL_REQUEST_QUERY_MISMATCH",
          index: 0,
        }),
        expect.objectContaining({
          code: "MISSING_INITIAL_REQUEST",
          index: 1,
        }),
        expect.objectContaining({
          code: "UNASSIGNED_INITIAL_REQUEST",
          actualQuery: "Background",
        }),
      ]),
    );
  });

  test("correlates native call ids strictly and JSON plans without ids by tool order", () => {
    const nativeResults = [
      {
        tool: "calculate_layer_mean",
        callId: "native-b",
        ok: true,
        message: "second",
      },
      {
        tool: "calculate_layer_mean",
        callId: "native-a",
        ok: true,
        message: "first",
      },
    ];
    expect(
      correlateToolResults(
        [
          { tool: "calculate_layer_mean", callId: "native-a" },
          { tool: "calculate_layer_mean", callId: "native-b" },
        ],
        nativeResults,
      ).map((result) => result?.message),
    ).toEqual(["first", "second"]);
    expect(
      correlatedToolResult(
        { tool: "calculate_layer_mean", callId: "native-missing" },
        [{ tool: "calculate_layer_mean", callId: "", ok: true }],
      ),
    ).toBeNull();
    expect(
      correlateToolResults(
        [
          { tool: "calculate_layer_mean" },
          { tool: "calculate_layer_mean", callId: "native-b" },
        ],
        [
          {
            tool: "calculate_layer_mean",
            callId: "native-b",
            message: "reserved native",
          },
          {
            tool: "calculate_layer_mean",
            callId: "",
            message: "ordinal JSON",
          },
        ],
      ).map((result) => result?.message),
    ).toEqual(["ordinal JSON", "reserved native"]);

    const jsonResults = [
      {
        tool: "calculate_layer_mean",
        callId: "",
        ok: true,
        message: "first JSON result",
      },
      {
        tool: "calculate_layer_mean",
        callId: "",
        ok: true,
        message: "second JSON result",
      },
    ];
    const correlated = correlateToolResults(
      [
        { tool: "calculate_layer_mean" },
        { tool: "calculate_layer_mean" },
        { tool: "calculate_layer_mean" },
      ],
      jsonResults,
    );
    expect(correlated.map((result) => result?.message || null)).toEqual([
      "first JSON result",
      "second JSON result",
      null,
    ]);
    expect(new Set(correlated.filter(Boolean)).size).toBe(2);
  });

  test("requires time and makes forecast visibility state-aware", () => {
    const visibleContext = boundedValidationContext({}, true);
    expect(expectedStaticPlan(FORECAST_JANUARY_QUERY, visibleContext)).toEqual({
      kind: "action-required-optional",
      tools: ["set_time"],
      optionalTools: ["toggle_layer"],
      successTools: ["set_time"],
    });

    const hiddenContext = {
      ...visibleContext,
      layers: visibleContext.layers.map((layer) =>
        layer.display_name === "Ice Forecast"
          ? { ...layer, visible: false }
          : layer,
      ),
    };
    expect(expectedStaticPlan(FORECAST_JANUARY_QUERY, hiddenContext)).toEqual({
      kind: "action-required-optional",
      tools: ["toggle_layer", "set_time"],
      optionalTools: [],
      successTools: ["toggle_layer", "set_time"],
    });
  });

  test("anchors predicted-today statistics to the sanitized UI day", () => {
    const context = boundedValidationContext({}, true);
    expect(
      expectedStaticPlan(PREDICTED_CONCENTRATION_TODAY_QUERY, context),
    ).toEqual({
      kind: "action-current-ui-day-or-area-clarification",
      tools: ["calculate_layer_mean"],
      optionalTools: ["set_time"],
    });

    const action = {
      tool: "calculate_layer_mean",
      args: {
        layer_name: "Ice Forecast",
        geographical_area: "current view",
        time_start: "2024-01-15T00:00:00Z",
        time_end: "2024-01-15T23:59:59Z",
      },
    };
    expect(hasUiAnchoredStatisticsTime(action, context, null)).toBe(true);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_end: "2024-01-16T00:00:00Z",
          },
        },
        context,
        null,
      ),
    ).toBe(true);
    const implicitAction = {
      tool: "calculate_layer_mean",
      args: {
        layer_name: "Ice Forecast",
        geographical_area: "current view",
      },
    };
    const verifiedProof = {
      verified: true,
      globalTime: "2024-01-15T00:00:00Z",
      layerStartTime: "2024-01-15T00:00:00Z",
      layerEndTime: "2024-01-15T00:00:00Z",
      forecastVisible: true,
    };
    const setTimeAction = {
      tool: "set_time",
      callId: "set-current",
      args: {
        time: "2024-01-15T00:00:00Z",
        layers: ["Ice Forecast"],
      },
    };
    const pointMeanAction = {
      ...action,
      callId: "mean-current",
      args: {
        ...action.args,
        time_start: "2024-01-15T00:00:00Z",
        time_end: "2024-01-15T00:00:00Z",
      },
    };
    const successfulSequenceResults = [
      { tool: "set_time", callId: "set-current", ok: true },
      { tool: "calculate_layer_mean", callId: "mean-current", ok: true },
    ];
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [setTimeAction, pointMeanAction],
        toolResults: successfulSequenceResults,
        context,
        baselineProof: verifiedProof,
      }),
    ).toBe("tool-success");
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [
          {
            ...setTimeAction,
            args: { ...setTimeAction.args, time: "2024-01-14T00:00:00Z" },
          },
          pointMeanAction,
        ],
        toolResults: successfulSequenceResults,
        context,
        baselineProof: verifiedProof,
      }),
    ).toBeNull();
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [
          {
            ...setTimeAction,
            args: { ...setTimeAction.args, layers: ["Ice Ground Truth"] },
          },
          pointMeanAction,
        ],
        toolResults: successfulSequenceResults,
        context,
        baselineProof: verifiedProof,
      }),
    ).toBeNull();
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [setTimeAction, pointMeanAction],
        toolResults: [
          { tool: "set_time", callId: "set-current", ok: false },
          successfulSequenceResults[1],
        ],
        context,
        baselineProof: verifiedProof,
      }),
    ).toBeNull();
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [pointMeanAction, setTimeAction],
        toolResults: [
          successfulSequenceResults[1],
          successfulSequenceResults[0],
        ],
        context,
        baselineProof: verifiedProof,
      }),
    ).toBeNull();
    expect(
      classifyPredictedTodayActionOutcome({
        actions: [setTimeAction, pointMeanAction],
        toolResults: successfulSequenceResults,
        context,
        baselineProof: {
          ...verifiedProof,
          globalTime: "2024-01-14T00:00:00Z",
        },
      }),
    ).toBeNull();
    expect(
      hasUiAnchoredStatisticsTime(implicitAction, context, verifiedProof),
    ).toBe(true);
    expect(
      hasUiAnchoredStatisticsTime(implicitAction, context, {
        ...verifiedProof,
        globalTime: "2024-01-01T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_start: "2026-08-15T00:00:00Z",
            time_end: "2026-08-15T23:59:59Z",
          },
        },
        context,
        verifiedProof,
      ),
    ).toBe(false);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_start: "2024-01-15T00:00:00Z",
            time_end: "2024-01-15T00:00:00Z",
          },
        },
        context,
        verifiedProof,
      ),
    ).toBe(true);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_start: "2024-01-15T00:00:00Z",
            time_end: "2024-01-15T00:00:00Z",
          },
        },
        context,
        null,
      ),
    ).toBe(false);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_start: "2024-01-14T00:00:00Z",
            time_end: "2024-01-14T00:00:00Z",
          },
        },
        context,
        verifiedProof,
      ),
    ).toBe(false);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...action,
          args: {
            ...action.args,
            time_start: "2024-01-15T12:00:00Z",
            time_end: "2024-01-15T12:00:00Z",
          },
        },
        context,
        verifiedProof,
      ),
    ).toBe(false);
    expect(
      hasUiAnchoredStatisticsTime(
        {
          ...implicitAction,
          args: {
            ...implicitAction.args,
            time_start: "2024-01-15T00:00:00Z",
          },
        },
        context,
        verifiedProof,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "The forecast layer is Ice Forecast, and the current temporal setting is 2024-01-15T00:00:00Z. Sea ice concentration is spatially variable, so please specify an area. I can calculate the predicted concentration for the current view or a named region.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "I can't return a single sea ice concentration value without a location or region. The forecast layer is Ice Forecast and the current map time is 2024-01-15T00:00:00Z. I can compute the mean predicted sea ice concentration for the current view or a named region.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "I can help with that, but I need a location or scope. The prediction layer is **Ice Forecast**, and the current map time is **2024-01-15T00:00:00Z**. I can compute the predicted sea ice concentration for the **current view** or a **named region**.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "`Ice Forecast` is the predicted sea ice layer, and the current map time is set to **2024-01-15T00:00:00Z**. Sea ice concentration varies by location, so there isn't a single map-wide value. I can calculate the mean predicted concentration for the **current view** or a **named region**.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "Predicted sea ice concentration depends on location. The current forecast time on the map is **2024-01-15** and the active forecast layer is **Ice Forecast**. If you want, I can calculate the predicted concentration for the **current view** or for a named region such as the Beaufort Sea.",
        context,
      ),
    ).toBe(true);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "The value depends on location. The current forecast time is 2024-01-15. I can calculate it for the current view or a named region.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "Predicted sea ice concentration for Ice Forecast depends on location. I can calculate it for the current view or a named region.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "Predicted sea ice concentration for Ice Forecast depends on location at 2024-01-15.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "Predicted sea ice concentration varies by area. Which region?",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "The map is at 2024-01-15T00:00:00Z. Please specify an area.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "At 2024-01-15T00:00:00Z, I need a location or scope. I can use the current view or a named region.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "The Ice Forecast predicted sea ice concentration is requested, and I need a location or scope. I can use the current view or a named region.",
        context,
      ),
    ).toBe(false);
    expect(
      isGroundedPredictedConcentrationAreaClarification(
        "The Ice Forecast predicted sea ice concentration at 2024-01-15T00:00:00Z needs a location or scope.",
        context,
      ),
    ).toBe(false);
  });

  test("accepts only a grounded no-action limitation for last-week comparison", () => {
    const context = boundedValidationContext({}, true);
    expect(expectedStaticPlan(LAST_WEEK_COMPARISON_QUERY, context)).toEqual({
      kind: "last-week-comparison-limitation",
      tools: [],
    });
    expect(
      isGroundedLastWeekComparisonLimitation(
        "I can compare the AI prediction with ground truth, but this tool supports a single map time, not a full last-week time window. I can compare them at the current map time or after you specify a single date.",
      ),
    ).toBe(true);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "The difference tool compares the AI prediction and ground truth at a single map time, not over a full week-long range. I can set the map time to a specific date from last week and then compare them; tell me which date to use.",
      ),
    ).toBe(true);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "I can compare Ice Forecast and Ice Ground Truth at a single map time, but not across last week as a full interval. Would you like a snapshot comparison at the current map time, or on a specific exact date between 2024-01-08 and 2024-01-14?",
      ),
    ).toBe(true);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "I can compare Ice Forecast (AI prediction) and Ice Ground Truth at a single map time, but I can't do a true two-layer comparison across last week with the available tools. Last week would be approximately 2024-01-08 to 2024-01-15. Would you like the current map time or a specific exact date?",
      ),
    ).toBe(true);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "I can compare **Ice Forecast** and **Ice Ground Truth** at a **single map time**, but I can’t do a true two-layer comparison across **last week** with the available tools. Using the current map time, “last week” would be **2024-01-08 to 2024-01-15**. Would you like the **current map time** or a **specific exact date**?",
      ),
    ).toBe(true);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "The last-week comparison is unavailable.",
      ),
    ).toBe(false);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "The AI prediction and ground truth tool supports only a single map time, not a last-week time window.",
      ),
    ).toBe(false);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "The AI prediction and ground truth tool supports only a single map time for last week. I can use the current map time.",
      ),
    ).toBe(false);
    expect(
      isGroundedLastWeekComparisonLimitation(
        "The AI prediction and ground truth tool supports only a single map time for last week, 2024-01-15 to 2024-01-15. I can use a specific date.",
      ),
    ).toBe(false);
  });

  test("grounds comparison and current-layer highlight only with unambiguous public state", () => {
    const context = boundedValidationContext({}, true);
    expect(expectedStaticPlan(PREDICTION_GROUND_TRUTH_QUERY, context)).toEqual({
      kind: "action",
      tools: ["calculate_layer_difference"],
    });
    expect(expectedStaticPlan(ACTIVE_LAYER_HIGHLIGHT_QUERY, context)).toEqual({
      kind: "action-any",
      tools: ["highlight_relative_to_mean", "threshold_highlight"],
    });

    expect(
      expectedStaticPlan(PREDICTION_GROUND_TRUTH_QUERY, {
        ...context,
        layers: context.layers.filter(
          (layer) => layer.display_name !== "Ice Ground Truth",
        ),
      }).kind,
    ).toBe("clarification-or-action");
    expect(
      expectedStaticPlan(ACTIVE_LAYER_HIGHLIGHT_QUERY, {
        ...context,
        activeLayer: null,
      }).kind,
    ).toBe("clarification-or-action");
  });

  test("maps fixed-public comparison roles to the live layer identities safely", () => {
    const resolved = resolveLayerArguments({
      args: {
        layer_a: "Ice Forecast",
        layer_b: "Ice Ground Truth",
      },
      layers: [
        {
          id: "forecast-7day-PRED",
          displayName: "SFNO Prediction Daily 10 km 2022-2024",
          canonical: "forecast-7day-PRED",
        },
        {
          id: "forecast-7day-GT",
          displayName: "SFNO Ground Truth Daily 10 km 2022-2024",
          canonical: "forecast-7day-GT",
        },
      ],
      userQuery: PREDICTION_GROUND_TRUTH_QUERY,
      scalarKeys: ["layer_a", "layer_b"],
      arrayKeys: [],
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.args).toEqual({
      layer_a: "SFNO Prediction Daily 10 km 2022-2024",
      layer_b: "SFNO Ground Truth Daily 10 km 2022-2024",
    });
  });
});

function syntheticProviderToolResult(result = {}) {
  const tool = String(result.tool || "unknown_tool");
  const callId = String(result.callId || "");
  const ok = result.ok === true;
  const errorCode = resultErrorCode(result);
  const publicData =
    tool === "list_layers"
      ? {
          layers: [
            "GIBS MODIS True Color",
            "Land Mask",
            "Ice Forecast",
            "Ice Ground Truth",
          ],
        }
      : tool === "list_analyzable_layers"
        ? {
            layers: ["Ice Forecast", "Ice Ground Truth"],
          }
        : undefined;
  const message = ok
    ? `${tool} completed against the fixed public synthetic fixture.`
    : errorCode === "UNSUPPORTED_ANALYSIS" &&
        tool === "calculate_layer_difference"
      ? "The fixed public Land Mask example has no scalar analytics source for a numeric comparison."
      : errorCode === "UNSUPPORTED_ANALYSIS"
        ? "The fixed public RGB imagery example does not expose meaningful scalar values for this analysis."
        : errorCode === "ANIMATION_TOOL_UNAVAILABLE"
          ? "The Animation tool is unavailable in the fixed public synthetic mission."
          : `${tool} could not complete against the fixed public synthetic fixture.`;
  return {
    tool,
    callId,
    ok,
    message,
    ...(publicData ? { data: publicData } : {}),
    ...(errorCode
      ? {
          error: {
            code: String(errorCode),
            message,
          },
        }
      : {}),
  };
}

function boundedValidationContext(
  _context = {},
  includePublicExamples = false,
) {
  if (!includePublicExamples) return { mission: SYNTHETIC_PROVIDER_MISSION };
  // These are test-only public names copied from the checked-in example
  // queries. Never copy the live mission context into a real-provider run.
  const layers = [
    {
      display_name: "GIBS MODIS True Color",
      canonical_name: "GIBS MODIS True Color",
      aliases: ["MODIS True Color"],
      group_path: "",
      visible: true,
      bbox: null,
      time: null,
      type: "tile",
      source_type: "image-tiles",
      analysis: {
        supported: false,
        scalar: false,
        operations: [],
        reason: "Visualization-only RGB imagery has no scalar values.",
      },
    },
    {
      display_name: "Land Mask",
      canonical_name: "Land Mask",
      aliases: [],
      group_path: "",
      visible: true,
      bbox: null,
      time: null,
      type: "data",
      source_type: "reference-mask",
      analysis: {
        supported: false,
        scalar: false,
        operations: [],
        reason:
          "No scalar analytics source or compatible comparison capability is available.",
      },
    },
    {
      display_name: "Ice Forecast",
      canonical_name: "Ice Forecast",
      aliases: ["forecast prediction"],
      group_path: "",
      visible: true,
      bbox: null,
      time: {
        enabled: true,
        available_start: "2023-01-01T00:00:00Z",
        available_end: "2024-12-31T00:00:00Z",
      },
      type: "data",
      source_type: "synthetic-scalar",
      analysis: {
        supported: true,
        scalar: true,
        unit: "%",
        valid_range: [0, 100],
        operations: [
          "mean",
          "statistics",
          "threshold",
          "comparison",
          "temporal-trends",
        ],
      },
    },
    {
      display_name: "Ice Ground Truth",
      canonical_name: "Ice Ground Truth",
      aliases: ["ground truth", "observed sea ice"],
      group_path: "",
      visible: false,
      bbox: null,
      time: {
        enabled: true,
        available_start: "2023-01-01T00:00:00Z",
        available_end: "2024-12-31T00:00:00Z",
      },
      type: "data",
      source_type: "synthetic-scalar",
      analysis: {
        supported: true,
        scalar: true,
        unit: "%",
        valid_range: [0, 100],
        operations: [
          "mean",
          "statistics",
          "threshold",
          "comparison",
          "temporal-trends",
        ],
      },
    },
  ];
  return {
    mission: SYNTHETIC_PROVIDER_MISSION,
    map: {
      center: [-150, 78.5],
      zoom: 3,
      bounds: [-180, 70, 180, 90],
    },
    layers,
    temporal: {
      enabled: true,
      current: "2024-01-15T00:00:00Z",
      start: "2023-01-01T00:00:00Z",
      end: "2024-12-31T00:00:00Z",
    },
    analysis: layers.map((layer) => ({
      layer: layer.display_name,
      visible: layer.visible,
      ...layer.analysis,
    })),
    loadedTools: [],
    activeLayer: {
      name: "Ice Forecast",
      type: "data",
      visible: true,
    },
    activeTools: [],
  };
}

async function restoreProviderLiveBaseline(page, expectedContext) {
  return page.evaluate(async (context) => {
    const api = window.mmgisAPI;
    const errors = [];
    if (!api) return { verified: false, errors: ["mmgisAPI unavailable"] };

    const entries = Object.entries(api.getLayerConfigs?.() || {}).filter(
      ([, layer]) => String(layer?.type || "").toLowerCase() !== "header",
    );
    const displayName = ([key, layer]) =>
      String(layer?.display_name || layer?.display || layer?.name || key);
    const unique = (matches, label) => {
      if (matches.length !== 1) {
        errors.push(
          `${label} live layer match count was ${matches.length}, expected 1`,
        );
        return null;
      }
      return matches[0];
    };
    const forecast = unique(
      entries.filter((entry) => {
        const name = displayName(entry);
        return (
          /\b(?:prediction|predicted|forecast)\b/i.test(name) &&
          !/\bground\s+truth\b|\b(?:observed|observation)\b/i.test(name)
        );
      }),
      "forecast",
    );
    const groundTruth = unique(
      entries.filter((entry) =>
        /\bground\s+truth\b|\b(?:observed|observation)\b/i.test(
          displayName(entry),
        ),
      ),
      "ground truth",
    );
    const landMask = unique(
      entries.filter(
        (entry) => displayName(entry).trim().toLowerCase() === "land mask",
      ),
      "Land Mask",
    );
    const rgb = unique(
      entries.filter((entry) =>
        /\bGIBS MODIS True Color\b/i.test(displayName(entry)),
      ),
      "GIBS MODIS True Color",
    );

    const expectedVisibility = new Map(
      (context.layers || []).map((layer) => [
        String(layer.display_name || "").toLowerCase(),
        layer.visible === true,
      ]),
    );
    const desiredLayers = [
      [forecast, expectedVisibility.get("ice forecast")],
      [groundTruth, expectedVisibility.get("ice ground truth")],
      [landMask, expectedVisibility.get("land mask")],
      [rgb, expectedVisibility.get("gibs modis true color")],
    ];
    for (const [entry, desired] of desiredLayers) {
      if (!entry || typeof desired !== "boolean") continue;
      const [name] = entry;
      const visible = api.getVisibleLayers?.() || {};
      if (visible[name] !== desired)
        await Promise.resolve(api.toggleLayer?.(name, desired));
    }

    const temporal = context?.temporal || {};
    const current = temporal.current;
    if (
      !current ||
      !temporal.start ||
      !temporal.end ||
      !forecast ||
      typeof api.setTime !== "function" ||
      typeof api.setLayerTime !== "function"
    ) {
      errors.push("fixed public temporal baseline is unavailable");
    } else {
      await Promise.resolve(
        api.setTime(temporal.start, current, false, "00:00:00", current),
      );
      await Promise.resolve(api.setLayerTime(forecast[0], current, current));
    }

    const center = context?.map?.center;
    const zoom = Number(context?.map?.zoom);
    const mapTargetValid =
      Array.isArray(center) &&
      center.length >= 2 &&
      Number.isFinite(Number(center[0])) &&
      Number.isFinite(Number(center[1])) &&
      Number.isFinite(zoom);
    let mapSetResult = null;
    if (!mapTargetValid) errors.push("fixed public map baseline is invalid");

    const overlayStore = window.__mmgisAgentChatOverlays || {};
    for (const overlay of Object.values(overlayStore)) {
      if (overlay && typeof overlay.remove === "function") {
        try {
          overlay.remove();
        } catch (_) {
          errors.push("an AgentChat overlay could not be removed");
        }
      }
    }
    window.__mmgisAgentChatOverlays = {};

    // Time and visibility changes can asynchronously reload temporal layers.
    // Restore the map last and wait for Leaflet's animated movement to reach
    // the requested geographic target. The facade is synchronous, so awaiting
    // its return value alone observes the stale pre-animation view.
    const projectedMapError = (observed) => {
      if (!observed || typeof api.map?.project !== "function")
        return Number.POSITIVE_INFINITY;
      try {
        const targetPoint = api.map.project(
          { lat: Number(center[1]), lng: Number(center[0]) },
          zoom,
        );
        const observedPoint = api.map.project(observed, zoom);
        const dx = Number(observedPoint?.x) - Number(targetPoint?.x);
        const dy = Number(observedPoint?.y) - Number(targetPoint?.y);
        return Number.isFinite(dx) && Number.isFinite(dy)
          ? Math.hypot(dx, dy)
          : Number.POSITIVE_INFINITY;
      } catch (_) {
        return Number.POSITIVE_INFINITY;
      }
    };
    const mapMatchesTarget = () => {
      const observed = api.map?.getCenter?.();
      const pixelError = projectedMapError(observed);
      return (
        Number.isFinite(pixelError) &&
        pixelError <= 2 &&
        Number(api.map?.getZoom?.()) === zoom
      );
    };
    const applyAndWaitForMap = async () => {
      mapSetResult = await Promise.resolve(
        api.setMapView?.(Number(center[1]), Number(center[0]), zoom),
      );
      const deadline = performance.now() + 3000;
      while (!mapMatchesTarget() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (mapMatchesTarget()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return mapMatchesTarget();
    };
    let mapSettled = false;
    if (mapTargetValid) {
      mapSettled = await applyAndWaitForMap();
      // A late temporal-layer callback may restore the home view. Reapply at
      // most once; a second failure is reported instead of silently diverging.
      if (!mapSettled) mapSettled = await applyAndWaitForMap();
    }

    const visible = api.getVisibleLayers?.() || {};
    for (const [entry, desired] of desiredLayers) {
      if (
        entry &&
        typeof desired === "boolean" &&
        visible[entry[0]] !== desired
      )
        errors.push(`${displayName(entry)} visibility was not restored`);
    }
    const globalTime = api.getTime?.() || null;
    const layerStartTime = forecast
      ? api.getLayerStartTime?.(forecast[0]) || null
      : null;
    const layerEndTime = forecast
      ? api.getLayerEndTime?.(forecast[0]) || null
      : null;
    const expectedTime = Date.parse(current);
    if (
      Date.parse(globalTime) !== expectedTime ||
      Date.parse(layerStartTime) !== expectedTime ||
      Date.parse(layerEndTime) !== expectedTime
    )
      errors.push("live UI/forecast time does not match the public baseline");

    const mapCenter = api.map?.getCenter?.();
    const mapZoom = api.map?.getZoom?.();
    const mapPixelError = projectedMapError(mapCenter);
    if (
      !mapSettled ||
      !mapCenter ||
      !Number.isFinite(mapPixelError) ||
      mapPixelError > 2 ||
      Number(mapZoom) !== zoom
    )
      errors.push(
        `live map view does not match the public baseline (expected ${JSON.stringify({ center, zoom })}; observed ${JSON.stringify(
          mapCenter
            ? {
                center: [mapCenter.lng, mapCenter.lat],
                zoom: mapZoom,
                projectedPixelError: mapPixelError,
              }
            : null,
        )}; facade result ${JSON.stringify(mapSetResult)}; facade ${String(api.setMapView).slice(0, 160)})`,
      );

    return {
      verified: errors.length === 0,
      errors,
      globalTime,
      layerStartTime,
      layerEndTime,
      forecastVisible: forecast ? visible[forecast[0]] === true : false,
      map: mapCenter
        ? {
            center: [mapCenter.lng, mapCenter.lat],
            zoom: mapZoom,
            projectedPixelError: mapPixelError,
          }
        : null,
    };
  }, expectedContext);
}

function sanitizedProviderRequest(body = {}, includePublicExamples = false) {
  const base = {
    conversationId: body.conversationId || null,
    history: [],
    context: boundedValidationContext(body.context, includePublicExamples),
  };
  if (body.responseId || body.originalMessage || body.toolResults) {
    return {
      ...base,
      responseId: body.responseId || null,
      originalMessage: String(body.originalMessage || ""),
      // Never forward results produced by the loaded live mission to an
      // external provider. Only the action outcome and fixed public test
      // fixture values are needed to exercise response continuation.
      toolResults: (body.toolResults || []).map(syntheticProviderToolResult),
    };
  }
  return {
    ...base,
    message: String(body.message || ""),
  };
}

function interpolate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) =>
    String(values[key] ?? ""),
  );
}

function buildExhaustiveExamples(live) {
  const examples = STATIC_QUERIES.map((query) => ({
    family: "static",
    query,
  }));
  const zoom = exampleConfig.zoom || {};
  for (const region of zoom.regions || []) {
    const regionName = typeof region === "string" ? region : region.name;
    for (const grammar of zoom.grammar || []) {
      if (grammar.includes("{zoom}")) {
        for (const level of zoom.levels || []) {
          examples.push({
            family: "zoom",
            query: interpolate(grammar, {
              region: regionName,
              zoom: level,
            }),
          });
        }
      } else {
        examples.push({
          family: "zoom",
          query: interpolate(grammar, { region: regionName }),
        });
      }
    }
  }
  const layer =
    live.analysisLayer?.displayName || "Synthetic Scalar Fixture Layer";
  const layerA =
    live.analysisLayers?.[0]?.displayName || "Synthetic Fixture Layer A";
  const layerB =
    live.analysisLayers?.[1]?.displayName || "Synthetic Fixture Layer B";
  for (const [group, templates] of Object.entries(
    exampleConfig.dynamicTemplates || {},
  )) {
    for (const template of templates || []) {
      examples.push({
        family: `dynamic:${group}`,
        query: interpolate(template, { layer, layerA, layerB }),
      });
    }
  }
  for (const [group, queries] of Object.entries(
    exampleConfig.contextualQueries || {},
  )) {
    for (const query of queries || []) {
      examples.push({ family: `contextual:${group}`, query });
    }
  }
  return examples;
}

function directFixtureReply(message) {
  if (/\b(compare|difference)\b/i.test(message))
    return "The comparison request was understood. This intercepted UI validation does not contact external analytics sources.";
  if (
    /\b(mean|statistic|average|highlight|concentration|trend)\b/i.test(message)
  )
    return "The analysis request was understood. This intercepted UI validation avoids external raster reads.";
  if (/\btime range\b/i.test(message))
    return "The temporal-range request was understood; the loaded mission determines the available dates.";
  if (/\bMMGIS\b/i.test(message))
    return "MMGIS is a web-based geospatial mission operations and analysis application.";
  return `Understood the request: ${message}`;
}

function informationFixture(message, reply = directFixtureReply(message)) {
  return { kind: "information", reply, actions: [] };
}

function actionFixture(tool, args, callId = `live-${tool}`) {
  return {
    kind: "action",
    actions: [{ tool, callId, args }],
  };
}

function actionFixtures(actions) {
  return { kind: "action", actions };
}

function layerMentionedIn(message, candidates) {
  const lower = message.toLowerCase();
  return [...(candidates || [])]
    .sort((a, b) => b.displayName.length - a.displayName.length)
    .find((candidate) => lower.includes(candidate.displayName.toLowerCase()));
}

function comparisonLayers(message, live) {
  const vs = message.match(/^compare\s+(.+?)\s+vs\.?\s+(.+)$/i);
  if (vs) return [vs[1].trim(), vs[2].trim()];
  const between = message.match(
    /difference between\s+(.+?)\s+and\s+(.+?)(?:\?|$)/i,
  );
  if (between) return [between[1].trim(), between[2].trim()];
  if (/prediction.*ground truth/i.test(message)) {
    const prediction = (live.candidates || []).find((candidate) =>
      /forecast|prediction/i.test(candidate.displayName),
    );
    const groundTruth = (live.candidates || []).find((candidate) =>
      /ground truth|observed|observation/i.test(candidate.displayName),
    );
    return prediction && groundTruth
      ? [prediction.displayName, groundTruth.displayName]
      : null;
  }
  if (/visible analyzable layers/i.test(message)) {
    return live.analysisLayers?.length >= 2
      ? [live.analysisLayers[0].displayName, live.analysisLayers[1].displayName]
      : null;
  }
  return null;
}

function analysisLayerFromMessage(message, live) {
  const mentioned = layerMentionedIn(message, live.candidates);
  if (mentioned) return mentioned.displayName;
  const patterns = [
    /show statistics (?:for|of) (.+?)(?: for the full layer extent)?$/i,
    /calculate (?:the )?(?:mean|average) (?:for|of) (.+)$/i,
    /^analyze (.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return (
    live.analysisLayer?.displayName || "__missing_analysis_fixture_layer__"
  );
}

function configuredRegion(message) {
  const match = (exampleConfig.zoom?.regions || []).find((region) =>
    message.toLowerCase().includes(region.name.toLowerCase()),
  );
  if (match) return match.name;
  if (/zoom to the arctic region/i.test(message)) return "Arctic Ocean";
  return null;
}

function fixtureForMessage(message, live) {
  if (message === live.layerCommand) {
    return actionFixture(
      "toggle_layer",
      {
        name: live.layer.displayName,
        visible: live.layer.desiredVisible,
      },
      "live-layer-toggle",
    );
  }
  if (message === live.timeCommand && live.timeLayer) {
    return actionFixture(
      "set_time",
      {
        time: "latest",
        layers: [live.timeLayer.displayName],
      },
      "live-time-latest",
    );
  }
  if (/\btime range\b/i.test(message)) {
    if (live.timeRange?.start && live.timeRange?.end) {
      const layerLabel = live.timeLayer?.displayName
        ? ` for ${live.timeLayer.displayName}`
        : "";
      return informationFixture(
        message,
        `The configured temporal range${layerLabel} is ${live.timeRange.start} through ${live.timeRange.end}.`,
      );
    }
    return informationFixture(
      message,
      "The loaded mission does not declare an available temporal range for a time-enabled layer.",
    );
  }
  const region = configuredRegion(message);
  if (region && /\b(zoom|show|take me)\b/i.test(message)) {
    const explicitZoom = message.match(/(?:zoom(?: level)?|at zoom)\s+(\d+)/i);
    return actionFixture(
      "zoom_to",
      {
        region,
        ...(explicitZoom ? { zoom: Number(explicitZoom[1]) } : {}),
      },
      `live-zoom-${region.replace(/\W+/g, "-").toLowerCase()}`,
    );
  }
  if (
    /^(List layers|What (?:other )?layers are available|Show available data layers|List visible layers)/i.test(
      message,
    )
  ) {
    return actionFixture("list_layers", {}, "live-list-layers");
  }
  if (/Which layers can I analyze|Show analyzable layers/i.test(message)) {
    return actionFixture("list_analyzable_layers", {}, "live-list-analyzable");
  }
  if (/statistics of the first visible/i.test(message)) {
    return actionFixture(
      "statistics_first_visible",
      { geographical_area: "current view" },
      "live-first-visible-statistics",
    );
  }
  if (/give me statistics for the visible layer/i.test(message)) {
    return actionFixture(
      "statistics_first_visible",
      { geographical_area: "current view" },
      "live-visible-statistics",
    );
  }
  if (
    /\b(?:show statistics (?:for|of)|calculate (?:the )?(?:mean|average)|analyze)\b/i.test(
      message,
    )
  ) {
    const target = analysisLayerFromMessage(message, live);
    return actionFixture(
      "calculate_layer_mean",
      {
        layer_name: target,
        geographical_area: /full layer extent/i.test(message)
          ? "full layer extent"
          : "current view",
      },
      "live-layer-statistics",
    );
  }
  if (/\bhighlight\b.*\b(?:average|mean)\b/i.test(message)) {
    const target =
      layerMentionedIn(message, live.candidates)?.displayName ||
      live.analysisLayer?.displayName ||
      live.rgbLayer?.displayName ||
      "__no_analyzable_live_fixture_layer__";
    return actionFixture(
      "highlight_relative_to_mean",
      {
        layer_name: target,
        geographical_area: "current view",
        direction: /\bbelow\b/i.test(message) ? "below" : "above",
      },
      "live-highlight-relative-mean",
    );
  }
  if (/\b(compare|difference)\b/i.test(message)) {
    if (/\blast week\b/i.test(message)) {
      return informationFixture(
        message,
        "This comparison needs an explicit prior-week time range (or a successful time-control action) before the two rasters can be compared; the deterministic harness will not silently substitute the current map instant.",
      );
    }
    const pair = comparisonLayers(message, live);
    if (!pair) {
      return informationFixture(
        message,
        "Please specify the two analyzable layers you want to compare.",
      );
    }
    const [layerA, layerB] = pair;
    return actionFixture(
      "calculate_layer_difference",
      {
        layer_a: layerA,
        layer_b: layerB,
      },
      "live-layer-difference",
    );
  }
  if (
    /\b(time slider|Set time to January 2024|Move to the latest date|Go to January 2024)\b/i.test(
      message,
    )
  ) {
    if (!live.timeLayer)
      return informationFixture(
        message,
        "No time-enabled layer is available in this live mission.",
      );
    return actionFixture(
      "set_time",
      {
        time: /latest/i.test(message) ? "latest" : "January 2024",
        layers: [live.timeLayer.displayName],
      },
      "live-static-time",
    );
  }
  if (/\bTurn on (?:the forecast prediction|a data) layer/i.test(message)) {
    const target = /forecast prediction/i.test(message)
      ? live.forecastLayer || live.analysisLayer
      : live.analysisLayer;
    if (!target)
      return informationFixture(
        message,
        "No controllable data layer is available in this live mission.",
      );
    return actionFixture(
      "toggle_layer",
      { name: target.displayName, visible: true },
      "live-static-layer-on",
    );
  }
  if (/Show me the sea ice forecast for January 2024/i.test(message)) {
    const target = live.forecastLayer || live.timeLayer;
    if (!target)
      return informationFixture(
        message,
        "No sea-ice forecast layer is available in this live mission.",
      );
    const actions = [
      {
        tool: "toggle_layer",
        callId: "live-show-forecast",
        args: { name: target.displayName, visible: true },
      },
    ];
    if (target.timeEnabled) {
      actions.push({
        tool: "set_time",
        callId: "live-show-forecast-time",
        args: {
          time: "January 2024",
          layers: [target.displayName],
        },
      });
    }
    return actionFixtures(actions);
  }
  if (/\b(?:trend|changes over time)\b/i.test(message)) {
    const namedChange = message.match(/^Show (.+) changes over time$/i);
    const targetName = namedChange?.[1]?.trim() || live.timeLayer?.displayName;
    if (!targetName)
      return informationFixture(
        message,
        "No time-enabled scalar layer is available for a trend analysis.",
      );
    return actionFixture(
      "temporal_trends",
      {
        layer_name: targetName,
        geographical_area: "current view",
        time_start: "2023-01-01",
        time_end: "2023-12-31",
        interval: "monthly",
      },
      "live-temporal-trend",
    );
  }
  if (/^Animate .+ over time$/i.test(message)) {
    return informationFixture(
      message,
      "Animation actions are not available until the host exposes a public tool-opening capability.",
    );
  }
  if (/opacity to 50%/i.test(message)) {
    const target = live.layer;
    if (!target)
      return informationFixture(
        message,
        "No controllable layer is available for opacity changes.",
      );
    return actionFixture(
      "set_layer_opacity",
      { name: target.displayName, opacity: 0.5 },
      "live-opacity",
    );
  }
  if (
    /information about the visible layer|show me layer information/i.test(
      message,
    )
  ) {
    const target = live.layer;
    if (!target)
      return informationFixture(
        message,
        "No user-facing layer is available to describe.",
      );
    return actionFixture(
      "describe_layer",
      { name: target.displayName },
      "live-describe-layer",
    );
  }
  if (/Zoom to the current area of interest/i.test(message)) {
    return informationFixture(
      message,
      "No named area of interest is selected. Specify a region or bounding box to zoom there.",
    );
  }
  if (/predicted sea ice concentration today/i.test(message)) {
    const target = live.forecastLayer || live.analysisLayer;
    if (!target?.analyzable)
      return informationFixture(
        message,
        "No current scalar forecast layer is available for this calculation.",
      );
    return actionFixture(
      "calculate_layer_mean",
      {
        layer_name: target.displayName,
        geographical_area: "current view",
      },
      "live-current-forecast-mean",
    );
  }
  return informationFixture(message);
}

async function discoverLiveFixtures(page) {
  return page.evaluate(async () => {
    const configs = window.mmgisAPI.getLayerConfigs?.() || {};
    const visible = window.mmgisAPI.getVisibleLayers?.() || {};
    const temporalConfig = window.L_?.configData?.time || {};
    const candidates = Object.entries(configs)
      .filter(
        ([, config]) => String(config?.type || "").toLowerCase() !== "header",
      )
      .map(([id, config]) => ({
        id,
        displayName:
          config.display_name || config.displayName || config.name || id,
        visible: !!visible[id],
        timeEnabled: config.time?.enabled === true,
        rgb: /\b(?:true[ -]?color|rgb)\b/i.test(
          config.display_name || config.displayName || config.name || id,
        ),
        analyzable: !!(
          config.demurl ||
          config.cogUrl ||
          config.stac ||
          config.analyticsEndpoint ||
          config.analysis?.endpoint ||
          config.analysis?.supported === true ||
          config.analytics?.supported === true ||
          config.analysis?.operations?.length ||
          config.analytics?.operations?.length ||
          /(?:^|[-_])(stac|cog|geotiff|scalar)(?:$|[-_])/i.test(
            String(
              config.sourceType ||
                config.source_type ||
                config.demSourceType ||
                "",
            ),
          )
        ),
      }));
    const layer =
      candidates.find((candidate) => !candidate.timeEnabled) ||
      candidates[0] ||
      null;
    const timeLayer =
      candidates.find((candidate) => candidate.timeEnabled) || null;
    const analysisLayers = candidates.filter(
      (candidate) => candidate.analyzable,
    );
    const rgbLayer = candidates.find((candidate) => candidate.rgb);
    const forecastLayer = candidates.find((candidate) =>
      /\bforecast|prediction\b/i.test(candidate.displayName),
    );
    if (timeLayer && !timeLayer.visible) {
      await window.mmgisAPI.toggleLayer(timeLayer.id, true);
      timeLayer.visible = true;
      if (layer?.id === timeLayer.id) layer.visible = true;
    }
    window.__copilotSetTimeCalls = [];
    if (typeof window.mmgisAPI.setLayerTime === "function") {
      const original = window.mmgisAPI.setLayerTime.bind(window.mmgisAPI);
      window.mmgisAPI.setLayerTime = async (...args) => {
        window.__copilotSetTimeCalls.push(args);
        return original(...args);
      };
    }
    return {
      candidates,
      layer: layer ? { ...layer, desiredVisible: !layer.visible } : null,
      timeLayer,
      analysisLayer: analysisLayers[0] || null,
      analysisLayers,
      rgbLayer: rgbLayer || null,
      forecastLayer: forecastLayer || null,
      timeRange: {
        start:
          temporalConfig.initialstart ||
          temporalConfig.initialwindowstart ||
          window.mmgisAPI.getStartTime?.() ||
          null,
        end:
          temporalConfig.initialend ||
          temporalConfig.initialwindowend ||
          window.mmgisAPI.getEndTime?.() ||
          null,
      },
      currentBbox: (() => {
        const bounds = window.mmgisAPI.map.getBounds();
        return [
          bounds.getWest(),
          bounds.getSouth(),
          bounds.getEast(),
          bounds.getNorth(),
        ];
      })(),
      initialView: (() => {
        const center = window.mmgisAPI.map.getCenter();
        return {
          latitude: center.lat,
          longitude: center.lng,
          zoom: window.mmgisAPI.map.getZoom(),
        };
      })(),
    };
  });
}

async function openLiveAgentChat(page) {
  await page.goto(`/?mission=${encodeURIComponent(LIVE_MISSION)}`);
  await page.waitForLoadState("domcontentloaded", { timeout: 90000 });
  await page.waitForFunction(
    () => !!(window.mmgisAPI?.map && window.ToolController_?.loaded),
    { timeout: 90000 },
  );
  const panel = page.locator("#mmgis-agentchat-panel");
  if (!(await panel.count())) {
    const launcher = page
      .locator("#mmgisCopilotTopbarButton, #toolButtonSeparated_AgentChat")
      .first();
    await expect(launcher).toBeVisible({ timeout: 30000 });
    await launcher.click();
  }
  await expect(panel).toBeVisible({ timeout: 30000 });
  await page.locator("#agentChatClear").click();
}

async function submitAndRead(page, message, { timeout = 60000 } = {}) {
  const replies = page.locator("#agentChatTranscript .ac-bubble-a .ac-prose");
  const before = await replies.count();
  const input = page.locator("#agentChatInput");
  await input.fill(message);
  await page.locator("#agentChatSend").click();
  await expect(input).toBeEnabled({ timeout });
  await expect(replies).toHaveCount(before + 1, { timeout });
  const text = (await replies.last().innerText()).trim();
  expect(text.length).toBeGreaterThan(0);
  expect(text).not.toBe(GENERIC_EMPTY_REPLY);
  return text;
}

test.describe("@e2e opt-in live MMGIS AgentChat UI", () => {
  test.skip(
    !LIVE_ENABLED,
    "Set COPILOT_LIVE_UI=true (and optionally COPILOT_LIVE_MISSION) to run against a live configured AgentChat mission.",
  );

  let live = null;

  test.beforeEach(async ({ page }) => {
    live = {
      layer: null,
      timeLayer: null,
      analysisLayer: null,
      analysisLayers: [],
      candidates: [],
      rgbLayer: null,
      forecastLayer: null,
      timeRange: null,
      currentBbox: [-180, -90, 180, 90],
      initialView: null,
      layerCommand: "",
      timeCommand: "Move the live time-enabled layer to its latest date",
      plans: [],
      continuations: [],
      initialRequests: [],
      records: [],
      runtimeActionId: null,
      runtimeActionQuery: null,
    };
    await page.route("**/api/agent**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("/tools")) {
        await route.fulfill({ json: registry });
        return;
      }
      if (url.pathname.endsWith("/copilot/demo-queries")) {
        await route.fulfill({ json: exampleConfig });
        return;
      }
      if (url.pathname.endsWith("/continue")) {
        const body = request.postDataJSON();
        live.continuations.push(body);
        const messages = (body.toolResults || [])
          .map((result) => result.message)
          .filter(Boolean);
        await route.fulfill({
          json: {
            reply: messages.join("\n") || "The requested action completed.",
            actions: [],
          },
        });
        return;
      }
      if (url.pathname.endsWith("/api/agent")) {
        const body = request.postDataJSON();
        live.initialRequests.push(body);
        const advertisedRuntimeAction =
          body.message === live.runtimeActionQuery
            ? (body.context?.runtimeCapabilities || []).find(
                (capability) =>
                  capability.id === live.runtimeActionId &&
                  capability.name === live.runtimeActionId,
              )
            : null;
        const fixture = advertisedRuntimeAction
          ? actionFixture(
              advertisedRuntimeAction.name,
              { label: "Beaufort Sea", emphasis: "high" },
              "live-runtime-plugin-action",
            )
          : fixtureForMessage(body.message, live);
        const { kind, ...response } = fixture;
        live.plans.push({
          message: body.message,
          kind,
          actions: fixture.actions || [],
          tools: (fixture.actions || []).map((action) => action.tool),
        });
        await route.fulfill({
          json: {
            conversationId: "live-ui-conversation",
            responseId: `response-${Date.now()}`,
            ...response,
          },
        });
        return;
      }
      await route.continue();
    });

    await openLiveAgentChat(page);
    const discovered = await discoverLiveFixtures(page);
    live.layer = discovered.layer;
    live.timeLayer = discovered.timeLayer;
    live.analysisLayer = discovered.analysisLayer;
    live.analysisLayers = discovered.analysisLayers;
    live.candidates = discovered.candidates;
    live.rgbLayer = discovered.rgbLayer;
    live.forecastLayer = discovered.forecastLayer;
    live.timeRange = discovered.timeRange;
    live.currentBbox = discovered.currentBbox;
    live.initialView = discovered.initialView;
    if (live.layer) {
      live.layerCommand = `${
        live.layer.desiredVisible ? "Turn on" : "Hide"
      } ${live.layer.displayName}`;
    }
  });

  test("submits every configured example family through the actual panel", async ({
    page,
  }, testInfo) => {
    // This deliberately drives 203 sequential requests through one real
    // panel/map instance. Named-region actions wait for Leaflet movement,
    // so the aggregate test needs a larger ceiling than any individual
    // action; submitAndRead still enforces the per-query timeout.
    test.setTimeout(1800000);
    const examples = buildExhaustiveExamples(live);
    expect(examples.length).toBeGreaterThan(STATIC_QUERIES.length);
    for (let index = 0; index < examples.length; index += 1) {
      const { query, family } = examples[index];
      console.info(
        `[AgentChat][example-start] ${index + 1}/${examples.length} ${family}: ${query}`,
      );
      if (index > 0 && index % 25 === 0) {
        await page.locator("#agentChatClear").click();
        if (live.initialView) {
          await page.evaluate(async (view) => {
            await window.mmgisAPI.setMapView(
              view.latitude,
              view.longitude,
              view.zoom,
            );
          }, live.initialView);
        }
      }
      const continuationCount = live.continuations.length;
      // Full-raster statistics remain bounded by the production sampler,
      // but may require several remote COG range reads. Keep the strict
      // result assertion while allowing that real operation more time
      // than ordinary UI actions.
      const actionTimeout = /full layer extent/i.test(query) ? 180000 : 60000;
      let reply;
      try {
        reply = await submitAndRead(page, query, {
          timeout: actionTimeout,
        });
      } catch (error) {
        await testInfo.attach("copilot-example-validation-partial.json", {
          body: Buffer.from(
            JSON.stringify(
              {
                failedAt: {
                  index,
                  family,
                  query,
                },
                completed: live.records,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        });
        throw error;
      }
      const plan = live.plans[live.plans.length - 1];
      expect(plan, query).toMatchObject({ message: query });
      expect(["action", "information"], query).toContain(plan.kind);
      expect(reply.trim().length, query).toBeGreaterThan(0);
      expect(reply, query).not.toMatch(GENERIC_FAILURE_REPLY);
      let results = [];
      if (plan.kind === "action") {
        expect(plan.tools.length, query).toBeGreaterThan(0);
        expect(live.continuations.length, query).toBeGreaterThan(
          continuationCount,
        );
        results = live.continuations
          .slice(continuationCount)
          .flatMap((body) => body.toolResults || []);
        expect(results.length, query).toBeGreaterThan(0);
        for (const result of results) {
          expect(result.tool, query).toBeTruthy();
          expect(
            String(result.message || "").trim().length,
            query,
          ).toBeGreaterThan(0);
        }
        assertMeaningfulToolOutcomes(query, results, {
          live,
          actions: plan.actions,
        });
        if (query === "Calculate mean for GIBS MODIS True Color") {
          expect(results).toHaveLength(1);
          expect(results[0].ok).toBe(false);
          expect(resultErrorCode(results[0])).toBe("UNSUPPORTED_ANALYSIS");
          expect(results[0].message).toMatch(/RGB|scalar|imagery/i);
        }
      }
      const handled = reply.trim().length > 0 && reply !== GENERIC_EMPTY_REPLY;
      const executionSucceeded =
        plan.kind === "action"
          ? results.length > 0 && results.every((result) => result.ok === true)
          : null;
      live.records.push({
        family,
        query,
        intent: plan.kind,
        tools: plan.tools,
        handled,
        executionSucceeded,
        toolResults: results.map((result) => ({
          tool: result.tool,
          ok: result.ok,
          errorCode: result.error?.code || null,
          message: String(result.message || "").slice(0, 1000),
        })),
        response: reply,
      });
      expect(handled, query).toBe(true);
    }
    await testInfo.attach("copilot-example-validation.json", {
      body: Buffer.from(JSON.stringify(live.records, null, 2)),
      contentType: "application/json",
    });
    console.info(
      "[AgentChat][example-validation]",
      JSON.stringify(live.records),
    );
    await page.evaluate((records) => {
      window.__copilotExampleValidation = records;
      console.info("[AgentChat][example-validation]", JSON.stringify(records));
    }, live.records);
  });

  test("welcome suggestion chip and demo play use the actual panel send path", async ({
    page,
  }) => {
    const replies = page.locator("#agentChatTranscript .ac-bubble-a .ac-prose");
    const chip = page.locator("#agentChatSuggestions .ac-suggest-chip").first();
    await expect(chip).toBeVisible({ timeout: 30000 });
    const chipQuery = await chip.getAttribute("data-command");
    const beforeChip = await replies.count();
    await chip.click();
    await expect(replies).toHaveCount(beforeChip + 1, { timeout: 60000 });
    expect((await replies.last().innerText()).trim()).not.toBe(
      GENERIC_EMPTY_REPLY,
    );
    expect(live.plans[live.plans.length - 1]?.message).toBe(chipQuery);

    await page.locator("#agentChatClear").click();
    const beforeDemo = await replies.count();
    await page.locator("#agentChatDemoPlay").click();
    await expect(replies).toHaveCount(beforeDemo + 1, { timeout: 60000 });
    expect((await replies.last().innerText()).trim()).not.toBe(
      GENERIC_EMPTY_REPLY,
    );
    expect(live.plans[live.plans.length - 1]?.message).toBe(STATIC_QUERIES[0]);
  });

  test("named-region navigation changes the real map and renders final text", async ({
    page,
  }) => {
    const reply = await submitAndRead(
      page,
      "Zoom into the Beaufort Sea at zoom level 3",
    );
    expect(reply).toContain("Beaufort Sea");
    const view = await page.evaluate(() => {
      const center = window.mmgisAPI.map.getCenter();
      return {
        lat: center.lat,
        lng: center.lng,
        zoom: window.mmgisAPI.map.getZoom(),
      };
    });
    expect(view.zoom).toBe(3);
    expect(view.lat).toBeCloseTo(73.5, 1);
    expect(view.lng).toBeCloseTo(-146, 1);
  });

  test("layer command changes real visibility and returns verified text", async ({
    page,
  }) => {
    expect(
      live.layer,
      "The live mission must contain a data layer.",
    ).not.toBeNull();
    const reply = await submitAndRead(page, live.layerCommand);
    const actual = await page.evaluate(
      (id) => !!window.mmgisAPI.getVisibleLayers()[id],
      live.layer.id,
    );
    expect(actual).toBe(live.layer.desiredVisible);
    expect(reply).toContain(live.layer.desiredVisible ? "visible" : "hidden");
  });

  test("temporal command invokes the real time facade and returns text", async ({
    page,
  }) => {
    expect(
      live.timeLayer,
      "The live mission must contain a time-enabled layer.",
    ).not.toBeNull();
    const reply = await submitAndRead(page, live.timeCommand);
    const calls = await page.evaluate(() => window.__copilotSetTimeCalls);
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).toContain(live.timeLayer.id);
    expect(reply.toLowerCase()).toContain("time");
  });

  test("restores the public baseline after repeated polar zooms within active-CRS pixel tolerance", async ({
    page,
  }) => {
    const polarViews = [
      [90, 84, 6],
      [-155, 72, 4],
      [135, 78, 5],
      [-45, 82, 7],
      [45, 89.5, 2],
      [125, 76, 4],
    ];
    await page.evaluate(async (views) => {
      const api = window.mmgisAPI;
      for (const [longitude, latitude, zoom] of views) {
        api.setMapView(latitude, longitude, zoom);
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }, polarViews);

    const proof = await restoreProviderLiveBaseline(
      page,
      boundedValidationContext({}, true),
    );
    expect(proof.verified, proof.errors.join("; ")).toBe(true);
    expect(proof.map?.zoom).toBe(3);
    expect(proof.map?.projectedPixelError).toBeGreaterThanOrEqual(0);
    expect(proof.map?.projectedPixelError).toBeLessThanOrEqual(2);
  });

  test("restores and verifies implicit-current forecast statistics after repeated time mutation", async ({
    page,
  }) => {
    const context = boundedValidationContext({}, true);
    for (const mutation of ["2024-01-01T00:00:00Z", "2024-12-31T00:00:00Z"]) {
      if (live.plans.length) await page.locator("#agentChatClear").click();
      const mutated = await page.evaluate(
        async ({ time, temporal }) => {
          const api = window.mmgisAPI;
          const forecast = Object.entries(api.getLayerConfigs?.() || {}).find(
            ([key, layer]) => {
              const name = String(
                layer?.display_name || layer?.display || layer?.name || key,
              );
              return (
                /\b(?:prediction|predicted|forecast)\b/i.test(name) &&
                !/\bground\s+truth\b|\b(?:observed|observation)\b/i.test(name)
              );
            },
          );
          await Promise.resolve(
            api.setTime(temporal.start, time, false, "00:00:00", time),
          );
          if (forecast)
            await Promise.resolve(api.setLayerTime(forecast[0], time, time));
          return api.getTime?.();
        },
        { time: mutation, temporal: context.temporal },
      );
      expect(Date.parse(mutated)).toBe(Date.parse(mutation));

      const baselineProof = await restoreProviderLiveBaseline(page, context);
      expect(baselineProof.verified, baselineProof.errors.join("; ")).toBe(
        true,
      );
      const continuationStart = live.continuations.length;
      const reply = await submitAndRead(
        page,
        PREDICTED_CONCENTRATION_TODAY_QUERY,
      );
      const plan = live.plans.at(-1);
      expect(plan.tools).toEqual(["calculate_layer_mean"]);
      expect(plan.actions[0].args).not.toHaveProperty("time_start");
      expect(plan.actions[0].args).not.toHaveProperty("time_end");
      expect(
        hasUiAnchoredStatisticsTime(plan.actions[0], context, baselineProof),
      ).toBe(true);
      const results = live.continuations
        .slice(continuationStart)
        .flatMap((entry) => entry.toolResults || []);
      const result = correlateToolResults(plan.actions, results)[0];
      expect(result?.ok, result?.message).toBe(true);
      expect(reply).toMatch(/mean|average|statistics/i);
    }
  });

  test("discovers, plans, executes, continues, and unregisters a live runtime plugin action", async ({
    page,
  }) => {
    const plugin = "test/e2e/runtime-action";
    const query = "Use the runtime plug-in to label the Beaufort Sea";
    const actionId = await page.evaluate(
      ({ pluginId }) => {
        window.__copilotRuntimeActionCalls = [];
        return window.mmgisAPI.registerCopilotAction(
          {
            name: "annotate_region",
            plugin: pluginId,
            category: "application/ui-actions",
            description:
              "Add a named region annotation using the live E2E plug-in.",
            parameters: {
              type: "object",
              properties: {
                label: { type: "string" },
                emphasis: {
                  type: "string",
                  enum: ["normal", "high"],
                },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
          async (args, context) => {
            window.__copilotRuntimeActionCalls.push({
              args,
              mission: context?.mission || null,
            });
            return {
              ok: true,
              message: `Runtime plug-in labeled ${args.label} with ${args.emphasis} emphasis.`,
              data: {
                label: args.label,
                emphasis: args.emphasis,
              },
            };
          },
        );
      },
      { pluginId: plugin },
    );
    live.runtimeActionId = actionId;
    live.runtimeActionQuery = query;

    try {
      const listed = await page.evaluate(async (id) => {
        const actions = await window.mmgisAPI.listCopilotActions({
          availableOnly: true,
        });
        return actions.find((action) => action.id === id) || null;
      }, actionId);
      expect(listed).toMatchObject({
        id: actionId,
        name: "annotate_region",
        plugin,
        available: true,
      });

      const continuationStart = live.continuations.length;
      const reply = await submitAndRead(page, query);
      const request = live.initialRequests.find(
        (entry) => entry.message === query,
      );
      const advertised = request?.context?.runtimeCapabilities?.find(
        (capability) => capability.id === actionId,
      );
      expect(advertised).toMatchObject({
        id: actionId,
        name: actionId,
        displayName: "annotate_region",
        plugin,
        category: "application/ui-actions",
      });
      expect(advertised.parameters).toMatchObject({
        required: ["label"],
        additionalProperties: false,
      });

      const plan = live.plans.find((entry) => entry.message === query);
      expect(plan).toMatchObject({
        kind: "action",
        tools: [actionId],
      });
      expect(plan.actions[0]).toMatchObject({
        tool: actionId,
        args: { label: "Beaufort Sea", emphasis: "high" },
      });

      const continuation = live.continuations
        .slice(continuationStart)
        .find((body) =>
          body.toolResults?.some((result) => result.tool === actionId),
        );
      expect(continuation).toBeTruthy();
      expect(continuation.toolResults).toContainEqual(
        expect.objectContaining({
          tool: actionId,
          callId: "live-runtime-plugin-action",
          ok: true,
          message: "Runtime plug-in labeled Beaufort Sea with high emphasis.",
          data: {
            label: "Beaufort Sea",
            emphasis: "high",
          },
        }),
      );
      const calls = await page.evaluate(
        () => window.__copilotRuntimeActionCalls,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        args: { label: "Beaufort Sea", emphasis: "high" },
      });
      expect(calls[0].mission.toLowerCase()).toBe(LIVE_MISSION.toLowerCase());
      expect(reply).toBe(
        "Runtime plug-in labeled Beaufort Sea with high emphasis.",
      );
    } finally {
      const cleanup = await page.evaluate(
        async ({ id, pluginId }) => {
          const removed = window.mmgisAPI.unregisterCopilotAction(id, pluginId);
          const remaining = await window.mmgisAPI.listCopilotActions();
          return {
            removed,
            stillRegistered: remaining.some((action) => action.id === id),
          };
        },
        { id: actionId, pluginId: plugin },
      );
      expect(cleanup).toEqual({
        removed: true,
        stillRegistered: false,
      });
    }
  });
});

test.describe("@e2e opt-in real-provider MMGIS AgentChat UI", () => {
  test.skip(
    !REAL_PROVIDER_ENABLED,
    "Set COPILOT_REAL_PROVIDER=true to run the public named-region request through the real local Agent backend/provider.",
  );

  test("real provider handles public paraphrases without receiving live mission metadata", async ({
    page,
  }, testInfo) => {
    test.setTimeout(600000);
    const traffic = [];
    await page.route("**/api/agent**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isAgentPost =
        request.method() === "POST" &&
        (url.pathname.endsWith("/api/agent") ||
          url.pathname.endsWith("/api/agent/continue"));
      if (!isAgentPost) {
        await route.continue();
        return;
      }
      const body = request.postDataJSON();
      const sanitized = sanitizedProviderRequest(body, false);
      const isContinuation = url.pathname.endsWith("/continue");
      url.searchParams.set("mission", SYNTHETIC_PROVIDER_MISSION);
      const headers = {
        ...request.headers(),
        "content-type": "application/json",
      };
      delete headers["content-length"];
      const upstream = await route.fetch({
        url: url.toString(),
        postData: JSON.stringify(sanitized),
        headers,
      });
      const responseText = await upstream.text();
      let responsePayload = null;
      try {
        responsePayload = JSON.parse(responseText);
      } catch (_) {
        responsePayload = { reply: responseText };
      }
      traffic.push({
        kind: isContinuation ? "continue" : "initial",
        request: sanitized,
        response: responsePayload,
        status: upstream.status(),
      });
      await route.fulfill({ response: upstream, body: responseText });
    });

    await openLiveAgentChat(page);
    const queries = [
      {
        query: "What layers can be analyzed?",
        expectedTool: "list_analyzable_layers",
        outcome: "success",
      },
      {
        query: "Give me stats for the visible layer",
        expectedTool: "statistics_first_visible",
        outcome: "success-or-limitation",
      },
      {
        query: "Take me to the Beaufort Sea",
        expectedTool: "zoom_to",
        outcome: "success",
        zoom: null,
      },
      {
        query: "Show the Beaufort Sea at zoom 3",
        expectedTool: "zoom_to",
        outcome: "success",
        zoom: 3,
      },
      {
        query: "Hide the current layer",
        expectedTool: null,
        outcome: "clarification",
      },
    ];
    const allowedStatisticsLimitations = new Set([
      "NO_VISIBLE_ANALYZABLE_LAYER",
      "UNSUPPORTED_ANALYSIS",
      "STATISTICS_SOURCE_UNAVAILABLE",
      "STATISTICS_RESULT_INVALID",
      "LOCAL_ANALYTICS_CRS_MISSING",
      "LOCAL_ANALYTICS_CRS_UNSUPPORTED",
      "LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED",
    ]);
    const records = [];
    for (let index = 0; index < queries.length; index += 1) {
      const item = queries[index];
      if (index > 0) await page.locator("#agentChatClear").click();
      const trafficStart = traffic.length;
      const reply = await submitAndRead(page, item.query);
      const turnTraffic = traffic.slice(trafficStart);
      const actions = turnTraffic.flatMap((entry) =>
        Array.isArray(entry.response?.actions) ? entry.response.actions : [],
      );
      const toolResults = turnTraffic
        .filter((entry) => entry.kind === "continue")
        .flatMap((entry) => entry.request.toolResults || []);

      expect(reply, item.query).not.toMatch(GENERIC_FAILURE_REPLY);
      if (item.expectedTool) {
        expect(
          actions.map((action) => action.tool),
          item.query,
        ).toContain(item.expectedTool);
        expect(
          turnTraffic.some((entry) => entry.kind === "continue"),
          item.query,
        ).toBe(true);
        assertMeaningfulToolOutcomes(item.query, toolResults);
        const expectedResults = toolResults.filter(
          (result) => result.tool === item.expectedTool,
        );
        expect(expectedResults.length, item.query).toBeGreaterThan(0);
        if (item.outcome === "success") {
          expect(
            expectedResults.every((result) => result.ok === true),
            item.query,
          ).toBe(true);
        } else {
          for (const result of expectedResults) {
            if (result.ok === true) continue;
            expect(
              allowedStatisticsLimitations.has(resultErrorCode(result)),
              `${item.query}: unexpected limitation ${resultErrorCode(result)}`,
            ).toBe(true);
          }
        }
      } else {
        expect(actions, item.query).toHaveLength(0);
        expect(toolResults, item.query).toHaveLength(0);
        expect(isGroundedCurrentLayerAmbiguity(reply), item.query).toBe(true);
      }

      if (item.expectedTool === "zoom_to") {
        expect(reply).toMatch(/Beaufort Sea/i);
        const view = await page.evaluate(() => {
          const center = window.mmgisAPI.map.getCenter();
          return {
            lat: center.lat,
            lng: center.lng,
            zoom: window.mmgisAPI.map.getZoom(),
          };
        });
        if (item.zoom != null) expect(view.zoom).toBe(item.zoom);
        expect(view.lat).toBeCloseTo(73.5, 1);
        expect(view.lng).toBeCloseTo(-146, 1);
      }

      const failedResults = toolResults.filter((result) => result.ok !== true);
      records.push({
        query: item.query,
        context: "fixed-public-synthetic",
        intent: actions.length ? "action" : "clarification",
        tools: actions.map((action) => action.tool),
        handled: reply.trim().length > 0,
        executionSucceeded: actions.length ? failedResults.length === 0 : null,
        outcome: actions.length
          ? failedResults.length
            ? "unsupported"
            : "success"
          : "clarification",
        toolResults: toolResults.map((result) => ({
          tool: result.tool,
          callId: result.callId,
          ok: result.ok,
          errorCode: resultErrorCode(result),
          message: result.message,
        })),
        response: reply,
      });
    }

    expect(traffic.filter((item) => item.kind === "initial")).toHaveLength(
      queries.length,
    );
    for (const entry of traffic) {
      expect(entry.request.context).toEqual({
        mission: SYNTHETIC_PROVIDER_MISSION,
      });
      expect(entry.request.history).toEqual([]);
      expect(JSON.stringify(entry.request)).not.toMatch(
        /https?:|features?|geometry|properties|description/i,
      );
    }
    await testInfo.attach("copilot-real-provider-paraphrases.json", {
      body: Buffer.from(JSON.stringify(records, null, 2)),
      contentType: "application/json",
    });
    console.info(
      "[AgentChat][real-provider-paraphrases]",
      JSON.stringify(records),
    );
  });
});

test.describe("@e2e opt-in real-provider public exhaustive examples", () => {
  test.skip(
    !REAL_EXAMPLES_ENABLED,
    "Set COPILOT_REAL_EXAMPLES=true to run all 203 configured examples with fixed public synthetic context. This makes hundreds of provider requests and may incur rate-limit usage and cost; no live mission metadata is transmitted.",
  );

  test("records every configured example through the real backend and provider using only public synthetic context", async ({
    page,
  }, testInfo) => {
    test.setTimeout(7200000);
    const traffic = [];
    let currentExample = null;
    await page.route("**/api/agent**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isAgentPost =
        request.method() === "POST" &&
        (url.pathname.endsWith("/api/agent") ||
          url.pathname.endsWith("/api/agent/continue"));
      if (!isAgentPost) {
        await route.continue();
        return;
      }
      const isContinuation = url.pathname.endsWith("/continue");
      const sanitized = sanitizedProviderRequest(request.postDataJSON(), true);
      url.searchParams.set("mission", SYNTHETIC_PROVIDER_MISSION);
      const headers = {
        ...request.headers(),
        "content-type": "application/json",
      };
      delete headers["content-length"];
      const upstream = await route.fetch({
        url: url.toString(),
        postData: JSON.stringify(sanitized),
        headers,
      });
      const responseText = await upstream.text();
      let responsePayload = null;
      try {
        responsePayload = JSON.parse(responseText);
      } catch (_) {
        responsePayload = { reply: responseText };
      }
      traffic.push({
        kind: isContinuation ? "continue" : "initial",
        exampleIndex: currentExample?.index ?? null,
        urlPath: url.pathname,
        request: sanitized,
        response: responsePayload,
        status: upstream.status(),
      });
      await route.fulfill({ response: upstream, body: responseText });
    });

    await openLiveAgentChat(page);
    const publicFixture = {
      analysisLayer: { displayName: "Ice Forecast" },
      analysisLayers: [
        { displayName: "Ice Forecast" },
        { displayName: "Ice Ground Truth" },
      ],
    };
    const examples = buildExhaustiveExamples(publicFixture);
    const expectedContext = boundedValidationContext({}, true);
    const expectedConfiguredCount =
      STATIC_QUERIES.length +
      (exampleConfig.zoom?.regions || []).length *
        (exampleConfig.zoom?.grammar || []).reduce(
          (count, grammar) =>
            count +
            (grammar.includes("{zoom}")
              ? (exampleConfig.zoom?.levels || []).length
              : 1),
          0,
        ) +
      Object.values(exampleConfig.dynamicTemplates || {}).reduce(
        (count, templates) => count + templates.length,
        0,
      ) +
      Object.values(exampleConfig.contextualQueries || {}).reduce(
        (count, queries) => count + queries.length,
        0,
      );
    expect(examples).toHaveLength(expectedConfiguredCount);
    expect(examples.length).toBeGreaterThanOrEqual(203);
    testInfo.annotations.push({
      type: "provider-usage",
      description: `${examples.length} initial provider requests plus action continuations; this opt-in validation may be slow, rate-limited, and billable.`,
    });
    const records = [];
    try {
      for (let index = 0; index < examples.length; index += 1) {
        if (index > 0) await page.locator("#agentChatClear").click();
        const example = examples[index];
        const { query, family } = example;
        currentExample = { index, family, query };
        const baselineProof = await restoreProviderLiveBaseline(
          page,
          expectedContext,
        );
        currentExample = { ...currentExample, baselineProof };
        expect(
          baselineProof.verified,
          `${query}: failed to restore fixed public live baseline: ${baselineProof.errors.join(
            "; ",
          )}`,
        ).toBe(true);
        console.info(
          `[AgentChat][real-provider-example-start] ${index + 1}/${examples.length} ${family}: ${query}`,
        );
        const trafficStart = traffic.length;
        const response = await submitAndRead(page, query);
        const turnTraffic = traffic.slice(trafficStart);
        const turnInitials = turnTraffic.filter(
          (entry) => entry.kind === "initial",
        );
        expect(
          turnInitials,
          `${query}: expected exactly one initial provider request for example index ${index}`,
        ).toHaveLength(1);
        expect(turnInitials[0].exampleIndex, query).toBe(index);
        expect(turnInitials[0].request?.message, query).toBe(query);
        const actions = turnTraffic.flatMap((entry) =>
          Array.isArray(entry.response?.actions) ? entry.response.actions : [],
        );
        const toolResults = turnTraffic
          .filter((entry) => entry.kind === "continue")
          .flatMap((entry) => entry.request.toolResults || []);
        currentExample = {
          ...currentExample,
          response: response.slice(0, 4000),
          actions: actions.map((action) => ({
            tool: action.tool,
            callId: action.callId || null,
            args: action.args || {},
          })),
          turnTraffic: turnTraffic.map((entry) => ({
            kind: entry.kind,
            exampleIndex: entry.exampleIndex,
            urlPath: entry.urlPath,
            requestMessage:
              entry.request?.message || entry.request?.originalMessage || null,
            status: entry.status,
            actions: (entry.response?.actions || []).map((action) => ({
              tool: action.tool,
              callId: action.callId || null,
              args: action.args || {},
            })),
            toolResults: (entry.request?.toolResults || []).map((result) => ({
              tool: result.tool,
              callId: result.callId || null,
              ok: result.ok,
              errorCode: resultErrorCode(result),
            })),
          })),
        };
        const handled =
          response.trim().length > 0 && response !== GENERIC_EMPTY_REPLY;
        const executionSucceeded = actions.length
          ? toolResults.length > 0 &&
            toolResults.every((result) => result.ok === true)
          : null;
        expect(handled, query).toBe(true);
        expect(response, query).not.toMatch(GENERIC_FAILURE_REPLY);
        const expectedPlan = expectedConfiguredPlan(example, expectedContext);
        const selectedTools = actions.map((action) => action.tool);
        if (expectedPlan.kind === "list-layers-or-grounded-data-inventory") {
          expect(
            classifyDataLayerInventoryOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
            }),
            `${query}: expected a successful list_layers action or a complete bounded inventory of every type:data layer with useful status`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "unsupported-tool-or-explanation") {
          expect(
            classifyRgbMeanUnsupportedOutcome({
              query,
              actions,
              toolResults,
              response,
            }),
            `${query}: expected calculate_layer_mean → UNSUPPORTED_ANALYSIS or a grounded no-action RGB/scalar limitation`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "land-mask-limitation") {
          expect(
            classifyLandMaskComparisonOutcome({
              query,
              actions,
              toolResults,
              response,
            }),
            `${query}: expected calculate_layer_difference → UNSUPPORTED_ANALYSIS or a grounded no-action Land Mask/scalar limitation`,
          ).not.toBeNull();
        } else if (
          expectedPlan.kind === "visible-analyzable-comparison"
        ) {
          expect(
            classifyVisibleAnalyzableComparisonOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
            }),
            `${query}: expected a successful difference between two visible comparison-capable layers, or a grounded one-visible-layer clarification with a uniquely resolved hidden candidate`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "layer-visible-or-toggle") {
          expect(
            classifyLayerVisibilityOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
              targetLayerName: expectedPlan.targetLayer,
            }),
            `${query}: expected a successful hidden-target toggle or exact context proof that the uniquely resolved target is already visible`,
          ).not.toBeNull();
        } else if (
          expectedPlan.kind ===
          "analysis-action-or-grounded-operation-clarification"
        ) {
          expect(
            classifyGenericLayerAnalysisOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
              targetLayerName: expectedPlan.targetLayer,
              allowedTools: expectedPlan.tools,
            }),
            `${query}: expected a successful grounded analysis action or a unique-layer clarification offering at least two categories derived from sanitized operations/current tools`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "last-week-comparison-limitation") {
          expect(actions, query).toHaveLength(0);
          expect(
            isGroundedLastWeekComparisonLimitation(response),
            `${query}: expected an explicit single-time limitation plus a current-time or single-date alternative`,
          ).toBe(true);
        } else if (expectedPlan.kind === "aoi-zoom-or-grounded-clarification") {
          expect(
            classifyAoiZoomOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
            }),
            `${query}: expected a successful zoom_to matching a configured AOI or a grounded missing-AOI clarification with resolvable alternatives`,
          ).not.toBeNull();
        } else if (
          expectedPlan.kind === "temporal-trend-or-grounded-layer-clarification"
        ) {
          expect(
            classifyTemporalTrendOutcome({
              actions,
              toolResults,
              response,
              context: expectedContext,
            }),
            `${query}: expected a successful temporal_trends action for a uniquely grounded layer or a 2023 trend clarification naming two distinct time-enabled scalar candidates`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "grounded-animation-unavailable") {
          expect(
            classifyAnimationOutcome({ actions, toolResults, response }),
            `${query}: expected a grounded no-action host capability limitation`,
          ).not.toBeNull();
        } else if (expectedPlan.kind === "analyzable-layer-action") {
          expect(
            actions.length
              ? hasSuccessfulAnalyzableLayerActions(
                  actions,
                  toolResults,
                  expectedContext,
                )
              : isGroundedAlreadyVisibleAnalyzableLayer(
                  response,
                  expectedContext,
                ),
            `${query}: expected a successful hidden analyzable-layer toggle/list/mean, or exact context proof that a named analyzable layer is already visible`,
          ).toBe(true);
        } else if (
          expectedPlan.kind === "action-current-ui-day-or-area-clarification"
        ) {
          if (!actions.length) {
            expect(
              isGroundedPredictedConcentrationAreaClarification(
                response,
                expectedContext,
              ),
              `${query}: expected a time-anchored explanation of spatial ambiguity plus a current-view or named-region choice`,
            ).toBe(true);
          } else {
            expect(
              classifyPredictedTodayActionOutcome({
                actions,
                toolResults,
                context: expectedContext,
                baselineProof,
              }),
              `${query}: expected a successful grounded mean, optionally preceded by a successful exact-current set_time for only the uniquely resolved forecast`,
            ).toBe("tool-success");
          }
        } else if (expectedPlan.kind === "action-required-optional") {
          expect(actions.length, query).toBeGreaterThan(0);
          for (const tool of expectedPlan.tools)
            expect(selectedTools, query).toContain(tool);
          const permittedTools = new Set([
            ...expectedPlan.tools,
            ...(expectedPlan.optionalTools || []),
          ]);
          expect(
            selectedTools.every((tool) => permittedTools.has(tool)),
            `${query}: selected an unexpected tool (${selectedTools.join(", ")})`,
          ).toBe(true);
          for (const tool of expectedPlan.successTools || []) {
            const results = toolResults.filter(
              (result) => result.tool === tool,
            );
            expect(
              results.length,
              `${query}: ${tool} did not return a result`,
            ).toBeGreaterThan(0);
            expect(
              results.every((result) => result.ok === true),
              `${query}: ${tool} must succeed`,
            ).toBe(true);
          }
        } else if (expectedPlan.kind === "action") {
          expect(actions.length, query).toBeGreaterThan(0);
          for (const tool of expectedPlan.tools)
            expect(selectedTools, query).toContain(tool);
        } else if (expectedPlan.kind === "action-any") {
          expect(actions.length, query).toBeGreaterThan(0);
          expect(
            selectedTools.some((tool) => expectedPlan.tools.includes(tool)),
            query,
          ).toBe(true);
        } else if (expectedPlan.kind === "information") {
          expect(actions, query).toHaveLength(0);
        } else if (expectedPlan.kind === "clarification") {
          expect(actions, query).toHaveLength(0);
          expect(response, query).toMatch(CLARIFICATION_OR_LIMITATION_REPLY);
        } else if (
          expectedPlan.kind === "clarification-or-action" &&
          actions.length
        ) {
          expect(
            selectedTools.some((tool) => expectedPlan.tools.includes(tool)),
            query,
          ).toBe(true);
        } else if (expectedPlan.kind === "clarification-or-action") {
          expect(response, query).toMatch(CLARIFICATION_OR_LIMITATION_REPLY);
        } else if (expectedPlan.kind === "information-or-clarification") {
          expect(actions, query).toHaveLength(0);
        }
        if (actions.length) {
          expect(
            turnTraffic.some((entry) => entry.kind === "continue"),
            query,
          ).toBe(true);
          assertMeaningfulToolOutcomes(query, toolResults);
        }
        if (query === RGB_MEAN_QUERY) {
          expect(
            classifyRgbMeanUnsupportedOutcome({
              query,
              actions,
              toolResults,
              response,
            }),
            `${query}: invalid unsupported-analysis outcome`,
          ).not.toBeNull();
        }
        const intent = actions.length
          ? "action"
          : CLARIFICATION_OR_LIMITATION_REPLY.test(response) ||
              isGroundedLastWeekComparisonLimitation(response) ||
              classifyAoiZoomOutcome({
                actions,
                toolResults,
                response,
                context: expectedContext,
              }) === "grounded-clarification" ||
              isGroundedPredictedConcentrationAreaClarification(
                response,
                expectedContext,
              ) ||
              classifyVisibleAnalyzableComparisonOutcome({
                actions,
                toolResults,
                response,
                context: expectedContext,
              }) === "grounded-clarification" ||
              classifyGenericLayerAnalysisOutcome({
                actions,
                toolResults,
                response,
                context: expectedContext,
                targetLayerName: expectedPlan.targetLayer,
                allowedTools: expectedPlan.tools,
              }) === "grounded-clarification"
            ? "clarification"
            : "information";
        const outcome = actions.length
          ? executionSucceeded
            ? "success"
            : "unsupported"
          : intent === "clarification"
            ? "clarification"
            : "success";
        expect(["success", "clarification", "unsupported"], query).toContain(
          outcome,
        );
        records.push({
          index,
          family,
          query,
          context: "fixed-public-synthetic",
          baselineProof,
          intent,
          actions: actions.map((action) => ({
            tool: action.tool,
            callId: action.callId || null,
            args: action.args || {},
          })),
          tools: actions.map((action) => action.tool),
          handled,
          executionSucceeded,
          outcome,
          toolResults: toolResults.map((result) => ({
            tool: result.tool,
            callId: result.callId,
            ok: result.ok,
            message: result.message,
            errorCode: resultErrorCode(result),
          })),
          response,
        });
      }
    } catch (error) {
      await testInfo.attach(
        "copilot-real-public-exhaustive-validation-partial.json",
        {
          body: Buffer.from(
            JSON.stringify(
              {
                failedAt: currentExample,
                completed: records,
              },
              null,
              2,
            ),
          ),
          contentType: "application/json",
        },
      );
      console.info(
        "[AgentChat][real-public-exhaustive-validation-partial]",
        JSON.stringify({
          failedAt: currentExample,
          completed: records,
        }),
      );
      throw error;
    }
    const initialTrafficAudit = auditInitialExampleTraffic(examples, traffic);
    expect(
      initialTrafficAudit.issues,
      `Initial request audit failed: ${JSON.stringify(
        initialTrafficAudit.issues,
      )}`,
    ).toEqual([]);
    expect(initialTrafficAudit.initial).toHaveLength(
      examples.length,
    );
    const publicQueries = new Set(examples.map(({ query }) => query));
    for (const entry of traffic) {
      expect(entry.request.context).toEqual(expectedContext);
      expect(entry.request.history).toEqual([]);
      expect(
        publicQueries.has(
          entry.request.message || entry.request.originalMessage,
        ),
      ).toBe(true);
      if (entry.kind === "continue") {
        for (const result of entry.request.toolResults || []) {
          expect(result.message).toMatch(/fixed public/i);
          expect(result.data || {}).not.toHaveProperty("features");
          expect(result.data || {}).not.toHaveProperty("geometry");
        }
      }
    }
    const serializedRequests = JSON.stringify(
      traffic.map((entry) => entry.request),
    );
    expect(serializedRequests).not.toMatch(
      /https?:|features?|geometry|properties|description/i,
    );
    await testInfo.attach("copilot-real-public-exhaustive-validation.json", {
      body: Buffer.from(JSON.stringify(records, null, 2)),
      contentType: "application/json",
    });
    console.info(
      "[AgentChat][real-public-exhaustive-validation]",
      JSON.stringify(records),
    );
  });
});
