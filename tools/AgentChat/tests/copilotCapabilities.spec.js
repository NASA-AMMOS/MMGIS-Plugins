import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    assessLayerAnalysisCompatibility,
    deriveAvailableAnalysisOperations,
    formatAnalyzableLayerCatalog,
    selectFirstVisibleAnalyzableLayer,
} from '../analysisCompatibility'
import {
    finalizePreparedAction,
    layerArgumentKeysForTool,
    prepareActionLayerArguments,
} from '../actionArgumentPolicy'
import {
    buildDifferenceRequestUrl,
    buildRelativeMeanThresholdAction,
    formatDifferenceStatistics,
} from '../analysisWorkflows'
import { collectThresholdMatches } from '../thresholdSamples'
import {
    appendQueryParameters,
    buildConfiguredAgentEndpoint,
    buildConfiguredAnalyticsEndpoint,
} from '../agentEndpoints'
import {
    buildThresholdExpression,
    convertThresholdValuesToLayerUnit,
    normalizeThresholdOperator,
    resolveThresholdBand,
    resolveThresholdUnit,
} from '../thresholdWorkflow'
import { resolveLayerArguments } from '../layerArgumentResolver'
import {
    executeRegisteredCopilotAction,
    isSafeMmgisApiMethod,
    listRegisteredCopilotActions,
    mergeToolRegistries,
    normalizeRuntimeAction,
    toRuntimeCapabilityDescriptor,
    verifyMmgisFacadeResult,
} from '../runtimeActions'
import { safeCitationUrl } from '../safeUrl'
import {
    assessProviderScalarSemantics,
    resolveScalarRasterTransform,
} from '../scalarRasterTransform'
import {
    discardUnscopedAgentState,
    scopedAgentStorageKey,
} from '../storageKeys'

const LAYERS = [
    {
        id: 'header',
        displayName: 'Analysis Layers',
        canonical: 'Analysis Layers',
        visible: true,
        config: { type: 'header', name: 'analysis-header' },
    },
    {
        id: 'rgb',
        displayName: 'GIBS MODIS True Color',
        canonical: 'GIBS MODIS True Color',
        aliases: ['MODIS True Color'],
        visible: true,
        config: {
            name: 'gibs-rgb',
            display_name: 'GIBS MODIS True Color',
            type: 'tile',
            url: 'https://example.test/{z}/{x}/{y}.jpg',
            format: 'jpg',
        },
    },
    {
        id: 'land-mask',
        uuid: 'land-mask',
        displayName: 'Land Mask',
        canonical: 'Land Mask',
        aliases: ['land'],
        groupPath: 'Data',
        visible: true,
        config: {
            name: 'land-mask',
            display_name: 'Land Mask',
            type: 'data',
            demSourceType: 'cog',
            demurl: '/data/land-mask.tif',
            cogBands: [1],
        },
    },
    {
        id: 'ice-forecast',
        uuid: 'ice-forecast',
        displayName: 'Ice Forecast',
        canonical: 'Ice Forecast',
        aliases: ['forecast'],
        groupPath: 'Data',
        visible: true,
        config: {
            name: 'ice-forecast',
            display_name: 'Ice Forecast',
            type: 'data',
            demSourceType: 'cog',
            demurl: '/data/ice-forecast.tif',
            cogBands: [1],
            time: { enabled: true },
        },
    },
]

test.describe('@unit AgentChat analysis compatibility/workflows', () => {
    test('marks RGB visualization unsupported and scalar COG supported', () => {
        const rgb = assessLayerAnalysisCompatibility(LAYERS[1])
        const scalar = assessLayerAnalysisCompatibility(LAYERS[2])
        expect(rgb).toMatchObject({ supported: false, scalar: false })
        expect(rgb.reason).toContain('RGB imagery')
        expect(scalar).toMatchObject({
            supported: true,
            scalar: true,
            source: 'cog-geotiff',
        })
        expect(scalar.operations).toContain('statistics')
        expect(scalar.operations).toContain('threshold')
    })

    test('does not treat a rendered data tile as accessible scalar data', () => {
        const renderedData = assessLayerAnalysisCompatibility({
            id: 'rendered-data',
            displayName: 'Rendered Temperature',
            config: {
                name: 'rendered-temperature',
                display_name: 'Rendered Temperature',
                type: 'data',
                url: 'https://example.test/temperature/{z}/{x}/{y}.png',
                format: 'png',
            },
        })
        expect(renderedData).toMatchObject({
            supported: false,
            scalar: false,
            source: 'external-imagery',
        })
        expect(renderedData.reason).toContain('rendered image tiles')
    })

    test('selects the first visible analyzable data layer, not a header/RGB layer', () => {
        const selected = selectFirstVisibleAnalyzableLayer(LAYERS, {
            onState: {
                rgb: true,
                'land-mask': true,
                'ice-forecast': true,
            },
        })
        expect(selected?.layerName).toBe('Land Mask')
    })

    test('lists actual supported and unsupported layers with reasons', () => {
        const text = formatAnalyzableLayerCatalog(LAYERS, {
            onState: { rgb: true, 'land-mask': true, 'ice-forecast': true },
        })
        expect(text).toContain('Land Mask')
        expect(text).toContain('Ice Forecast')
        expect(text).toContain('GIBS MODIS True Color')
        expect(text).toContain('visualization-only RGB imagery')
        expect(text).not.toContain('Analysis Layers')
    })

    test('keeps a statistics-only analytics endpoint from advertising raster-only operations', () => {
        const compatibility = assessLayerAnalysisCompatibility(
            {
                id: 'stats-service',
                displayName: 'Stats Service Layer',
                config: {
                    name: 'stats-service',
                    type: 'data',
                    analyticsEndpoint: '/analytics/statistics',
                },
            },
            {
                tools: [
                    { name: 'calculate_layer_mean' },
                    { name: 'threshold_highlight' },
                    { name: 'highlight_relative_to_mean' },
                ],
            }
        )
        expect(compatibility.supported).toBe(true)
        expect(compatibility.operations).toEqual(
            expect.arrayContaining(['statistics', 'mean'])
        )
        expect(compatibility.operations).not.toEqual(
            expect.arrayContaining(['threshold', 'highlight'])
        )
    })

    test('composes above/below-average highlight from the measured mean', () => {
        expect(
            buildRelativeMeanThresholdAction('Ice Forecast', 0.42, 'above', {
                geographical_area: 'current view',
            })
        ).toMatchObject({
            layer_name: 'Ice Forecast',
            variable: 'Ice Forecast',
            operator: '>',
            value: 0.42,
            unit: null,
            geographical_area: 'current view',
        })
        expect(
            buildRelativeMeanThresholdAction('Ice Forecast', 0.42, 'below')
                .operator
        ).toBe('<')
        expect(buildRelativeMeanThresholdAction('Ice Forecast', NaN)).toBeNull()
    })

    test('converts thresholds only against compatible declared layer units', () => {
        expect(
            convertThresholdValuesToLayerUnit({
                operator: '>',
                value: 2,
                inputUnit: 'm',
                declaredUnit: 'cm',
            })
        ).toMatchObject({ ok: true, value: 200, declaredUnit: 'cm' })
        expect(
            convertThresholdValuesToLayerUnit({
                operator: 'between',
                valueMin: 10,
                valueMax: 20,
                inputUnit: 'mm',
                declaredUnit: 'cm',
            })
        ).toMatchObject({ ok: true, valueMin: 1, valueMax: 2 })
        expect(
            convertThresholdValuesToLayerUnit({
                operator: '>',
                value: 25,
                inputUnit: 'cm',
                declaredUnit: null,
            })
        ).toMatchObject({
            ok: false,
            errorCode: 'THRESHOLD_UNIT_METADATA_REQUIRED',
        })
        expect(
            convertThresholdValuesToLayerUnit({
                operator: '>',
                value: 25,
                inputUnit: 'percent',
                declaredUnit: 'm',
            })
        ).toMatchObject({
            ok: false,
            errorCode: 'INCOMPATIBLE_THRESHOLD_UNIT',
        })
        expect(
            resolveThresholdUnit(
                {
                    variables: [{ name: 'height', band: 2, units: 'cm' }],
                    units: 'm',
                },
                'height',
                'b2'
            )
        ).toBe('cm')
    })

    test('enforces comparison area in the real backend difference request', () => {
        const url = new URL(
            buildDifferenceRequestUrl({
                origin: 'https://mmgis.example',
                rootPath: '/app',
                layerA: 'Land Mask',
                layerB: 'Ice Forecast',
                time: '2024-01-02T00:00:00Z',
                mission: 'Arctic',
                bbox: [-160, 70, -120, 76],
            })
        )
        expect(url.pathname).toBe('/app/api/agent/analytics/difference')
        expect(url.searchParams.get('layer_a')).toBe('Land Mask')
        expect(url.searchParams.get('layer_b')).toBe('Ice Forecast')
        expect(url.searchParams.get('lon_min')).toBe('-160')
        expect(url.searchParams.get('lat_min')).toBe('70')
        expect(url.searchParams.get('lon_max')).toBe('-120')
        expect(url.searchParams.get('lat_max')).toBe('76')
        expect(() =>
            buildDifferenceRequestUrl({ layerA: 'A', layerB: 'B' })
        ).toThrow('bounding box')
    })

    test('routes auxiliary Agent endpoints through a custom base and current non-main mission', () => {
        const configuredUrl = (path) =>
            `https://copilot.example/custom/agent${path}?mission=Frozon-DB`
        const metadataUrl = buildConfiguredAgentEndpoint({
            path: '/layer-info',
            mission: 'Frozon-DB',
            configuredUrl,
            params: { name: 'Ice Forecast' },
        })
        expect(metadataUrl).toBe(
            'https://copilot.example/custom/agent/layer-info?mission=Frozon-DB&name=Ice+Forecast'
        )
        const differenceUrl = buildDifferenceRequestUrl({
            baseUrl: buildConfiguredAgentEndpoint({
                path: '/analytics/difference',
                mission: 'Frozon-DB',
                configuredUrl,
            }),
            layerA: 'Land Mask',
            layerB: 'Ice Forecast',
            mission: 'Frozon-DB',
            bbox: [-160, 70, -120, 76],
        })
        expect(new URL(differenceUrl).pathname).toBe(
            '/custom/agent/analytics/difference'
        )
        expect(new URL(differenceUrl).searchParams.get('mission')).toBe(
            'Frozon-DB'
        )
        expect(
            appendQueryParameters('/custom/agent?mission=Frozon-DB', {
                name: 'Layer A',
            })
        ).toBe('/custom/agent?mission=Frozon-DB&name=Layer+A')
        expect(
            buildConfiguredAnalyticsEndpoint({
                path: 'anomalies',
                mission: 'Frozon-DB',
                configuredUrl,
            })
        ).toBe(
            'https://copilot.example/custom/agent/analytics/anomalies?mission=Frozon-DB'
        )
        expect(
            buildConfiguredAnalyticsEndpoint({
                path: 'statistics',
                analyticsBaseUrl: 'https://analytics.example/v2/',
                mission: 'Frozon-DB',
            })
        ).toBe('https://analytics.example/v2/statistics?mission=Frozon-DB')

        const rendererSource = readFileSync(
            resolve(
                process.cwd(),
                'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/renderers.js'
            ),
            'utf8'
        )
        expect(rendererSource).not.toMatch(
            /ROOT_PATH[^\n]{0,120}\/api\/agent|['"]\/api\/agent/
        )
        expect(rendererSource).toMatch(
            /buildRendererAgentEndpoint\(["']\/layer-info["']/
        )
        expect(rendererSource).not.toMatch(
            /fetch\(\s*buildRendererAgentEndpoint\(\s*["']{2}\s*\)/
        )
        expect(rendererSource).toContain('LAYER_INFORMATION_UNAVAILABLE')
        expect(rendererSource).toContain('transformStacUrl')
        expect(rendererSource).toContain('isStacCollection')
        const localAnalyticsSource = readFileSync(
            resolve(
                process.cwd(),
                'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/localAnalytics.js'
            ),
            'utf8'
        )
        expect(localAnalyticsSource).toMatch(
            /path:\s*["']\/analytics\/resolve-cog["']/
        )
        expect(localAnalyticsSource).toContain('buildConfiguredAgentEndpoint')
        const rendererUtilsSource = readFileSync(
            resolve(
                process.cwd(),
                'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/rendererUtils.js'
            ),
            'utf8'
        )
        expect(rendererUtilsSource).toContain(
            'buildConfiguredAnalyticsEndpoint'
        )
        expect(rendererUtilsSource).not.toMatch(/['"]\/api\/agent\/analytics/)
        expect(rendererSource).not.toMatch(/#analysis[A-Za-z]/)
        expect(rendererSource).not.toContain('../Analysis/')
        expect(rendererSource).not.toContain('render_run_analysis')
        expect(rendererSource).not.toContain('mmgisAnalysisTool')
        expect(rendererSource).not.toContain('prepareCopilotAnalysis')
        expect(rendererSource).not.toContain('calculateRealLayerDifference')
        expect(rendererSource).toContain(
            'DIFFERENCE_ALIGNMENT_PROVIDER_REQUIRED'
        )
    })

    test('preserves source coordinates after NoData and polygon filtering', () => {
        const validSamples = [
            { sourceIndex: 3, lon: -150.5, lat: 72.5, value: 2 },
            { sourceIndex: 8, lon: -146.5, lat: 73.5, value: 9 },
            { sourceIndex: 11, lon: -140.5, lat: 74.5, value: 12 },
        ]
        const result = collectThresholdMatches(validSamples, '>', 5, 10)
        expect(result.matchCount).toBe(2)
        expect(result.matches).toEqual([
            { lon: -146.5, lat: 73.5, value: 9 },
            { lon: -140.5, lat: 74.5, value: 12 },
        ])
    })

    test('uses neutral comparison labels and does not infer percent units', () => {
        const summary = formatDifferenceStatistics(
            {
                mean_a: 0.4,
                mean_b: 0.2,
                mean: 0.2,
                std: 0.05,
                min: -0.1,
                max: 0.5,
                median: 0.19,
                q25: 0.1,
                q75: 0.3,
                valid_count: 8,
                total_count: 10,
            },
            { layerA: 'Layer A', layerB: 'Layer B' }
        )
        expect(summary).toContain('Layer A is 0.2000 higher than Layer B')
        expect(summary).not.toContain('%')
        expect(summary).not.toMatch(/prediction|ground truth/i)
    })

    test('advertises only registered analytics and includes applicable plugin operations', () => {
        const withoutProvider = assessLayerAnalysisCompatibility(LAYERS[2], {
            tools: [],
        })
        expect(withoutProvider).toMatchObject({
            supported: false,
            scalar: true,
            operations: [],
        })
        expect(withoutProvider.reason).toContain('no currently registered')

        const tools = [
            { name: 'calculate_layer_mean' },
            {
                name: 'frozon__ice_edge',
                analytics: {
                    operations: ['ice_edge_detection'],
                    dataKinds: ['cog'],
                    requiresScalar: true,
                },
            },
        ]
        const withProvider = assessLayerAnalysisCompatibility(LAYERS[2], {
            tools,
        })
        expect(withProvider.supported).toBe(true)
        expect(withProvider.operations).toEqual(
            expect.arrayContaining(['mean', 'statistics', 'ice_edge_detection'])
        )
        expect(
            deriveAvailableAnalysisOperations(tools, {
                scalar: true,
                source: 'cog-geotiff',
                type: 'data',
            })
        ).toContain('ice_edge_detection')
    })

    test('validates equality/between thresholds and explicit band semantics', () => {
        expect(normalizeThresholdOperator('=')).toBe('==')
        expect(
            buildThresholdExpression({
                operator: '=',
                value: 4,
                band: 'b2',
            })
        ).toMatchObject({ ok: true, expression: '(b2==4)*1' })
        expect(
            buildThresholdExpression({
                operator: 'between',
                valueMin: 2,
                valueMax: 5,
            })
        ).toMatchObject({
            ok: true,
            expression: '((b1>=2)&(b1<=5))*1',
        })
        expect(
            buildThresholdExpression({ operator: 'approximately', value: 2 })
        ).toMatchObject({
            ok: false,
            errorCode: 'UNSUPPORTED_THRESHOLD_OPERATOR',
        })
        expect(resolveThresholdBand({}, 'temperature', 'Ice')).toMatchObject({
            ok: false,
            errorCode: 'UNRESOLVED_RASTER_VARIABLE',
        })
        expect(resolveThresholdBand({}, 'temperature', 'Ice', 3)).toMatchObject(
            {
                ok: true,
                band: 'b3',
            }
        )
    })

    test('uses the declared display transform and excludes configured-domain fill values', () => {
        const transform = resolveScalarRasterTransform({
            cogTransform: true,
            cogExpression: '(asset_b1*100)',
            cogMin: 0,
            cogMax: 100,
            cogUnits: '%',
        })
        expect(transform).toMatchObject({
            ok: true,
            expression: '(b1*100)',
            validRange: [0, 100],
            unit: '%',
        })
        const values = [0, 0.5, 1, -9999]
            .map((value) => transform.apply(value))
            .filter(Number.isFinite)
        expect(values).toEqual([0, 50, 100])
        expect(
            values.reduce((sum, value) => sum + value, 0) / values.length
        ).toBe(50)
        expect(
            buildThresholdExpression({
                operator: '>',
                value: 50,
                band: 'b1',
                valueExpression: transform.expression,
            })
        ).toMatchObject({
            ok: true,
            expression: '((b1*100)>50)*1',
        })
        expect(
            assessProviderScalarSemantics(
                {
                    cogTransform: true,
                    cogExpression: '(asset_b1*100)',
                    cogMin: 0,
                    cogMax: 100,
                    cogUnits: '%',
                },
                { mean: -4563 }
            )
        ).toMatchObject({
            ok: false,
            errorCode: 'ANALYTICS_TRANSFORM_UNVERIFIED',
        })
        expect(
            assessProviderScalarSemantics(
                {
                    cogTransform: true,
                    cogExpression: '(asset_b1*100)',
                    cogMin: 0,
                    cogMax: 100,
                    cogUnits: '%',
                },
                {
                    value_expression: 'b1 * 100',
                    valid_range: [0, 100],
                    unit: '%',
                }
            )
        ).toMatchObject({ ok: true, required: true })
        expect(
            assessProviderScalarSemantics(
                {
                    cogTransform: true,
                    cogExpression: '(asset_b1*100)',
                    cogMin: 0,
                    cogMax: 100,
                    cogUnits: '%',
                },
                {
                    value_expression: 'b1*100',
                    valid_range: [0, 100],
                    unit: '%',
                    mean: -4563,
                }
            )
        ).toMatchObject({
            ok: false,
            errorCode: 'ANALYTICS_RESULT_OUT_OF_RANGE',
        })
    })

    test('evaluates equality and bounded threshold samples without index compaction', () => {
        const samples = [
            { sourceIndex: 2, lon: 1, lat: 1, value: 2 },
            { sourceIndex: 7, lon: 2, lat: 2, value: 5 },
            { sourceIndex: 9, lon: 3, lat: 3, value: 8 },
        ]
        expect(
            collectThresholdMatches(samples, 'between', { min: 2, max: 5 })
        ).toMatchObject({ matchCount: 2 })
        expect(collectThresholdMatches(samples, '==', 8)).toMatchObject({
            matchCount: 1,
            matches: [{ lon: 3, lat: 3, value: 8 }],
        })
    })
})

test.describe('@unit AgentChat runtime plugin actions', () => {
    test('degrades safely when the optional host action facade is absent', async () => {
        expect(await listRegisteredCopilotActions(undefined)).toEqual([])
        const result = await executeRegisteredCopilotAction(
            undefined,
            { name: 'optional-plugin__summarize', callId: 'call-optional' },
            { layer_name: 'Sea-ice concentration' },
            { mission: 'Synthetic Mission' }
        )
        expect(result).toMatchObject({
            tool: 'optional-plugin__summarize',
            callId: 'call-optional',
            ok: false,
            error: { code: 'PLUGIN_ACTION_UNAVAILABLE' },
        })
    })

    test('uses the namespaced descriptor id for model and execution', () => {
        const action = normalizeRuntimeAction({
            id: 'frozon__statistics',
            name: 'statistics',
            plugin: 'Frozon',
            description: 'Calculate Frozon statistics.',
            parameters: { type: 'object', properties: {} },
        })
        expect(action).toMatchObject({
            name: 'frozon__statistics',
            displayName: 'statistics',
            plugin: 'Frozon',
            execution: {
                adapter: 'pluginAction',
                action: 'frozon__statistics',
            },
        })
    })

    test('uses runtime parameters as the only authoritative action schema', () => {
        const parameters = {
            type: 'object',
            properties: { opacity: { type: 'number' } },
            required: ['opacity'],
        }
        const action = normalizeRuntimeAction({
            id: 'frozon__opacity',
            name: 'opacity',
            parameters,
            modelParameters: {
                type: 'object',
                properties: { stale: { type: 'string' } },
            },
        })
        expect(action.parameters).toBe(parameters)
        expect(action.modelParameters).toBe(parameters)
        expect(action.modelParameters.properties).not.toHaveProperty('stale')
    })

    test('preserves sanitized plugin analytics applicability metadata', () => {
        const action = normalizeRuntimeAction({
            id: 'frozon__edge',
            name: 'edge',
            analytics: {
                operations: ['ice_edge_detection'],
                dataKinds: ['cog'],
                requiresScalar: true,
            },
        })
        expect(action.analytics).toEqual({
            operations: ['ice_edge_detection'],
            dataKinds: ['cog'],
            requiresScalar: true,
        })
        expect(toRuntimeCapabilityDescriptor(action).analytics).toEqual(
            action.analytics
        )
    })

    test('round-trips a core-shaped descriptor with its portable id', () => {
        const normalized = normalizeRuntimeAction({
            id: 'mmgis-core__reset_map_view',
            name: 'reset_map_view',
            plugin: 'mmgis-core',
            parameters: { type: 'object', properties: {} },
        })
        const advertised = toRuntimeCapabilityDescriptor(normalized)
        // The backend prefers `name`, so it must be the same namespaced key
        // that the client registry and executeCopilotAction use.
        expect(advertised).toMatchObject({
            name: 'mmgis-core__reset_map_view',
            id: 'mmgis-core__reset_map_view',
            displayName: 'reset_map_view',
        })
        const registry = mergeToolRegistries([normalized], [])
        expect(registry.find((tool) => tool.name === advertised.name)).toBe(
            normalized
        )
    })

    test('requests only available actions and refreshes on each discovery', async () => {
        const calls = []
        let turn = 0
        const api = {
            listCopilotActions(options) {
                calls.push(options)
                turn += 1
                return turn === 1
                    ? [
                          { id: 'core__map', name: 'map', available: true },
                          { id: 'late__action', available: false },
                      ]
                    : [{ id: 'plugin__new_action', name: 'new_action' }]
            },
        }
        expect(
            (await listRegisteredCopilotActions(api)).map((a) => a.name)
        ).toEqual(['core__map'])
        expect(
            (await listRegisteredCopilotActions(api)).map((a) => a.name)
        ).toEqual(['plugin__new_action'])
        expect(calls).toEqual([
            { availableOnly: true },
            { availableOnly: true },
        ])
    })

    test('static tools win registry collisions', () => {
        const runtime = {
            name: 'zoom_to',
            description: 'untrusted runtime collision',
        }
        const bundled = { name: 'zoom_to', description: 'bundled zoom' }
        const merged = mergeToolRegistries(
            [runtime, { name: 'plugin__action' }],
            [bundled]
        )
        expect(merged.find((tool) => tool.name === 'zoom_to')).toBe(bundled)
        expect(merged.map((tool) => tool.name)).toContain('plugin__action')
    })

    test('executes the registered id and returns a structured result', async () => {
        const calls = []
        const result = await executeRegisteredCopilotAction(
            {
                executeCopilotAction(id, args, context) {
                    calls.push({ id, args, context })
                    return { ok: true, message: 'Forecast overlay enabled.' }
                },
            },
            { name: 'frozon__enable_forecast', callId: 'call-plugin' },
            { opacity: 0.8 },
            { mission: 'Arctic' }
        )
        expect(calls[0]).toMatchObject({
            id: 'frozon__enable_forecast',
            args: { opacity: 0.8 },
        })
        expect(result).toMatchObject({
            tool: 'frozon__enable_forecast',
            callId: 'call-plugin',
            ok: true,
            message: 'Forecast overlay enabled.',
            error: null,
        })
    })

    test('does not expose raw plugin exception details', async () => {
        const originalError = console.error
        console.error = () => {}
        try {
            const result = await executeRegisteredCopilotAction(
                {
                    executeCopilotAction() {
                        throw new Error(
                            'secret failure at C:\\Users\\operator\\plugin.js token=abc'
                        )
                    },
                },
                { name: 'frozon__explode' }
            )
            expect(result.ok).toBe(false)
            expect(result.message).toBe(
                'Plugin action "frozon__explode" could not be completed.'
            )
            expect(JSON.stringify(result)).not.toContain('operator')
            expect(JSON.stringify(result)).not.toContain('token=abc')
        } finally {
            console.error = originalError
        }
    })

    test('rejects a malicious server-controlled MMGIS facade method', () => {
        expect(isSafeMmgisApiMethod('toggleLayer')).toBe(true)
        expect(isSafeMmgisApiMethod('setLayerOpacity')).toBe(true)
        expect(isSafeMmgisApiMethod('fetch')).toBe(false)
        expect(isSafeMmgisApiMethod('constructor')).toBe(false)
        expect(isSafeMmgisApiMethod('__proto__')).toBe(false)
    })

    test('does not claim success when layer facade state did not change', () => {
        expect(
            verifyMmgisFacadeResult({
                method: 'toggleLayer',
                targetId: 'ice',
                requestedVisible: true,
                visibleLayers: { ice: false },
            })
        ).toMatchObject({
            ok: false,
            errorCode: 'LAYER_VISIBILITY_NOT_VERIFIED',
        })
        expect(
            verifyMmgisFacadeResult({
                method: 'toggleLayer',
                targetId: 'ice',
                requestedVisible: true,
                visibleLayers: { ice: true },
            })
        ).toMatchObject({ ok: true, data: { visible: true } })
        expect(
            verifyMmgisFacadeResult({
                method: 'setLayerOpacity',
                targetId: 'ice',
                requestedOpacity: 0.5,
                opacityByLayer: { ice: 0.8 },
            })
        ).toMatchObject({
            ok: false,
            errorCode: 'LAYER_OPACITY_NOT_VERIFIED',
        })
    })
})

test.describe('@unit AgentChat layer arguments and client safety', () => {
    test('preserves non-layer navigation and temporal arguments through final dispatch preparation', () => {
        for (const action of [
            {
                tool: 'zoom_to',
                callId: 'zoom-call',
                args: { region: 'Beaufort Sea', zoom: 3 },
            },
            {
                tool: 'set_time',
                callId: 'time-call',
                args: { time: 'January 2023' },
            },
        ]) {
            const resolution = prepareActionLayerArguments({
                action,
                spec: {
                    name: action.tool,
                    execution: { adapter: 'custom' },
                    parameters: {
                        type: 'object',
                        properties:
                            action.tool === 'zoom_to'
                                ? {
                                      region: { type: 'string' },
                                      zoom: { type: 'number' },
                                  }
                                : { time: { type: 'string' } },
                    },
                },
                layers: LAYERS,
            })
            const finalized = finalizePreparedAction(action, resolution)
            expect(finalized.prepared.args).toEqual(action.args)
            expect(finalized.prepared.callId).toBe(action.callId)
            expect(finalized.matches).toEqual([])
        }
    })

    test('does not reinterpret core/plugin action name or layers arguments', () => {
        const spec = {
            name: 'mmgis-core__open_tool',
            execution: { adapter: 'pluginAction' },
            parameters: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
        }
        expect(layerArgumentKeysForTool(spec)).toEqual({
            scalarKeys: [],
            arrayKeys: [],
        })
        const prepared = prepareActionLayerArguments({
            action: {
                tool: spec.name,
                args: { name: 'Layers', layers: ['Left', 'Right'] },
            },
            spec,
            layers: LAYERS,
        })
        expect(prepared.error).toBeUndefined()
        expect(prepared.prepared.args).toEqual({
            name: 'Layers',
            layers: ['Left', 'Right'],
        })
        expect(prepared.matches).toEqual([])
    })

    test('still resolves schema-declared static layer arguments', () => {
        const prepared = prepareActionLayerArguments({
            action: {
                tool: 'toggle_layer',
                args: { name: 'land', visible: false },
            },
            spec: {
                name: 'toggle_layer',
                execution: {
                    adapter: 'mmgisAPI',
                    nameResolution: 'displayNameToInternalId',
                },
                parameters: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Display name of the layer',
                        },
                        visible: { type: 'boolean' },
                    },
                },
            },
            layers: LAYERS,
        })
        expect(prepared.prepared.args.name).toBe('Land Mask')
        expect(prepared.matches[0].key).toBe('name')
    })

    test('keeps an explicit exact layer match despite broader domain wording', () => {
        const layers = [
            {
                id: 'sfno-prediction',
                displayName: 'SFNO Prediction Daily 10 km 2022-2024',
                canonical: 'sfno_prediction_daily',
                visible: true,
            },
        ]
        const resolved = resolveLayerArguments({
            args: { name: 'SFNO Prediction Daily 10 km 2022-2024' },
            layers,
            userQuery: 'Show me the sea ice forecast for January 2024',
            scalarKeys: ['name'],
            arrayKeys: [],
        })
        expect(resolved.error).toBeUndefined()
        expect(resolved.args.name).toBe('SFNO Prediction Daily 10 km 2022-2024')
    })

    test('resolves comparison/multilayer and temporal layer arrays item by item', () => {
        const multilayer = resolveLayerArguments({
            args: { layer_names: ['land', 'forecast'] },
            layers: LAYERS,
            userQuery: 'Compare land and forecast',
        })
        expect(multilayer.error).toBeUndefined()
        expect(multilayer.args.layer_names).toEqual([
            'Land Mask',
            'Ice Forecast',
        ])
        expect(multilayer.matches.map((match) => match.key)).toEqual([
            'layer_names[0]',
            'layer_names[1]',
        ])

        const temporal = resolveLayerArguments({
            args: { layers: ['forecast', 'land'] },
            layers: LAYERS,
            userQuery: 'Set time for forecast and land',
        })
        expect(temporal.error).toBeUndefined()
        expect(temporal.args.layers).toEqual(['Ice Forecast', 'Land Mask'])
    })

    test('reports array item not-found and ambiguity with its exact index', () => {
        const missing = resolveLayerArguments({
            args: { layer_names: ['land', 'Unobtainium Bathymetry QZX'] },
            layers: LAYERS,
        })
        expect(missing.key).toBe('layer_names[1]')
        expect(missing.error).toContain('Could not find')

        const ambiguousLayers = [
            ...LAYERS,
            {
                id: 'wave-forecast',
                uuid: 'wave-forecast',
                displayName: 'Wave Forecast',
                canonical: 'Wave Forecast',
                aliases: ['forecast'],
                groupPath: 'Ocean',
            },
        ]
        const ambiguous = resolveLayerArguments({
            args: { layers: ['forecast'] },
            layers: ambiguousLayers,
        })
        expect(ambiguous.key).toBe('layers[0]')
        expect(ambiguous.error).toContain('ambiguous')
    })

    test('returns a concise clarification for an ambiguous single-layer command', () => {
        const ambiguousLayers = [
            ...LAYERS,
            {
                id: 'wave-forecast',
                uuid: 'wave-forecast',
                displayName: 'Wave Forecast',
                canonical: 'Wave Forecast',
                aliases: ['forecast'],
                groupPath: 'Ocean',
            },
        ]
        const result = resolveLayerArguments({
            args: { name: 'forecast' },
            layers: ambiguousLayers,
            userQuery: 'Hide the forecast layer',
        })
        expect(result.key).toBe('name')
        expect(result.error).toContain('ambiguous')
        expect(result.error).toContain('Ice Forecast')
        expect(result.error).toContain('Wave Forecast')
        expect(result.args).toBeUndefined()
    })

    test('permits only safe citation URL schemes', () => {
        expect(safeCitationUrl('https://docs.example/x')).toBe(
            'https://docs.example/x'
        )
        expect(safeCitationUrl('/docs/layers')).toBe('/docs/layers')
        expect(safeCitationUrl(['java', 'script:alert(1)'].join(''))).toBeNull()
        expect(
            safeCitationUrl('data:text/html,<script>alert(1)</script>')
        ).toBeNull()
        expect(safeCitationUrl('vbscript:msgbox(1)')).toBeNull()
    })

    test('namespaces conversation state by mission and discards legacy globals', () => {
        expect(scopedAgentStorageKey('mmgis.agent.chat.history.v1', 'A')).toBe(
            'mmgis.agent.chat.history.v1.A'
        )
        expect(scopedAgentStorageKey('mmgis.agent.chat.history.v1', 'B')).toBe(
            'mmgis.agent.chat.history.v1.B'
        )
        const removed = []
        discardUnscopedAgentState({ removeItem: (key) => removed.push(key) }, [
            'history',
            'conversation',
        ])
        expect(removed).toEqual(['history', 'conversation'])
    })

    test('contains no simulated/random analytics or fake NetCDF exporter', () => {
        const sources = ['dataExport.js', 'anomalyDetection.js', 'renderers.js']
            .map((name) =>
                readFileSync(
                    resolve(
                        process.cwd(),
                        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat',
                        name
                    ),
                    'utf8'
                )
            )
            .join('\n')
        expect(sources).not.toMatch(/Math\.random/)
        expect(sources).not.toMatch(/exportAsNetCDF/)
        expect(sources).not.toMatch(/simulated|mock statistics/i)
        expect(sources).not.toMatch(/units:\s*['"]meters['"]/i)
        expect(sources).not.toMatch(/nc\.json|NetCDF export is in JSON/i)
        expect(sources).not.toMatch(/KEEP_VISIBLE_LAYERS/)
    })

    test('refreshes initial capabilities, retries registry failures, and stores zoom undo only after success', () => {
        const source = readFileSync(
            resolve(
                process.cwd(),
                'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/AgentChatTool.js'
            ),
            'utf8'
        )
        const initBlock = source.slice(
            source.indexOf('function initUI()'),
            source.indexOf('function renderOverlayInner()')
        )
        expect(initBlock).toContain('ensureRegistry({ refreshRuntime: true })')
        expect(initBlock).toContain('state.welcomeSuggestions = null')
        expect(initBlock).toContain('renderMessages()')

        const registryBlock = source.slice(
            source.indexOf('async function ensureRegistry'),
            source.indexOf('async function exec(actions')
        )
        expect(registryBlock).toContain("payload?.status === 'failure'")
        expect(registryBlock).toContain('state.staticToolRegistry = payload')
        expect(registryBlock).toContain('state.staticToolRegistry = null')
        expect(registryBlock).not.toContain(
            'state.staticToolRegistry = registry'
        )

        const rendererBlock = source.slice(
            source.indexOf('const rawResult = await RENDERERS'),
            source.indexOf('} catch (e)', source.indexOf('const rawResult'))
        )
        expect(rendererBlock.indexOf('const normalizedResult')).toBeGreaterThan(
            -1
        )
        expect(
            rendererBlock.indexOf('if (pendingZoomUndo && normalizedResult.ok)')
        ).toBeGreaterThan(rendererBlock.indexOf('const normalizedResult'))
    })
})
