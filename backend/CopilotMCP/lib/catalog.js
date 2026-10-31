// The Copilot MCP tool catalog: the Copilot registry tools (executed in a live
// browser session), the Copilot backend operations (executed on the server
// through the Agent plugin's HTTP API with the caller's credentials) and the
// browser-session tools.

const { CopilotMcpError, ERROR_CODES, toolSuccess, toolError, sanitize } = require("./results");
const {
  getRegistry,
  withRoutingProperties,
  splitRouting,
  validateRegistryArgs,
  formatAjvErrors,
  ROUTING_PROPERTIES,
} = require("./registry");
const { describeTool, annotationsFor, executionSpec, timeoutFor, browserResult } = require("./browserTools");
const { buildQuery } = require("./loopback");

const BBOX_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 4,
  maxItems: 4,
  description: "[lon_min, lat_min, lon_max, lat_max] in WGS84 degrees",
};

const mission = { type: "string", minLength: 1, maxLength: 256, description: "Mission name." };
const missionOptional = { ...mission, description: "Mission name. Optional when a single browser session is connected." };

function obj(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, required };
}

function upstreamError(label, res) {
  const body = res.json || {};
  const message = body.error || body.message || `${label} failed with HTTP ${res.status}`;
  return new CopilotMcpError(ERROR_CODES.UPSTREAM_ERROR, `${label}: ${message}`, {
    http_status: res.status,
    ...(body.code ? { code: body.code } : {}),
    ...(body.details ? { details: body.details } : {}),
    ...(body.layer_name ? { layer_name: body.layer_name } : {}),
  });
}

function createCatalog(ctx) {
  const { app, cfg, sessions, loopback, missionAccess } = ctx;
  const serverValidators = new Map();

  function compileServerSchema(name, schema) {
    if (serverValidators.has(name)) return serverValidators.get(name);
    const registry = getRegistry(app);
    let ajv = registry.ajv;
    if (!ajv) {
      const Ajv = require("ajv");
      ajv = new Ajv({ allErrors: true, coerceTypes: true, useDefaults: true });
    }
    const validate = ajv.compile(schema);
    serverValidators.set(name, validate);
    return validate;
  }

  function validateServerArgs(def, args) {
    const validate = compileServerSchema(def.name, def.inputSchema);
    const copy = JSON.parse(JSON.stringify(args || {}));
    if (!validate(copy)) {
      throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, `Invalid arguments for ${def.name}.`, { errors: formatAjvErrors(validate.errors) });
    }
    return copy;
  }

  async function agentGet(caller, path, label) {
    const res = await loopback.request("GET", path, { caller });
    if (res.json && res.json.status === "failure") throw upstreamError(label, res);
    if (!res.ok) throw upstreamError(label, res);
    if (!res.json) throw new CopilotMcpError(ERROR_CODES.UPSTREAM_ERROR, `${label} returned a non-JSON response (HTTP ${res.status}).`);
    return res.json;
  }

  function requireCopilotBackend() {
    const registry = getRegistry(app);
    if (!registry.available) {
      throw new CopilotMcpError(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        "The MMGIS Copilot Agent backend plugin is not running (WITH_AGENT must be 'true' and the Agent plugin enabled)."
      );
    }
    return registry;
  }

  // ——— Browser sessions ———————————————————————————————————————————————

  async function resolveSession(caller, routing, { required = true } = {}) {
    try {
      const session = sessions.select({ owner: caller.username, mission: routing.mission, sessionId: routing.sessionId });
      await missionAccess.assertCanView(caller, session.mission);
      return session;
    } catch (err) {
      if (!required && err.code === ERROR_CODES.NO_BROWSER_SESSION) return null;
      throw err;
    }
  }

  async function dispatchToBrowser(session, command, timeoutMs) {
    return sessions.dispatch(session, command, {
      deliveryTimeoutMs: cfg.deliveryTimeoutMs,
      resultTimeoutMs: timeoutMs || cfg.resultTimeoutMs,
    });
  }

  // userQuery: the natural-language request the action was planned from (as
  // the chat passes it to layer resolution); empty for direct tool calls.
  async function runRegistryAction(caller, registry, toolName, args, session, userQuery = "") {
    const spec = registry.tools.find((t) => t.name === toolName);
    if (!spec) throw new CopilotMcpError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `Copilot tool '${toolName}' is not in the active registry.`);
    const payload = await dispatchToBrowser(
      session,
      { kind: "copilot_action", tool: toolName, args, spec: executionSpec(spec), user_query: userQuery },
      timeoutFor(toolName, cfg)
    );
    return browserResult({ tool: toolName, session, payload });
  }

  // ——— Server tool definitions ————————————————————————————————————————

  const serverTools = [
    {
      name: "copilot_ask",
      description:
        "Send a natural-language request to the MMGIS Copilot, exactly like the Copilot chat: 'undo last' and local fast-path commands (MMGIS overview, preset region zoom, time slider) run in the browser session, otherwise the Copilot planner (LLM) plans registry actions which are then executed in the session. execute=false returns the plan only. Requires an LLM provider configured for the Agent plugin unless a local command handles the request.",
      inputSchema: obj(
        {
          message: { type: "string", minLength: 1, maxLength: 2000, description: "The request, as typed into the Copilot chat." },
          mission: missionOptional,
          session_id: ROUTING_PROPERTIES.session_id,
          conversation_id: { type: "string", maxLength: 64, description: "Continue an existing Copilot conversation." },
          execute: { type: "boolean", default: true, description: "Execute in the browser session (default true). false = plan only." },
        },
        ["message"]
      ),
      annotations: { title: "Ask the MMGIS Copilot", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      handler: async (args, caller) => {
        const routing = { mission: args.mission || null, sessionId: args.session_id || null };
        const session = await resolveSession(caller, routing, { required: args.execute || !!routing.sessionId });
        const missionName = routing.mission || (session && session.mission);
        if (!missionName) throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, "mission is required when no browser session is connected.");
        await missionAccess.assertCanView(caller, missionName);
        const registry = requireCopilotBackend();

        if (args.execute && /^undo\s+last$/i.test(args.message.trim())) {
          const payload = await dispatchToBrowser(session, { kind: "undo" });
          return browserResult({ tool: "copilot_ask", session, payload });
        }
        if (args.execute) {
          const local = await dispatchToBrowser(session, { kind: "local_command", message: args.message });
          if (local.handled) {
            return toolSuccess(
              {
                status: "succeeded",
                handled_locally: true,
                reply: local.reply,
                mission: session.mission,
                session_id: session.id,
                effects: local.effects || null,
                state: local.state || null,
              },
              "Handled by the Copilot's local command path (no LLM call)."
            );
          }
        }
        let context = null;
        if (session) {
          const ctxPayload = await dispatchToBrowser(session, { kind: "agent_context" });
          context = ctxPayload.context || null;
        }
        const res = await loopback.request("POST", `/api/agent${buildQuery({ mission: missionName })}`, {
          caller,
          body: { message: args.message, context, conversationId: args.conversation_id || undefined },
        });
        if (!res.ok || !res.json || res.json.status === "failure") {
          const err = upstreamError("Copilot planner", res);
          if (res.status >= 500) err.message += " (check the Agent plugin's LLM provider configuration: PROJECT_ENDPOINT/AGENT_NAME/AGENT_VERSION or GEMINI_API_KEY)";
          throw err;
        }
        const plan = res.json;
        const results = [];
        if (args.execute) {
          for (const action of plan.actions || []) {
            let result;
            try {
              result = await runRegistryAction(caller, registry, action.tool, action.args || {}, session, args.message);
            } catch (err) {
              result = toolError(err, { tool: action.tool });
            }
            results.push({ tool: action.tool, args: action.args, is_error: !!result.isError, result: result.structuredContent });
          }
        }
        const failed = results.filter((r) => r.is_error).length;
        return toolSuccess(
          {
            status: failed ? "partially_failed" : "succeeded",
            handled_locally: false,
            mission: missionName,
            session_id: session ? session.id : null,
            reply: plan.reply || "",
            text: plan.text || "",
            citations: plan.citations || [],
            actions: plan.actions || [],
            conversation_id: plan.conversationId || null,
            executed: !!args.execute,
            results,
          },
          `Copilot planned ${(plan.actions || []).length} action(s)${args.execute ? `; executed ${results.length}, failed ${failed}` : " (not executed)"}.`
        );
      },
    },
    {
      name: "copilot_tool_registry",
      description: "List the MMGIS Copilot tool registry served by the Agent backend (GET /api/agent/tools): tool names, descriptions, execution adapters and parameter schemas.",
      inputSchema: obj({}),
      annotations: { title: "Copilot tool registry", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, caller) => {
        requireCopilotBackend();
        const body = await agentGet(caller, "/api/agent/tools", "Copilot tool registry");
        const tools = (body.tools || []).map((t) => ({
          name: t.name,
          description: t.description,
          adapter: t.execution && t.execution.adapter,
          ui_type: t.execution && t.execution.ui && t.execution.ui.type,
          parameters: t.parameters,
        }));
        return toolSuccess({ status: "succeeded", count: tools.length, tools }, `${tools.length} Copilot tools registered.`);
      },
    },
    {
      name: "copilot_demo_queries",
      description: "Return the Copilot's configured example (demo) queries (GET /api/agent/copilot/demo-queries).",
      inputSchema: obj({}),
      annotations: { title: "Copilot example queries", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (_args, caller) => {
        requireCopilotBackend();
        const body = await agentGet(caller, "/api/agent/copilot/demo-queries", "Copilot demo queries");
        return toolSuccess({ status: "succeeded", queries: body.queries || [] });
      },
    },
    {
      name: "copilot_conversations",
      description: "List, read or delete persisted Copilot conversations (GET/DELETE /api/agent/conversations). list needs mission; get/delete need conversation_id and are limited to missions the caller may view.",
      inputSchema: obj(
        {
          action: { type: "string", enum: ["list", "get", "delete"] },
          mission,
          conversation_id: { type: "string", minLength: 1, maxLength: 64 },
        },
        ["action"]
      ),
      annotations: { title: "Copilot conversations", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        if (args.action === "list") {
          if (!args.mission) throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, "mission is required for action 'list'.");
          await missionAccess.assertCanView(caller, args.mission);
          const body = await agentGet(caller, `/api/agent/conversations${buildQuery({ mission: args.mission })}`, "Copilot conversations");
          return toolSuccess({ status: "succeeded", mission: args.mission, conversations: body.conversations || [] });
        }
        if (!args.conversation_id) throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, `conversation_id is required for action '${args.action}'.`);
        const id = encodeURIComponent(args.conversation_id);
        const conversation = await agentGet(caller, `/api/agent/conversations/${id}`, "Copilot conversation");
        await missionAccess.assertCanView(caller, conversation.missionName);
        if (args.action === "get") return toolSuccess({ status: "succeeded", conversation });
        const res = await loopback.request("DELETE", `/api/agent/conversations/${id}`, { caller });
        if (!res.ok || !res.json) throw upstreamError("Delete Copilot conversation", res);
        return toolSuccess({ status: "succeeded", deleted: !!res.json.deleted, conversation_id: args.conversation_id });
      },
    },
    {
      name: "copilot_layer_info",
      description: "Layer reference information from the Copilot backend (GET /api/agent/layer-info): summaries and citations for a mission's layers, optionally best match for name. Note: the Agent reads Missions/<mission>/config.json and reports LayerInfoUnavailable for database-only missions.",
      inputSchema: obj({ mission, name: { type: "string", minLength: 1, maxLength: 256 } }, ["mission"]),
      annotations: { title: "Copilot layer info", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        await missionAccess.assertCanView(caller, args.mission);
        const body = await agentGet(caller, `/api/agent/layer-info${buildQuery({ mission: args.mission, name: args.name })}`, "Copilot layer info");
        return toolSuccess({ status: "succeeded", mission: args.mission, ...body });
      },
    },
    {
      name: "copilot_resolve_region",
      description: "Resolve a geographic place or sea name to a bounding box with the Copilot's region resolver (GET /api/agent/regions/resolve; uses MarineRegions.org and built-in regions).",
      inputSchema: obj(
        {
          name: { type: "string", minLength: 1, maxLength: 256 },
          buffer_km: { type: "number", exclusiveMinimum: 0, maximum: 5000 },
        },
        ["name"]
      ),
      annotations: { title: "Resolve region", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      handler: async (args, caller) => {
        requireCopilotBackend();
        const body = await agentGet(caller, `/api/agent/regions/resolve${buildQuery({ name: args.name, buffer_km: args.buffer_km })}`, "Region resolver");
        return toolSuccess({ status: "succeeded", ...body });
      },
    },
    {
      name: "copilot_analytics_layers",
      description: "List a mission's layers as the Copilot analytics backend sees them (GET /api/agent/analytics/layers): names, aliases and data sources.",
      inputSchema: obj({ mission }, ["mission"]),
      annotations: { title: "Analytics layer catalog", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        await missionAccess.assertCanView(caller, args.mission);
        const body = await agentGet(caller, `/api/agent/analytics/layers${buildQuery({ mission: args.mission })}`, "Analytics layers");
        return toolSuccess({ status: "succeeded", mission: args.mission, count: (body.layers || []).length, layers: body.layers || [] });
      },
    },
    {
      name: "copilot_raster_statistics",
      description: "Compute raster statistics (mean, std, min, max, quartiles, valid/nodata counts) for a mission layer's local COG/GeoTIFF on the server, via the Copilot analytics endpoint (GET /api/agent/analytics/statistics, rasterio). Optional bbox or region name. No browser session needed.",
      inputSchema: obj(
        {
          mission,
          layer_name: { type: "string", minLength: 1, maxLength: 256 },
          bbox: BBOX_SCHEMA,
          region: { type: "string", minLength: 1, maxLength: 256, description: "Region name resolved with copilot_resolve_region (ignored when bbox is given)." },
        },
        ["mission", "layer_name"]
      ),
      annotations: { title: "Raster statistics", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        await missionAccess.assertCanView(caller, args.mission);
        let bbox = args.bbox || null;
        let region = null;
        if (!bbox && args.region) {
          region = await agentGet(caller, `/api/agent/regions/resolve${buildQuery({ name: args.region })}`, "Region resolver");
          bbox = region.bbox;
        }
        const q = { mission: args.mission, layer_name: args.layer_name };
        if (Array.isArray(bbox)) Object.assign(q, { lon_min: bbox[0], lat_min: bbox[1], lon_max: bbox[2], lat_max: bbox[3] });
        const body = await agentGet(caller, `/api/agent/analytics/statistics${buildQuery(q)}`, "Raster statistics");
        return toolSuccess({ status: "succeeded", mission: args.mission, region: region ? { label: region.label, bbox: region.bbox } : null, statistics: body });
      },
    },
    {
      name: "copilot_raster_difference",
      description: "Compute pixel-by-pixel difference statistics (layer_a minus layer_b) for two mission rasters on the server via the Copilot analytics endpoint (GET /api/agent/analytics/difference). Optional time and bbox. No browser session needed.",
      inputSchema: obj(
        {
          mission,
          layer_a: { type: "string", minLength: 1, maxLength: 256 },
          layer_b: { type: "string", minLength: 1, maxLength: 256 },
          time: { type: "string", maxLength: 32, description: "ISO time used to pick time-specific files of STAC collections." },
          bbox: BBOX_SCHEMA,
        },
        ["mission", "layer_a", "layer_b"]
      ),
      annotations: { title: "Raster difference", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        await missionAccess.assertCanView(caller, args.mission);
        const q = { mission: args.mission, layer_a: args.layer_a, layer_b: args.layer_b, time: args.time };
        if (Array.isArray(args.bbox)) Object.assign(q, { lon_min: args.bbox[0], lat_min: args.bbox[1], lon_max: args.bbox[2], lat_max: args.bbox[3] });
        const body = await agentGet(caller, `/api/agent/analytics/difference${buildQuery(q)}`, "Raster difference");
        return toolSuccess({ status: "succeeded", mission: args.mission, difference: body });
      },
    },
    {
      name: "copilot_resolve_cog",
      description: "Resolve a mission layer (or STAC collection) to the Missions-relative COG path TiTiler serves (GET /api/agent/analytics/resolve-cog).",
      inputSchema: obj({ mission, layer_name: { type: "string", minLength: 1, maxLength: 256 } }, ["mission", "layer_name"]),
      annotations: { title: "Resolve COG", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        requireCopilotBackend();
        await missionAccess.assertCanView(caller, args.mission);
        const body = await agentGet(caller, `/api/agent/analytics/resolve-cog${buildQuery({ mission: args.mission, layer_name: args.layer_name })}`, "Resolve COG");
        return toolSuccess({ status: "succeeded", ...body });
      },
    },
    {
      name: "mmgis_list_sessions",
      description: "List this user's MMGIS browser sessions connected through the CopilotMCPBridge (session_id, mission, connection state) and the missions the user may view.",
      inputSchema: obj({ mission }),
      annotations: { title: "List browser sessions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        const missions = await missionAccess.viewableMissions(caller);
        const list = sessions.list({ owner: caller.username, mission: args.mission || null }).filter((s) => missions.includes(s.mission));
        return toolSuccess({
          status: "succeeded",
          user: caller.username,
          copilot_backend: getRegistry(app).available ? "available" : "unavailable",
          viewable_missions: missions,
          sessions: list,
        });
      },
    },
    {
      name: "mmgis_get_map_state",
      description: "Read the current state of an MMGIS browser session: mission, map center/zoom/bounds, every layer's visibility/opacity/time window, the global time window, Copilot highlight overlays and active tools.",
      inputSchema: obj({ mission: missionOptional, session_id: ROUTING_PROPERTIES.session_id }),
      annotations: { title: "Get map state", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      handler: async (args, caller) => {
        const session = await resolveSession(caller, { mission: args.mission || null, sessionId: args.session_id || null });
        const payload = await dispatchToBrowser(session, { kind: "get_state" });
        return browserResult({ tool: "mmgis_get_map_state", session, payload });
      },
    },
    {
      name: "mmgis_undo_last_action",
      description: "Undo the last layer visibility toggle or map zoom made through MCP in a browser session (same semantics as the Copilot chat's 'undo last': up to 25 entries, toggles and zoom_to only), and confirm the restored state.",
      inputSchema: obj({ mission: missionOptional, session_id: ROUTING_PROPERTIES.session_id }),
      annotations: { title: "Undo last action", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      handler: async (args, caller) => {
        const session = await resolveSession(caller, { mission: args.mission || null, sessionId: args.session_id || null });
        const payload = await dispatchToBrowser(session, { kind: "undo" });
        return browserResult({ tool: "mmgis_undo_last_action", session, payload });
      },
    },
  ];

  const serverByName = new Map(serverTools.map((t) => [t.name, t]));

  function list() {
    const registry = getRegistry(app);
    const copilot = registry.tools
      .filter((t) => t && typeof t.name === "string" && !serverByName.has(t.name))
      .map((spec) => ({
        name: spec.name,
        description: describeTool(spec),
        inputSchema: withRoutingProperties(spec.parameters),
        annotations: annotationsFor(spec),
      }));
    const server = serverTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));
    return [...copilot, ...server];
  }

  function has(name) {
    return serverByName.has(name) || getRegistry(app).tools.some((t) => t.name === name);
  }

  async function call(name, rawArgs, caller) {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    try {
      const def = serverByName.get(name);
      if (def) return await def.handler(validateServerArgs(def, args), caller);

      const registry = getRegistry(app);
      if (!registry.tools.some((t) => t.name === name)) {
        throw new CopilotMcpError(ERROR_CODES.CAPABILITY_UNAVAILABLE, `Unknown tool '${name}'.`);
      }
      requireCopilotBackend();
      const { routing, toolArgs } = splitRouting(args);
      const checked = validateRegistryArgs(registry, name, toolArgs);
      if (!checked.valid) {
        throw new CopilotMcpError(ERROR_CODES.INVALID_INPUT, `${name} args invalid (same validation as the Copilot planner).`, { errors: checked.errors });
      }
      const session = await resolveSession(caller, routing);
      return await runRegistryAction(caller, registry, name, checked.args, session);
    } catch (err) {
      if (!(err instanceof CopilotMcpError)) {
        return toolError(new CopilotMcpError(ERROR_CODES.EXECUTION_FAILED, err && err.message ? err.message : String(err)), { tool: name });
      }
      return toolError(err, { tool: name, args: sanitize(args) });
    }
  }

  return { list, has, call };
}

module.exports = { createCatalog };
