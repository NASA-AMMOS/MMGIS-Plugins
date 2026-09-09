import { test, expect } from '@playwright/test'
import {
    suggestionConfig,
    getConfiguredDemoQueries,
    buildAllZoomGrammarExamples,
    buildDynamicLayerSuggestions,
    buildContextualSuggestions,
    historyText,
} from '../suggestions'
import {
    createAreaUnresolvedError,
    findConfiguredRegion,
    isFullLayerExtentArea,
    resolveConfiguredArea,
    resolveFullLayerExtentArea,
    resolveNamedRegion,
} from '../regionNavigation'

const OLD_STATIC_UNION = [
    'What is MMGIS?',
    'List layers',
    'Which layers can I analyze?',
    'Show analyzable layers',
    'Tell me about MMGIS',
    'What time range is available for the current layer?',
    'Move the time slider to the latest date',
    'Set time to January 2024',
    'Show statistics of the first visible layer',
    'Show statistics of the first visible data layer',
    'Highlight areas where the current layer exceeds its average value',
    'Zoom to the current area of interest',
    'Turn on a data layer to analyze',
    'Show available data layers',
    'Show me the sea ice forecast for January 2024',
    'What is the predicted sea ice concentration today?',
    'Compare the AI prediction with ground truth for last week',
    'Turn on the forecast prediction layer',
    'Show the difference between predicted and ground truth ice',
    'What layers are available in this mission?',
    'Zoom to the Arctic region',
    'What is the sea ice extent trend over 2023?',
]

const FIXTURE_VALUES = {
    layer: 'Scalar Ice',
    layerA: 'Scalar Ice',
    layerB: 'Ice Forecast',
    region: 'Beaufort Sea',
    zoom: 3,
}

function interpolate(template, values = FIXTURE_VALUES) {
    return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) =>
        String(values[key] ?? '')
    )
}

function instantiateEveryConfiguredFamily() {
    const dynamic = Object.values(suggestionConfig.dynamicTemplates || {})
        .flat()
        .map((template) => interpolate(template))
    const contextual = Object.values(suggestionConfig.contextualQueries || {})
        .flat()
        .map((template) => interpolate(template))
    return [
        ...getConfiguredDemoQueries(),
        ...buildAllZoomGrammarExamples(),
        ...dynamic,
        ...contextual,
    ]
}

const SCALAR_LAYER = {
    id: 'scalar-ice',
    displayName: 'Scalar Ice',
    config: {
        name: 'scalar-ice',
        display_name: 'Scalar Ice',
        type: 'data',
        demSourceType: 'cog',
        demurl: '/data/scalar-ice.tif',
        cogBands: [1],
        time: { enabled: true },
    },
}

const SECOND_SCALAR_LAYER = {
    id: 'ice-forecast',
    displayName: 'Ice Forecast',
    config: {
        name: 'ice-forecast',
        display_name: 'Ice Forecast',
        type: 'data',
        demSourceType: 'cog',
        demurl: '/data/ice-forecast.tif',
        cogBands: [1],
    },
}

const RGB_LAYER = {
    id: 'gibs-rgb',
    displayName: 'GIBS MODIS True Color',
    config: {
        name: 'gibs-rgb',
        display_name: 'GIBS MODIS True Color',
        type: 'tile',
        url: 'https://example.test/{z}/{x}/{y}.jpg',
        format: 'jpg',
    },
}

test.describe('@unit AgentChat consolidated examples', () => {
    test('preserves the full static union from every former source', () => {
        const configured = getConfiguredDemoQueries()
        for (const query of OLD_STATIC_UNION)
            expect(configured).toContain(query)
    })

    test('instantiates every static, zoom, dynamic, and contextual example', () => {
        const examples = instantiateEveryConfiguredFamily()
        expect(examples.length).toBeGreaterThan(150)
        for (const query of examples) {
            expect(query.trim().length).toBeGreaterThan(4)
            expect(query).not.toMatch(/\{[A-Za-z0-9_]+\}/)
            expect(query).toMatch(
                /\b(what|which|show|list|tell|move|set|turn|compare|highlight|calculate|zoom|take|animate|analyze|go|give)\b/i
            )
        }
    })

    test('preserves every former generated layer/contextual literal', () => {
        const generated = new Set(instantiateEveryConfiguredFamily())
        const expected = [
            'Show statistics for Scalar Ice',
            'Animate Scalar Ice over time',
            'Highlight areas where Scalar Ice exceeds its average value',
            'What is the difference between Scalar Ice and Ice Forecast?',
            'Calculate mean for Scalar Ice',
            'Analyze Scalar Ice',
            'Show statistics of Scalar Ice for the full layer extent',
            'Show Scalar Ice changes over time',
            'Compare Scalar Ice vs Ice Forecast',
            'What other layers are available?',
            'Set layer opacity to 50%',
            'Show me layer information',
            'Show available time range',
            'Move to the latest date',
            'Go to January 2024',
            'Compare with other layers',
            'Zoom to Arctic Ocean',
            'Show Beaufort Sea region',
            'List visible layers in this area',
        ]
        for (const query of expected) expect(generated).toContain(query)
    })

    test('expands all old and new zoom grammars for every region/level', () => {
        const examples = buildAllZoomGrammarExamples()
        const expectedCount =
            suggestionConfig.zoom.regions.length *
            suggestionConfig.zoom.grammar.reduce(
                (count, grammar) =>
                    count +
                    (grammar.includes('{zoom}')
                        ? suggestionConfig.zoom.levels.length
                        : 1),
                0
            )
        expect(examples).toHaveLength(expectedCount)
        expect(new Set(examples).size).toBe(expectedCount)
        expect(examples).toContain('Zoom to the Beaufort Sea at zoom level 3')
        expect(examples).toContain('Zoom into the Beaufort Sea at zoom level 3')
        expect(examples).toContain('Zoom to the Beaufort Sea with zoom level 3')
        expect(examples).toContain(
            'Zoom into the Beaufort Sea with zoom level 3'
        )
        expect(examples).toContain('Take me to the Beaufort Sea')
        expect(examples).toContain('Show the Beaufort Sea at zoom 3')
    })

    test('dynamic analytics suggestions exclude headers and RGB imagery', () => {
        const suggestions = buildDynamicLayerSuggestions(
            [
                { id: 'header', config: { type: 'header', name: 'Data' } },
                RGB_LAYER,
                SCALAR_LAYER,
                SECOND_SCALAR_LAYER,
            ],
            {
                onState: {
                    'gibs-rgb': true,
                    'scalar-ice': true,
                    'ice-forecast': true,
                },
            }
        )
        expect(suggestions.some((query) => query.includes('Scalar Ice'))).toBe(
            true
        )
        expect(
            suggestions.some((query) => query.includes('Ice Forecast'))
        ).toBe(true)
        expect(suggestions.some((query) => query.includes('GIBS'))).toBe(false)
        expect(suggestions.some((query) => query.includes('Data'))).toBe(false)
    })

    test('contextual suggestions use the persisted reply/text fields', () => {
        const history = [
            { role: 'user', text: 'Which layers support statistics?' },
            { role: 'assistant', reply: 'Scalar Ice is analyzable.' },
        ]
        expect(historyText(history[1])).toBe('Scalar Ice is analyzable.')
        const suggestions = buildContextualSuggestions(
            history,
            [SCALAR_LAYER, SECOND_SCALAR_LAYER],
            { onState: { 'scalar-ice': true, 'ice-forecast': true } }
        )
        expect(suggestions).toContain(
            'Give me statistics for the visible layer'
        )
        expect(suggestions).toContain('What other layers are available?')
    })
})

test.describe('@unit AgentChat named-region navigation', () => {
    test('resolves full-layer extent from layer metadata or a bounded global envelope', () => {
        expect(isFullLayerExtentArea('for the full layer extent')).toBe(true)
        expect(
            resolveFullLayerExtentArea({
                layer: { config: { bbox: [-170, 50, -120, 85] } },
            })
        ).toMatchObject({
            bbox: [-170, 50, -120, 85],
            source: 'layer-config-extent',
            fullLayerExtent: true,
        })
        expect(resolveFullLayerExtentArea({ layer: {} })).toMatchObject({
            bbox: [-180, -90, 180, 90],
            source: 'global-raster-envelope',
            fullLayerExtent: true,
        })
    })

    test('grounds Beaufort, Chukchi, and Greenland regions from config', () => {
        expect(findConfiguredRegion('Beaufort Sea')?.bbox).toEqual([
            -160, 70, -120, 76,
        ])
        expect(findConfiguredRegion('the Chukchi Sea region')?.name).toBe(
            'Chukchi Sea'
        )
        expect(findConfiguredRegion('Greenland Sea')?.center).toEqual([-5, 74])
    })

    test('accepts natural paraphrase-shaped region values', () => {
        expect(findConfiguredRegion('take me to the Beaufort Sea')?.name).toBe(
            'Beaufort Sea'
        )
        expect(findConfiguredRegion('show Beaufort Sea at zoom 3')?.name).toBe(
            'Beaufort Sea'
        )
        expect(findConfiguredRegion('zoom to Greenland Sea')?.name).toBe(
            'Greenland Sea'
        )
    })

    test('uses the same configured bbox for navigation and analysis areas', () => {
        for (const name of ['Beaufort Sea', 'Chukchi Sea', 'Greenland Sea']) {
            expect(resolveConfiguredArea(name)?.bbox).toEqual(
                findConfiguredRegion(name)?.bbox
            )
        }
    })

    test('uses map bounds only for explicit current-view aliases', () => {
        const map = {
            getBounds: () => ({
                getWest: () => -20,
                getSouth: () => 60,
                getEast: () => 10,
                getNorth: () => 80,
            }),
        }
        expect(resolveConfiguredArea('current view', { map })).toMatchObject({
            label: 'current map view',
            bbox: [-20, 60, 10, 80],
        })
        expect(resolveConfiguredArea('Bering Sea', { map })).toBeNull()
        const error = createAreaUnresolvedError('Bering Sea')
        expect(error.code).toBe('AREA_UNRESOLVED')
        expect(error.message).toContain('Bering Sea')
    })

    test('falls back to the region resolver endpoint for unknown names', async () => {
        let requestedUrl = ''
        const region = await resolveNamedRegion('Test Sound', {
            apiUrl: '/api/agent/regions/resolve?mission=demo',
            fetchImpl: async (url) => {
                requestedUrl = url
                return {
                    ok: true,
                    json: async () => ({
                        region: {
                            name: 'Test Sound',
                            bbox: [-10, 60, 0, 70],
                        },
                    }),
                }
            },
        })
        expect(requestedUrl).toContain('&name=Test%20Sound')
        expect(region).toMatchObject({
            name: 'Test Sound',
            bbox: [-10, 60, 0, 70],
            source: 'region-resolver',
        })
    })
})
