require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { haveFasEnv, runAgentMessage, streamAgentMessage } = require("./azureService");
const gemini = require("./geminiService");

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
    return parsed;
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
const _defaultToolDescriptions = _defaultToolsList
  .map((t) => `- ${t.name}: ${t.description || "No description provided."}`)
  .join("\n");

function resolveToolInfo(options = {}) {
  const toolsArray = options.registry?.tools || _defaultToolsList;
  const toolNames = options.toolNames || _defaultToolNames;
  const toolNameList = options.toolNames
    ? [...options.toolNames].sort()
    : _defaultToolNameList;
  const toolDescriptions = options.registry
    ? toolsArray
        .map((t) => `- ${t.name}: ${t.description || "No description provided."}`)
        .join("\n")
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
    return `${index + 1}. ${display}${canonicalText}${aliasText}${visibleText}${bbox}`;
  });
  return lines.join("\n");
}

function formatLayerSummaries(layerSummaries = []) {
  if (!Array.isArray(layerSummaries) || layerSummaries.length === 0) return "";
  const lines = layerSummaries.slice(0, 80).map((item) => {
    const cite = item.citation ? ` (source: ${item.citation})` : "";
    return `- ${item.name}: ${item.summary}${cite}`;
  });
  return lines.join("\n");
}

function haveAzureEnv() {
  const fas = haveFasEnv();
  return { ok: fas.ok, missing: fas.missing, ver: fas.apiVersion };
}

function buildPrompt(message, context = {}, toolOptions = {}) {
  const { toolDescriptions } = resolveToolInfo(toolOptions);
  const layerCatalog = formatLayerCatalog(context.layerHints);
  const layerSummaries = formatLayerSummaries(context.layerSummaries);
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
  promptParts.push(
    "Always respond with minified JSON on a single line that matches this schema:",
    '{"actions":[{"tool":"string","args":{}}],"reply":"optional markdown string","citations":[{"title":"string","url":"string"}]}',
    "Guidelines:",
    "- Use actions for map-centric requests (layer visibility, opacity, zoom, etc.).",
    "- Normalize typos or paraphrasing to identify the correct tool and layer.",
    "- Resolve layer names using the catalog above; prefer exact display_name matches when possible.",
    "- When a layer match is inferred (no exact match), confirm with the user first: respond with actions:[] and a clarifying reply that cites the resolved layer.",
    "- IMPORTANT: For 'turn off all layers' or 'disable all layers' requests, create multiple toggle_layer actions (one for each visible layer) with visible:false. Do not just list layers.",
    "- For 'current time setting' or 'what time is it' queries: Look at the layer catalog's temporal information. Report the current temporal setting of visible layers based on their data ranges. NEVER use new Date() or system time. If no temporal information is available, state that explicitly.",
    "- For spatial analysis tools (detect_anomalies, spatial_statistics, calculate_layer_mean, etc.) when no specific geographic area is mentioned, use 'current view' as the geographical_area. When no specific layer is mentioned, automatically select the first visible data layer from the catalog.",
    "- When asked 'which layers can I analyze' or 'what data supports analysis', use the list_analyzable_layers tool.",
    "- IMPORTANT: When asked 'explain what this layer shows' or 'what does this show' without specifying a layer name, provide information about ALL currently visible layers (where visible:true in the catalog). Use layer_information tool for each visible layer.",
    "- For vague layer references like 'this layer' or 'current layer', interpret as referring to all visible layers and explain each one.",
    "- If no available tool precisely satisfies the request, suggest the closest supported tool in the reply and wait for explicit user confirmation (keep actions empty until confirmed).",
    "- Include the original user query in args.original_query when asking for confirmation on layer-specific tools.",
    "- For informational questions, set actions to [] and populate reply with a concise, grounded summary.",
    "- When reply cites external knowledge, include 2-4 representative citations array entries (title + URL).",
    "- Prefer sources from the MMGIS documentation and GitHub repositories surfaced via your Bing grounding connection.",
    "- Never invent tool names; only use those listed above. Omit actions if none are required.",
    "- Do NOT execute or invoke tools/functions in this conversation-only describe the plan in JSON.",
    "- After an analysis or animation completes (i.e., the previous assistant turn invoked run_analysis or open_animation_tool), include a 2-3 sentence plain-language summary in reply describing what the result shows: key values, patterns, or what the user should look for. Do not leave reply empty after a processing tool.",
    "- Highlight intent detection: Treat requests phrased as \"highlight ...\", \"show me the areas/region where ...\", or any comparative statements (\"greater than\", \"less than\", \"at least\", \"at most\", etc.) as threshold_highlight actions. Extract the variable/layer, operator (> ≥ < ≤ = between), and numeric value(s) (strip unit words such as \"meters\").",
    "- For range requests (\"between A and B\"), set operator:\"between\" and supply both bounds via value_min/value_max. For single-sided comparisons, place the numeric threshold in value.",
    "- Convert temporal phrases (\"past week\", \"past month\", \"between <date1> and <date2>\") into explicit ISO timestamps using time_start/time_end so the layer can be filtered before rescaling.",
    "- Comparison/difference intent: When users ask to 'compare', 'difference', 'subtract', or 'prediction vs ground truth', use calculate_layer_difference with the two layer names as layer_a and layer_b. layer_a is the minuend (e.g. prediction), layer_b is the subtrahend (e.g. ground truth). Do NOT include a set_time action unless the user explicitly asks to change the date. 'Current date' or 'for now' means use whatever time is already set on the map — just run calculate_layer_difference without changing the time.",
    "Tool usage quick reference:",
    '  * List visible layers -> {"actions":[{"tool":"list_layers","args":{}}]}',
    '  * Show analyzable layers -> {"actions":[{"tool":"list_analyzable_layers","args":{}}]}',
    '  * Toggle visibility -> {"actions":[{"tool":"toggle_layer","args":{"name":"Layer","visible":true}}]}',
    '  * Turn off ALL layers -> {"actions":[{"tool":"toggle_layer","args":{"name":"Layer1","visible":false}},{"tool":"toggle_layer","args":{"name":"Layer2","visible":false}},...]}',
    '  * Set time -> {"actions":[{"tool":"set_time","args":{"time":"February 2024"}}]}',
    '  * Adjust opacity -> {"actions":[{"tool":"set_layer_opacity","args":{"name":"Layer","opacity":0.5}}]}',
    '  * Zoom -> {"actions":[{"tool":"zoom_to","args":{"center":[lon,lat],"zoom":12}}]}',
    '  * Layer info -> {"actions":[{"tool":"layer_information","args":{"layer_name":"Air Quality Index","original_query":"Show me air quality data"}}]}',
    '  * Mean value -> {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Sea Surface Temperature","geographical_area":"Beaufort Sea"}}]}',
    '  * Contours -> {"actions":[{"tool":"visualize_contours","args":{"layer_name":"Sea Surface Temperature","variable":"temperature","operator":">","value":2.5,"time":"2024-06-01T00:00:00Z"}}]}',
    '  * Highlight threshold -> {"actions":[{"tool":"threshold_highlight","args":{"layer_name":"ice thickness","variable":"ice_thickness","operator":">=","value":3}}]}',
    '  * Detect anomalies (auto-select layer) -> {"actions":[{"tool":"detect_anomalies","args":{"layer_name":"<first visible layer>"}}]}',
    '  * Show / hide vessels (live AIS) -> {"actions":[{"tool":"show_vessels","args":{"visible":true}}]} (use for "show ships", "vessels on map", "hide vessels"; add types/flags filters when named, e.g. {"types":"Cargo,Tanker"} or {"flags":"NO,RU"}.)',
    '  * Filter vessels by ship type -> {"actions":[{"tool":"filter_vessels_by_type","args":{"types":"Cargo,Tanker"}}]} (use for "show only cargo and tanker ships").',
    '  * Count vessels in a region -> {"actions":[{"tool":"vessel_count_in_region","args":{"bounds":[5,65,40,75]}}]} (bounds are [minLon,minLat,maxLon,maxLat]).',
    '  * Vessels in heavy ice -> {"actions":[{"tool":"show_vessels_in_high_ice","args":{"threshold":80}}]} (threshold is percent 0-100; optional date YYYYMMDD).',
    '  * Show track of a vessel -> {"actions":[{"tool":"show_vessel_track","args":{"mmsi":"259390000","hours":24}}]} or by name {"actions":[{"tool":"show_vessel_track","args":{"name":"TROMS SIRIUS"}}]}.',
    '  * Difference -> {"actions":[{"tool":"calculate_layer_difference","args":{"layer_a":"Precipitation Rate","layer_b":"Vegetation Index"}}]}',
    '  * Export animation -> {"actions":[{"tool":"open_animation_tool","args":{"layer_name":"SIC forecast","start_date":"2024-01-01","end_date":"2024-12-31","region":"Beaufort Sea","format":"gif"}}]}',
    '  * Run chart analysis -> {"actions":[{"tool":"run_analysis","args":{"layer_name":"<layer name>","chart_type":"timeseries","start_date":"2024-01-01","end_date":"2024-12-31"}}]}',
    "Examples:",
    'User: "Please list layers."\nAssistant: {"actions":[{"tool":"list_layers","args":{}}]}',
    'User: "Turn off all layers."\nAssistant: {"actions":[{"tool":"toggle_layer","args":{"name":"Areas of Interest","visible":false}},{"tool":"toggle_layer","args":{"name":"Primary Layer","visible":false}}],"reply":"Turning off all visible layers."}',
    'User: "Calculate mean for [Layer A]"\nAssistant: {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"[Layer A]","geographical_area":"current view"}}],"reply":"Calculating statistics for [Layer A] in the current view."}',
    'User: "Show statistics for Snow Depth"\nAssistant: {"actions":[{"tool":"calculate_layer_mean","args":{"layer_name":"Snow Depth Over Ice","geographical_area":"current view"}}],"reply":"Computing statistics for Snow Depth Over Ice layer."}',
    'User: "What is the current time setting?"\nAssistant: {"actions":[],"reply":"Based on the visible layers, the current temporal setting shows data from [examine layer catalog for actual time ranges of the visible layers]."}',
    'User: "Explain what this layer shows"\nAssistant: {"actions":[{"tool":"layer_information","args":{"layer_name":"[first visible layer]"}},{"tool":"layer_information","args":{"layer_name":"[second visible layer]"}}],"reply":"I\'ll explain the currently visible layers."}',
    'User: "What does this show?"\nAssistant: {"actions":[{"tool":"layer_information","args":{"layer_name":"[first visible layer]"}}],"reply":"Let me look up the currently visible layer."}',
    'User: "What is MMGIS?"\nAssistant: {"actions":[],"reply":"<short grounded answer>","citations":[{"title":"MMGIS GitHub Repository","url":"https://github.com/NASA-AMMOS/MMGIS"}]}',
    'User: "Generate a weekly animation of SIC forecast for the last 7 days in the Beaufort Sea"\nAssistant: {"actions":[{"tool":"zoom_to","args":{"bbox":[-160,70,-120,76]}},{"tool":"set_time","args":{"time":"past week"}},{"tool":"open_animation_tool","args":{"layer_name":"SIC forecast","region":"Beaufort Sea","format":"gif"}}],"reply":"I\'ve zoomed to the Beaufort Sea, set the time to the past week, and opened the Animation Tool for SIC forecast. Draw a bounding box and click Export GIF."}',
    'User: "Show me a time-series analysis of [Layer A] from January to June 2024"\nAssistant: {"actions":[{"tool":"toggle_layer","args":{"name":"[Layer A]","visible":true}},{"tool":"run_analysis","args":{"layer_name":"[Layer A]","chart_type":"timeseries","start_date":"2024-01-01","end_date":"2024-06-30"}}],"reply":"Opening the Analysis Tool with a time-series chart for [Layer A] from January to June 2024. Draw a bounding box to define your region of interest, then click Generate Analysis."}',
    'User: "Compare SIC prediction vs observed backscatter and animate the difference"\nAssistant: {"actions":[{"tool":"calculate_layer_difference","args":{"layer_a":"SIC prediction","layer_b":"observed backscatter"}},{"tool":"open_animation_tool","args":{"layer_name":"SIC difference","format":"gif"}}],"reply":"Computing the difference between SIC prediction and observed backscatter, then opening Animation Tool to export the result as a GIF."}',
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

function parseAgentPlan(rawAssistantText) {
  const trimmed =
    typeof rawAssistantText === "string" ? rawAssistantText.trim() : "";
  if (!trimmed) {
    throw new Error("Azure Agent Service returned an empty response.");
  }
  const jsonCandidate =
    trimmed.match(/^\s*\{[\s\S]*\}\s*$/m)?.[0] ||
    trimmed.match(/\{[\s\S]*?\}/m)?.[0] ||
    trimmed;
  try {
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
    return { tool: action.tool, args: action.args || {} };
  });
}

function normalizeCitations(citations) {
  if (!Array.isArray(citations)) return [];
  const normalized = [];
  const seen = new Set();
  for (const entry of citations) {
    const value =
      typeof entry === "string" ? { title: entry, url: entry } : entry;
    if (
      value &&
      typeof value.title === "string" &&
      value.title &&
      typeof value.url === "string" &&
      value.url
    ) {
      if (!seen.has(value.url)) {
        seen.add(value.url);
        normalized.push({ title: value.title, url: value.url });
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

async function planWithProvider(message, context = {}, { threadId, registry, toolNames } = {}) {
  const toolOptions = { registry, toolNames };
  const prompt = buildPrompt(message, context, toolOptions);
  const resolved = resolveToolInfo(toolOptions);

  let rawAssistantText;

  if (haveAzureEnv().ok) {
    // ── Azure AI Foundry ──────────────────────────────────────────────────────
    try {
      const azure = await runAgentMessage(prompt, {
        threadId,
        // Always keep; routes persist azureThreadId for multi-turn, and
        // DELETE /conversations/:id cleans up the Azure conversation.
        keepThread: true,
      });
      const assistantMessage = azure?.message;
      if (!assistantMessage) {
        throw new Error(
          "Azure Agent Service response did not include an assistant message.",
        );
      }
      rawAssistantText = extractAssistantText(assistantMessage);
      if (!rawAssistantText || !rawAssistantText.trim()) {
        throw new Error("Azure Agent Service returned an empty response.");
      }

      const plan = parseAgentPlan(rawAssistantText);
      const actions = normalizeActions(plan.actions, toolOptions);
      let reply =
        typeof plan.reply === "string" && plan.reply.trim().length > 0
          ? plan.reply.trim()
          : rawAssistantText.trim();
      const citations = normalizeCitations(plan.citations);
      const usedFallback = actions.length === 0 && (!reply || reply.length === 0);
      if (usedFallback) reply = fallbackMessage(toolOptions);

      return {
        actions,
        reply,
        citations,
        provider: "azure",
        threadId: azure?.threadId || null,
        debug: {
          request: { toolCount: resolved.toolNames.size },
          response: { status: 200 },
          message: rawAssistantText,
          run: azure?.run ? { id: azure.run.id, status: azure.run.status } : undefined,
          fallbackApplied: usedFallback,
        },
      };
    } catch (azureError) {
      if (!process.env.GEMINI_API_KEY) throw azureError;
      console.warn(
        `[provider] Azure failed, falling back to Gemini: ${azureError.message}`,
      );
    }
  }

  if (process.env.GEMINI_API_KEY) {
    // ── Google Gemini ─────────────────────────────────────────────────────────
    const { text } = await gemini.generateContent(prompt);
    rawAssistantText = text;

    const plan = parseAgentPlan(rawAssistantText);
    const actions = normalizeActions(plan.actions, toolOptions);
    let reply =
      typeof plan.reply === "string" && plan.reply.trim().length > 0
        ? plan.reply.trim()
        : rawAssistantText.trim();
    const citations = normalizeCitations(plan.citations);
    const usedFallback = actions.length === 0 && (!reply || reply.length === 0);
    if (usedFallback) reply = fallbackMessage(toolOptions);

    return {
      actions,
      reply,
      citations,
      provider: "gemini",
      threadId: null,
      debug: {
        request: { toolCount: resolved.toolNames.size },
        response: { status: 200 },
        message: rawAssistantText,
        fallbackApplied: usedFallback,
      },
    };

  } else {
    throw new Error(
      "No LLM provider configured. Set Azure env vars (PROJECT_ENDPOINT, AGENT_NAME, AGENT_VERSION) or GEMINI_API_KEY.",
    );
  }
}

function listProviderTools() {
  const reg = loadRegistry();
  return (reg.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || t.name,
      parameters: t.modelParameters ||
        t.parameters || { type: "object", additionalProperties: false },
    },
  }));
}

async function* streamWithProvider(message, context = {}, { threadId, registry, toolNames } = {}) {
  const toolOptions = { registry, toolNames };
  const prompt = buildPrompt(message, context, toolOptions);

  if (haveAzureEnv().ok) {
    // ── Azure AI Foundry (streaming) ──────────────────────────────────────────
    let fullText = "";
    let resolvedThreadId = null;

    for await (const event of streamAgentMessage(prompt, {
      threadId,
      keepThread: true,
    })) {
      if (!resolvedThreadId && event._threadId) {
        resolvedThreadId = event._threadId;
      }

      // New @azure/ai-projects Responses stream events
      if (event.type === "response.output_text.delta") {
        const delta = typeof event.delta === "string" ? event.delta : "";
        if (delta) {
          fullText += delta;
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
          try {
            const plan = parseAgentPlan(fullText);
            const actions = normalizeActions(plan.actions, toolOptions);
            const reply =
              typeof plan.reply === "string" && plan.reply.trim().length > 0
                ? plan.reply.trim()
                : fullText.trim();
            const citations = normalizeCitations(plan.citations);
            yield {
              type: "plan",
              data: {
                actions,
                reply,
                citations,
                threadId: resolvedThreadId,
                provider: "azure",
              },
            };
          } catch (_) {
            yield {
              type: "plan",
              data: {
                actions: [],
                reply: fullText.trim(),
                citations: [],
                threadId: resolvedThreadId,
                provider: "azure",
              },
            };
          }
        }
      } else if (
        event.type === "response.failed" ||
        event.type === "error"
      ) {
        const reason =
          event.error?.message ||
          event.response?.error?.message ||
          "Agent run failed during streaming.";
        yield { type: "error", data: reason };
      }
    }

    yield { type: "done", data: { threadId: resolvedThreadId } };

  } else if (process.env.GEMINI_API_KEY) {
    // ── Google Gemini (streaming) ─────────────────────────────────────────────
    let fullText = "";

    for await (const chunk of gemini.streamContent(prompt)) {
      fullText += chunk;
      yield { type: "token", data: chunk };
    }

    try {
      const plan = parseAgentPlan(fullText);
      const actions = normalizeActions(plan.actions, toolOptions);
      const reply =
        typeof plan.reply === "string" && plan.reply.trim().length > 0
          ? plan.reply.trim()
          : fullText.trim();
      const citations = normalizeCitations(plan.citations);
      yield {
        type: "plan",
        data: { actions, reply, citations, threadId: null, provider: "gemini" },
      };
    } catch (_) {
      yield {
        type: "plan",
        data: { actions: [], reply: fullText.trim(), citations: [], threadId: null, provider: "gemini" },
      };
    }

    yield { type: "done", data: { threadId: null } };

  } else {
    throw new Error(
      "No LLM provider configured. Set Azure env vars (PROJECT_ENDPOINT, AGENT_NAME, AGENT_VERSION) or GEMINI_API_KEY.",
    );
  }
}

module.exports = { planWithProvider, streamWithProvider, haveAzureEnv, listProviderTools };
