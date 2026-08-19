import { test, expect } from '@playwright/test';
import {
  parseAgentPlan,
  normalizeTextPlan,
  normalizeCitations,
  resolveProviderSelection,
  buildProviderTools,
  buildAzureInstructions,
  inferToolCategory,
  normalizeStreamingCompletion,
  streamWithProvider,
  runAzureWithToolFallback,
  continueAzureWithToolFallback,
  normalizeUserReplyLineBreaks,
} from '../provider';

test.describe('@unit Agent provider reply normalization', () => {
  test('decodes only double-escaped reply line breaks across backend JSON serialization', () => {
    const normalized = normalizeTextPlan(
      JSON.stringify({
        actions: [
          {
            tool: 'toggle_layer',
            args: { name: 'literal\\nlayer', visible: true },
          },
        ],
        reply:
          'Available data layers:\\n- Ice Forecast\\r\\n- Ground Truth',
      }),
    );
    const frontendVisible = JSON.parse(
      JSON.stringify({
        reply: normalized.reply,
        actions: normalized.actions,
      }),
    );

    expect(frontendVisible.reply).toBe(
      'Available data layers:\n- Ice Forecast\n- Ground Truth',
    );
    expect(frontendVisible.reply).not.toContain('\\n');
    expect(frontendVisible.actions[0].args.name).toBe(
      'literal\\nlayer',
    );
  });

  test('does not double-unescape literal slash pairs, other escapes, or code', () => {
    const tick = String.fromCharCode(96);
    const value =
      'Line one\\nLine two; literal pair \\\\n; tab \\t; code ' +
      tick +
      'C:\\new\\report' +
      tick;
    expect(normalizeUserReplyLineBreaks(value)).toBe(
      'Line one\nLine two; literal pair \\\\n; tab \\t; code ' +
        tick +
        'C:\\new\\report' +
        tick,
    );
  });

});

test.describe('@unit Agent provider structured parsing and selection', () => {
  test('parses nested plans, prose prefixes, fences, and braces inside strings', () => {
    const nested = parseAgentPlan(
      'Plan follows: {"actions":[{"tool":"zoom_to","args":{"center":[-140,72],"meta":{"label":"brace } text"}}}],"reply":"Ready."}',
    );
    expect(nested.actions[0].args.meta.label).toBe('brace } text');
    const fenced = parseAgentPlan(
      '~~~'.replaceAll('~', String.fromCharCode(96)) +
        'json\n{"actions":[],"reply":"MMGIS info"}\n' +
        '~~~'.replaceAll('~', String.fromCharCode(96)),
    );
    expect(fenced.reply).toBe('MMGIS info');
  });

  test('rejects malformed JSON-looking output and trailing data', () => {
    expect(() =>
      normalizeTextPlan('{"actions":[}', undefined, {
        allowPlainText: true,
      }),
    ).toThrow();
    expect(() =>
      parseAgentPlan('{"actions":[]} unexpected trailing data'),
    ).toThrow(/complete JSON object/i);
  });

  test('accepts a plain non-tool informational answer without blanking it', () => {
    const result = normalizeTextPlan(
      'MMGIS is a web-based geospatial mission operations platform.',
      undefined,
      { allowPlainText: true },
    );
    expect(result.actions).toEqual([]);
    expect(result.reply).toMatch(/MMGIS/);
  });

  test('honors explicit provider selection and uses auto only when unset', () => {
    expect(
      resolveProviderSelection({
        LLM_PROVIDER: 'gemini',
        PROJECT_ENDPOINT: 'azure',
        AGENT_NAME: 'agent',
        AGENT_VERSION: '1',
      }),
    ).toEqual({ provider: 'gemini', automatic: false });
    expect(
      resolveProviderSelection({
        PROJECT_ENDPOINT: 'azure',
        AGENT_NAME: 'agent',
        AGENT_VERSION: '1',
        GEMINI_API_KEY: 'gemini',
      }),
    ).toEqual({ provider: 'azure', automatic: true });
    expect(() =>
      resolveProviderSelection({ LLM_PROVIDER: 'unknown' }),
    ).toThrow(/azure.*gemini/i);
  });

  test('categorizes analytical layer tools before generic layer controls', () => {
    expect(inferToolCategory('calculate_layer_mean')).toBe('analytics');
    expect(inferToolCategory('calculate_layer_difference')).toBe('analytics');
    expect(inferToolCategory('list_analyzable_layers')).toBe('analytics');
    expect(inferToolCategory('set_layer_opacity')).toBe(
      'layers-visualization',
    );
  });

  test('builds Responses-format tools with one authoritative schema and total budget', () => {
    const registry = {
      tools: Array.from({ length: 80 }, (_, index) => ({
        name: `plugin__tool_${index}`,
        description: 'x'.repeat(100),
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { value: { type: 'string' } },
        },
        modelParameters: { type: 'string' },
      })),
    };
    const built = buildProviderTools(registry);
    expect(built.tools).toHaveLength(64);
    expect(built.omittedCount).toBe(16);
    expect(built.tools[0]).toEqual({
      type: 'function',
      name: 'plugin__tool_0',
      description: 'x'.repeat(100),
      parameters: registry.tools[0].parameters,
      strict: false,
    });
  });

  test('uses the supported published-agent request contract and keeps the full plan prompt in one user turn', async () => {
    const calls = [];
    const result = await runAzureWithToolFallback(
      'What is MMGIS?',
      {
        compatibilityPrompt:
          'System policy.\nAvailable tools:\n- list_layers\nUser request: What is MMGIS?',
        instructions: 'request-scoped instructions are forbidden here',
        keepThread: true,
      },
      buildProviderTools({
        tools: [
          {
            name: 'list_layers',
            description: 'List layers.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      }),
      async (message, options) => {
        calls.push({ message, options });
        return {
          responseId: 'resp_info',
          message: {
            text: 'MMGIS is a web-based geospatial mission operations platform.',
          },
          actions: [],
        };
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('What is MMGIS?');
    expect(calls[0].options.instructions).toBeUndefined();
    expect(calls[0].options.tools).toEqual([]);
    expect(calls[0].options.conversationMessage).toContain('Available tools:');
    expect(calls[0].options.conversationMessage).toContain(
      'User request: What is MMGIS?',
    );
    expect(result.capabilityMode).toBe('prompt-json-published-agent');
    expect(result.result.responseId).toBe('resp_info');
  });

  test('uses the supported minimal published-agent continuation contract', async () => {
    const calls = [];
    const toolResults = [
      {
        tool: 'list_layers',
        callId: 'call_layers',
        ok: true,
        data: { layers: [] },
      },
    ];
    const result = await continueAzureWithToolFallback(
      toolResults,
      {
        responseId: 'resp_previous',
        instructions: 'request-scoped instructions are forbidden here',
      },
      buildProviderTools({ tools: [] }),
      async (results, options) => {
        calls.push({ results, options });
        return { responseId: 'resp_final', message: { text: 'No layers.' } };
      },
    );

    expect(calls).toEqual([
      {
        results: toolResults,
        options: {
          responseId: 'resp_previous',
          instructions: undefined,
          tools: [],
        },
      },
    ]);
    expect(result.capabilityMode).toBe('published-agent-continuation');
    expect(result.result.responseId).toBe('resp_final');
  });

  test('places server policy/context in Azure instructions without a user request', () => {
    const instructions = buildAzureInstructions(
      {
        layerHints: [
          {
            display_name: 'Visible Scalar',
            visible: true,
            analyzable: true,
            type: 'data',
          },
          {
            display_name: 'Hidden Scalar',
            visible: false,
            analyzable: true,
            type: 'data',
          },
        ],
        runtime: {
          map: {
            center: [-140, 72],
            zoom: 3,
            bounds: [-180, 70, 180, 90],
          },
          areaOfInterest: {
            name: 'Test AOI',
            bbox: [-160, 72, -130, 82],
          },
          temporal: {
            current: '2024-06-15T00:00:00Z',
            start: '2024-01-01T00:00:00Z',
            end: '2024-12-31T00:00:00Z',
          },
        },
        history: [{ role: 'user', text: 'Show the active layer.' }],
      },
      undefined,
    );
    expect(instructions).toContain('Current sanitized MMGIS UI state');
    expect(instructions).toContain(
      '"areaOfInterest":{"name":"Test AOI","bbox":[-160,72,-130,82]}',
    );
    expect(instructions).toContain('Recent conversation context');
    expect(instructions).toContain(
      'unique, high-confidence alias, typo-normalized, or paraphrased layer match',
    );
    expect(instructions).toContain(
      'only when multiple plausible candidates remain or every candidate is low confidence',
    );
    expect(instructions).not.toContain(
      'When a layer match is inferred (no exact match), confirm with the user first',
    );
    expect(instructions).toContain(
      'confirm only the prepared/opened state and repeat the manual next step',
    );
    expect(instructions).toContain(
      'Summarize analytical findings only when structured tool result data actually contains them',
    );
    expect(instructions).toContain(
      'statistics, statistical-summary, average, or general-stats request',
    );
    expect(instructions).toContain(
      'MUST use statistics_first_visible',
    );
    expect(instructions).toContain(
      'missing layer catalog/runtime context is not a reason to clarify',
    );
    expect(instructions).toContain(
      'LAYER INVENTORY VS ANALYTICS COMPATIBILITY',
    );
    expect(instructions).toContain(
      "the word 'data' alone does not imply analytical compatibility",
    );
    expect(instructions).toContain(
      "report the complete set whose declared layer type is data",
    );
    expect(instructions).toContain(
      'Use list_analyzable_layers only when the user explicitly asks which layers can be analyzed',
    );
    const exactInventoryStart = instructions.indexOf(
      'User: "Show available data layers."',
    );
    const exactInventoryExample = instructions.slice(
      exactInventoryStart,
      exactInventoryStart + 280,
    );
    expect(exactInventoryStart).toBeGreaterThanOrEqual(0);
    expect(exactInventoryExample).toContain('"tool":"list_layers"');
    expect(exactInventoryExample).not.toContain(
      '"tool":"list_analyzable_layers"',
    );
    const paraphraseInventoryStart = instructions.indexOf(
      'User: "Which data layers are loaded in this mission?"',
    );
    const paraphraseInventoryExample = instructions.slice(
      paraphraseInventoryStart,
      paraphraseInventoryStart + 260,
    );
    expect(paraphraseInventoryStart).toBeGreaterThanOrEqual(0);
    expect(paraphraseInventoryExample).toContain('"tool":"list_layers"');
    expect(paraphraseInventoryExample).not.toContain(
      '"tool":"list_analyzable_layers"',
    );
    const compatibilityInventoryStart = instructions.indexOf(
      'User: "Which layers support statistics?"',
    );
    const compatibilityInventoryExample = instructions.slice(
      compatibilityInventoryStart,
      compatibilityInventoryStart + 300,
    );
    expect(compatibilityInventoryStart).toBeGreaterThanOrEqual(0);
    expect(compatibilityInventoryExample).toContain(
      '"tool":"list_analyzable_layers"',
    );
    expect(compatibilityInventoryExample).not.toContain(
      '"tool":"list_layers"',
    );
    expect(instructions).toContain(
      'Statistics for an unnamed visible/current/first data layer',
    );
    expect(instructions).toContain(
      'whichever data layer is currently visible',
    );
    expect(instructions).toContain(
      'TEMPORAL COMPARISON SAFETY',
    );
    expect(instructions).toContain(
      'MUST NOT be represented by calculate_layer_difference at an arbitrary/representative date',
    );
    expect(instructions).toContain(
      'MUST NOT add set_time merely to collapse the interval into one instant',
    );
    expect(instructions).toContain(
      'explicitly accepts both compared layers and a start/end or duration',
    );
    expect(instructions).toContain(
      'A single-layer trend/change tool is not a substitute',
    );
    expect(instructions).toContain(
      'Never describe a snapshot result as covering the requested interval',
    );
    expect(instructions).toContain(
      'Contrast the forecast and observed layers throughout February',
    );
    expect(instructions).toContain('SPATIAL TARGET IDENTITY');
    expect(instructions).toContain(
      'runtime.map.bounds is never evidence of an AOI/selection',
    );
    expect(instructions).toContain(
      'MUST NOT be substituted or described as one',
    );
    expect(instructions).toContain(
      'Only an explicit request for \'current view\', \'viewport\', or \'map bounds\' may use runtime.map.bounds',
    );
    expect(instructions).toContain(
      'Take me to the selected area',
    );
    expect(instructions).toContain(
      'No selected area or AOI extent is currently available',
    );
    expect(instructions).toContain(
      'Fit to the current map bounds',
    );
    expect(instructions).toContain(
      '"bbox":[-125,30,-110,45]',
    );
    expect(instructions).toContain('FULL-LAYER STATISTICS SCOPE');
    expect(instructions).toContain(
      'use calculate_layer_mean with geographical_area:"full layer extent"',
    );
    expect(instructions).toContain(
      "means the selected layer's own data footprint",
    );
    expect(instructions).toContain(
      'not the current viewport/runtime.map.bounds',
    );
    expect(instructions).toContain(
      'not an AOI/selection extent',
    );
    expect(instructions).toContain(
      'Always emit that canonical value even when the user uses an alias',
    );
    expect(instructions).toContain(
      "Compute a statistical summary across all of Snow Depth's coverage",
    );
    expect(instructions).toContain(
      '"geographical_area":"full layer extent"',
    );
    expect(instructions).toContain('TEMPORAL ANALYTICS ROUTING');
    expect(instructions).toContain(
      "one named layer's changes, trend, evolution, progression, or behavior over time MUST use temporal_trends when it is registered",
    );
    expect(instructions).toContain('do not substitute a generic UI handoff');
    expect(instructions).toContain(
      'If neither provides a valid range, return actions:[]',
    );
    expect(instructions).toContain(
      'Use change_detection only to compare the same layer at two explicit snapshots',
    );
    expect(instructions).toContain('ANALYSIS INTENT DISAMBIGUATION');
    expect(instructions).toContain(
      "A bare request to 'analyze'/'analyse' a layer",
    );
    expect(instructions).toContain(
      'Return actions:[] and ask one concise clarification',
    );
    expect(instructions).toContain(
      'Never select statistics, trends, thresholds, comparisons, a plug-in action, or another hidden/default operation',
    );
    const bareAnalysisStart = instructions.indexOf(
      'User: "Analyze Ice Forecast."',
    );
    const bareAnalysisExample = instructions.slice(
      bareAnalysisStart,
      bareAnalysisStart + 330,
    );
    expect(bareAnalysisStart).toBeGreaterThanOrEqual(0);
    expect(bareAnalysisExample).toContain('"actions":[]');
    expect(bareAnalysisExample).not.toContain('"tool":');
    const paraphraseAnalysisStart = instructions.indexOf(
      'User: "Please perform an analysis on Snow Depth."',
    );
    const paraphraseAnalysisExample = instructions.slice(
      paraphraseAnalysisStart,
      paraphraseAnalysisStart + 300,
    );
    expect(paraphraseAnalysisStart).toBeGreaterThanOrEqual(0);
    expect(paraphraseAnalysisExample).toContain('"actions":[]');
    expect(paraphraseAnalysisExample).not.toContain('"tool":');
    const exactTrendExampleStart = instructions.indexOf(
      'User: "Show Ice Forecast changes over time."',
    );
    const exactTrendExample = instructions.slice(
      exactTrendExampleStart,
      exactTrendExampleStart + 420,
    );
    expect(exactTrendExampleStart).toBeGreaterThanOrEqual(0);
    expect(exactTrendExample).toContain('"tool":"temporal_trends"');
    const paraphraseTrendStart = instructions.indexOf(
      'User: "How has Snow Depth evolved from March through September 2024?"',
    );
    const paraphraseTrend = instructions.slice(
      paraphraseTrendStart,
      paraphraseTrendStart + 420,
    );
    expect(paraphraseTrendStart).toBeGreaterThanOrEqual(0);
    expect(paraphraseTrend).toContain('"tool":"temporal_trends"');
    expect(instructions).toContain(
      '"tool":"change_detection","args":{"layer_name":"Snow Depth"',
    );
    expect(instructions).toContain('STATE-AWARE VISIBILITY MUTATIONS');
    expect(instructions).toContain(
      'NEVER emit a redundant toggle when the layer is already in the requested state',
    );
    expect(instructions).toContain(
      'If exactly one compatible hidden layer is available, toggle that layer visible',
    );
    expect(instructions).toContain(
      'If multiple compatible hidden layers remain, return actions:[] and ask which one',
    );
    expect(instructions).toContain(
      'Apply the same no-op rule to hide/off requests',
    );
    const exactEnableStart = instructions.indexOf(
      'User: "Turn on a data layer to analyze"',
    );
    const exactEnableExample = instructions.slice(
      exactEnableStart,
      exactEnableStart + 260,
    );
    expect(exactEnableStart).toBeGreaterThanOrEqual(0);
    expect(exactEnableExample).toContain('"actions":[]');
    expect(exactEnableExample).toContain('already visible');
    expect(exactEnableExample).not.toContain('"tool":"toggle_layer"');
    const paraphraseEnableStart = instructions.indexOf(
      'User: "Enable something I can run statistics on."',
    );
    const paraphraseEnableExample = instructions.slice(
      paraphraseEnableStart,
      paraphraseEnableStart + 360,
    );
    expect(paraphraseEnableStart).toBeGreaterThanOrEqual(0);
    expect(paraphraseEnableExample).toContain('"tool":"toggle_layer"');
    expect(paraphraseEnableExample).toContain('"visible":true');
    const hiddenNoopStart = instructions.indexOf(
      'User: "Hide Scalar Data C."',
    );
    const hiddenNoopExample = instructions.slice(
      hiddenNoopStart,
      hiddenNoopStart + 220,
    );
    expect(hiddenNoopStart).toBeGreaterThanOrEqual(0);
    expect(hiddenNoopExample).toContain('"actions":[]');
    expect(hiddenNoopExample).toContain('already hidden');
    expect(instructions).not.toContain(
      'include a 2-3 sentence plain-language summary',
    );
    expect(instructions).not.toMatch(/User request:\s*$/);
  });

  test('filters unsafe and oversized citations', () => {
    expect(
      normalizeCitations([
        { title: 'Docs', url: 'https://example.com/docs' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Duplicate', url: 'https://example.com/docs' },
      ]),
    ).toEqual([{ title: 'Docs', url: 'https://example.com/docs' }]);
  });
});

test.describe('@unit Agent provider streaming', () => {
  const streamingRegistry = {
    tools: [
      {
        name: 'list_layers',
        description: 'List the loaded layers.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
    ],
  };
  const toolOptions = {
    registry: streamingRegistry,
    toolNames: new Set(['list_layers']),
  };

  test('normalizes a function-call-only completion into a nonblank plan', () => {
    const normalized = normalizeStreamingCompletion(
      {
        id: 'resp_stream_call',
        output: [
          {
            type: 'function_call',
            name: 'list_layers',
            arguments: '{}',
            call_id: 'call_stream_layers',
          },
        ],
      },
      '',
      toolOptions,
    );

    expect(normalized.actions).toEqual([
      {
        tool: 'list_layers',
        args: {},
        callId: 'call_stream_layers',
      },
    ]);
    expect(normalized.reply.trim().length).toBeGreaterThan(0);
    expect(normalized.responseId).toBe('resp_stream_call');
  });

  test('rejects empty and malformed streaming completions with typed errors', () => {
    expect(() =>
      normalizeStreamingCompletion(
        { id: 'resp_stream_empty', output: [] },
        '',
        toolOptions,
      ),
    ).toThrow(/empty/i);

    try {
      normalizeStreamingCompletion(
        { id: 'resp_stream_malformed', output: [] },
        '{"actions": [}',
        toolOptions,
      );
      throw new Error('Expected malformed streaming completion to fail.');
    } catch (error) {
      expect(error.code).toBe('InvalidAgentPlan');
    }
  });

  test('rejects an invalid streamed action with a typed model-response error', () => {
    try {
      normalizeStreamingCompletion(
        { id: 'resp_stream_unknown', output: [] },
        '{"actions":[{"tool":"unregistered_action","args":{}}]}',
        toolOptions,
      );
      throw new Error('Expected the unregistered action to fail.');
    } catch (error) {
      expect(error.code).toBe('InvalidModelResponse');
      expect(error.message).toMatch(/unknown tool/i);
    }
  });

  test('streams through one supported published-agent request with the full JSON planning prompt', async () => {
    const originalProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'azure';
    const attempts = [];

    async function* fakeAzureStream(message, options) {
      attempts.push({ message, options });
      if (options.instructions || options.tools?.length) {
        throw new Error('Test received forbidden published-agent overrides.');
      }
      yield {
        type: 'response.completed',
        _threadId: 'conversation_stream_minimal',
        response: {
          id: 'resp_stream_minimal',
          output_text:
            '{"actions":[{"tool":"list_layers","args":{}}],"reply":"I will list the loaded layers."}',
          output: [],
        },
      };
    }

    try {
      const events = [];
      for await (const event of streamWithProvider(
        'Which layers are loaded?',
        {},
        {
          ...toolOptions,
          streamAgent: fakeAzureStream,
        },
      )) {
        events.push(event);
      }

      expect(attempts).toHaveLength(1);
      expect(attempts[0].message).toBe('Which layers are loaded?');
      expect(attempts[0].options.tools).toEqual([]);
      expect(attempts[0].options.instructions).toBeUndefined();
      expect(attempts[0].options.messageAlreadyAdded).toBe(false);
      expect(attempts[0].options.conversationMessage).toContain(
        'Available tools:',
      );
      expect(attempts[0].options.conversationMessage).toContain('list_layers');
      expect(attempts[0].options.conversationMessage).toContain(
        'User request: Which layers are loaded?',
      );
      expect(events.filter((event) => event.type === 'plan')).toHaveLength(1);
      expect(events.find((event) => event.type === 'plan').data).toMatchObject({
        responseId: 'resp_stream_minimal',
        reply: 'I will list the loaded layers.',
        actions: [
          {
            tool: 'list_layers',
            args: {},
          },
        ],
      });
      expect(events.at(-1).type).toBe('done');
    } finally {
      if (originalProvider == null) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = originalProvider;
    }
  });
});
