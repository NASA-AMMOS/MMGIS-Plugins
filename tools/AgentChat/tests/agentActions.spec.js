// @unit tests for the Copilot action helpers shared by the AgentChat tool and
// the CopilotMCPBridge component (tools/AgentChat/agentActions.js).
import { test, expect } from '@playwright/test'
import {
    buildAgentLayerIndex,
    findAgentLayerMatch,
    prepareActionLayerArgs,
    resolveDisplayNameToLayerId,
    applyLayerConflictRules,
    collectAgentLayers,
    buildAgentContextFromLayers,
    detectMmgisOverviewIntent,
    detectZoomRegionIntent,
    detectFastTimeIntent,
} from '../agentActions'

const SWOT = 'c44a81f4-0b76-427b-8636-5e9786d8666a'
const ICESAT = 'f579e8bf-1b24-4bc2-a805-b55913daf0f6'
const SEAICE = 'efaca54b-6861-48ee-8a03-cbc0a4d8591b'

const CONFIGS = {
    [SWOT]: { uuid: SWOT, name: 'SWOT freeboard', display_name: 'SWOT freeboard', type: 'tile', aliases: ['SWOT binned Freeboard'], boundingBox: [-180, 60, 180, 90] },
    [ICESAT]: { uuid: ICESAT, name: 'ICESat-2 freeboard', display_name: 'ICESat-2 freeboard', type: 'tile' },
    [SEAICE]: { uuid: SEAICE, name: 'Sea Ice Concentration', display_name: 'Sea Ice Concentration', type: 'tile', alias: 'seaice; ice concentration' },
}

function installMmgisApi({ visible = { [SWOT]: true, [ICESAT]: true }, conflicts = null } = {}) {
    const toggles = []
    global.window = {
        mmgisAPI: {
            getLayerConfigs: () => CONFIGS,
            getVisibleLayers: () => ({ ...visible }),
            getLayers: () => ({}),
            asLayerUUID: (v) => (CONFIGS[v] ? v : null),
            toggleLayer: async (id, on) => {
                toggles.push([id, on])
                visible[id] = on
            },
        },
        mmgisAgentLayerConflicts: conflicts || undefined,
    }
    return toggles
}

test.afterEach(() => {
    delete global.window
})

test.describe('AgentChat shared action helpers @unit', () => {
    test('buildAgentLayerIndex indexes every configured layer with aliases, visibility and bbox', () => {
        installMmgisApi()
        const index = buildAgentLayerIndex()
        expect(index.map((l) => l.id)).toEqual([SWOT, ICESAT, SEAICE])
        const swot = index[0]
        expect(swot).toMatchObject({ displayName: 'SWOT freeboard', canonical: 'SWOT freeboard', visible: true, bbox: [-180, 60, 180, 90] })
        expect(swot.aliases).toEqual(expect.arrayContaining(['SWOT freeboard', 'SWOT binned Freeboard']))
        expect(index[2].aliases).toEqual(expect.arrayContaining(['seaice', 'ice concentration']))
        expect(index[2].visible).toBe(false)
    })

    test('without window.mmgisAPI the index is empty instead of throwing', () => {
        global.window = {}
        expect(buildAgentLayerIndex()).toEqual([])
    })

    test('prepareActionLayerArgs resolves every layer argument to the canonical layer name', () => {
        installMmgisApi()
        const index = buildAgentLayerIndex()
        const findMatch = (value, query) => findAgentLayerMatch(value, query, index)
        const prep = prepareActionLayerArgs(
            { tool: 'calculate_layer_difference', args: { layer_a: 'swot binned freeboard', layer_b: 'icesat-2 freeboard' } },
            { userQuery: '', findMatch }
        )
        expect(prep.error).toBeUndefined()
        expect(prep.prepared.args).toEqual({ layer_a: 'SWOT freeboard', layer_b: 'ICESat-2 freeboard' })
        expect(prep.matches.map((m) => [m.key, m.uuid])).toEqual([
            ['layer_a', SWOT],
            ['layer_b', ICESAT],
        ])
        expect(prep.prepared.__layerMatches).toBe(prep.matches)

        // The chat passes the user's message; a layer named there disambiguates a vague argument.
        const vague = prepareActionLayerArgs({ tool: 'toggle_layer', args: { name: 'freeboard', visible: true } }, { userQuery: 'turn on the swot freeboard', findMatch })
        expect(vague.prepared.args.name).toBe('SWOT freeboard')
    })

    test('prepareActionLayerArgs leaves actions without layer arguments unchanged and reports unknown layers', () => {
        installMmgisApi()
        const index = buildAgentLayerIndex()
        const findMatch = (value, query) => findAgentLayerMatch(value, query, index)
        const zoom = { tool: 'zoom_to', args: { center: [-150, 72], zoom: 4 } }
        expect(prepareActionLayerArgs(zoom, { findMatch })).toEqual({ prepared: zoom, matches: [] })
        const missing = prepareActionLayerArgs({ tool: 'toggle_layer', args: { name: 'zzzz qqqq', visible: true } }, { findMatch: () => null })
        expect(missing).toEqual({ error: 'Could not find a layer matching "zzzz qqqq".', key: 'name' })
        const ambiguous = prepareActionLayerArgs(
            { tool: 'toggle_layer', args: { name: 'freeboard', visible: true } },
            { findMatch: () => ({ ambiguous: true, candidates: [{ displayName: 'SWOT freeboard', groupPath: 'Research' }, { displayName: 'ICESat-2 freeboard' }] }) }
        )
        expect(ambiguous.error).toBe('Layer "freeboard" is ambiguous. Choose one: Research > SWOT freeboard | ICESat-2 freeboard.')
    })

    test('resolveDisplayNameToLayerId matches display/canonical names, then the MMGIS API', () => {
        installMmgisApi()
        const index = buildAgentLayerIndex()
        expect(resolveDisplayNameToLayerId('swot FREEBOARD', index)).toBe(SWOT)
        expect(resolveDisplayNameToLayerId(SEAICE, [])).toBe(SEAICE)
        expect(resolveDisplayNameToLayerId('nope', index)).toBe(null)
    })

    test('applyLayerConflictRules turns off conflicting visible layers only when a mission rule matches', async () => {
        let toggles = installMmgisApi()
        expect(await applyLayerConflictRules(SEAICE, 'show sea ice')).toEqual([])
        expect(toggles).toEqual([])

        toggles = installMmgisApi({ conflicts: [{ trigger: /sea ice/, conflicts: /freeboard/ }] })
        const off = await applyLayerConflictRules(SWOT, 'show sea ice with swot')
        expect(off).toEqual([{ id: ICESAT, name: 'ICESat-2 freeboard' }]) // the target layer itself stays on
        expect(toggles).toEqual([[ICESAT, false]])
    })

    test('the planner context lists every layer with names, aliases, visibility and bbox', () => {
        installMmgisApi()
        const context = buildAgentContextFromLayers(collectAgentLayers(buildAgentLayerIndex()))
        expect(context.layers.length).toBe(3)
        expect(context.layers[0]).toMatchObject({ display_name: 'SWOT freeboard', canonical_name: 'SWOT freeboard', visible: true, bbox: [-180, 60, 180, 90] })
        expect(buildAgentContextFromLayers([])).toBe(null)
    })

    test('local command detectors recognise the Copilot fast-path phrasings', () => {
        expect(detectMmgisOverviewIntent('What is MMGIS?')).toBe(true)
        expect(detectMmgisOverviewIntent('what is the mean of swot')).toBe(false)
        expect(detectZoomRegionIntent('zoom to point barrow')).toEqual({ region: 'point barrow', zoom: null })
        expect(detectZoomRegionIntent('Fly to the Beaufort Sea at zoom level 7')).toEqual({ region: 'Beaufort Sea', zoom: 7 })
        expect(detectZoomRegionIntent('turn on swot')).toBe(null)
        expect(detectFastTimeIntent('set the time slider to March 2024')).toEqual({ query: 'March 2024' })
        expect(detectFastTimeIntent('jump to the latest time')).toMatchObject({ special: 'latest' })
        expect(detectFastTimeIntent('go to the earliest date')).toMatchObject({ special: 'earliest' })
        expect(detectFastTimeIntent('show me the layers')).toBe(null)
    })
})
