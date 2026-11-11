// @unit tests for the CopilotMCPBridge result verification (pure functions).
import { test, expect } from '@playwright/test'
import { verifyCommand, VERIFIED_TOOLS, HIGHLIGHT_OPERATORS } from '../verifiers'
import { diffSnapshots, summarizeSnapshot } from '../stateDiff'

function snapshot(overrides = {}) {
    return {
        mission: 'frozon',
        map: { center: { lat: 89.98, lng: 45 }, zoom: 2, bounds: [0, 0, 0, 0], crs: 'EPSG:3413' },
        time: { enabled: true, start: '2024-01-01T00:00:00Z', end: '2024-02-01T00:00:00Z', current: '2024-02-01T00:00:00Z' },
        layers: {
            swot: { name: 'SWOT freeboard', type: 'tile', visible: false, on_map: false, opacity: 1, time: { start: null, end: '2024-02-01T00:00:00Z' } },
            countries: { name: 'Polar Countries', type: 'vector', visible: true, on_map: true, opacity: 1, time: null },
        },
        highlight: { active: false, opacity: null, expression: null },
        overlays: {},
        animation_ui: false,
        tools: { active: null, separated: [], available: ['LayersTool', 'AgentChatTool', 'AnalysisTool'] },
        ...overrides,
    }
}

const withLayer = (base, id, patch) => ({ ...base, layers: { ...base.layers, [id]: { ...base.layers[id], ...patch } } })

test.describe('CopilotMCPBridge verifiers @unit', () => {
    test('every Copilot registry tool with a state change has a dedicated verifier', () => {
        for (const tool of ['toggle_layer', 'set_layer_opacity', 'zoom_to', 'set_time', 'threshold_highlight', 'highlight_toggle', 'highlight_clear', 'highlight_opacity', 'calculate_layer_mean', 'calculate_layer_difference', 'detect_anomalies', 'multilayer_statistics', 'temporal_trends', 'spatial_statistics', 'change_detection', 'time_series_animation', 'data_export', 'open_animation_tool', 'run_analysis', 'describe_layer']) {
            expect(VERIFIED_TOOLS).toContain(tool)
        }
    })

    test('a thrown handler error is a failure with its code', () => {
        const err = Object.assign(new Error('Layer "X" not found.'), { code: 'INVALID_INPUT' })
        expect(verifyCommand('toggle_layer', { error: err })).toMatchObject({ status: 'failed', verified: false, error: { code: 'INVALID_INPUT', message: 'Layer "X" not found.' } })
    })

    test('toggle_layer checks the layer visibility actually reached the requested value', () => {
        const before = snapshot()
        const ok = verifyCommand('toggle_layer', { before, after: withLayer(before, 'swot', { visible: true }), args: { name: 'SWOT freeboard', visible: true }, targetId: 'swot' })
        expect(ok).toMatchObject({ status: 'succeeded', verified: true })
        const stuck = verifyCommand('toggle_layer', { before, after: before, args: { name: 'SWOT freeboard', visible: true }, targetId: 'swot' })
        expect(stuck).toMatchObject({ status: 'failed', verified: false, error: { code: 'EXECUTION_FAILED' } })
        expect(stuck.error.message).toContain('hidden')
    })

    test('set_layer_opacity compares the resulting layer opacity', () => {
        const before = snapshot()
        const after = withLayer(before, 'countries', { opacity: 0.4 })
        expect(verifyCommand('set_layer_opacity', { before, after, args: { name: 'Polar Countries', opacity: 0.4 }, returnValue: { id: 'countries' } }).status).toBe('succeeded')
        expect(verifyCommand('set_layer_opacity', { before, after: before, args: { name: 'Polar Countries', opacity: 0.4 }, returnValue: { id: 'countries' } }).status).toBe('failed')
    })

    test('zoom_to: center/zoom must match; bbox must match where Leaflet fitBounds puts the map', () => {
        const before = snapshot()
        const moved = { ...before, map: { ...before.map, center: { lat: 72, lng: -150 }, zoom: 4 } }
        expect(verifyCommand('zoom_to', { before, after: moved, args: { center: [-150, 72], zoom: 4 } }).status).toBe('succeeded')
        // The handler "succeeded" but the map did not move (e.g. animation never ran).
        expect(verifyCommand('zoom_to', { before, after: before, args: { center: [-150, 72], zoom: 4 } }).status).toBe('failed')
        const fitted = { expected: { center: [-158.97, 73.27], zoom: 3.69 }, actual: { center: [-158.97, 73.27], zoom: 3.69 }, center_offset_px: 0, fitted: true }
        expect(verifyCommand('zoom_to', { before, after: before, args: { bbox: [-170, 65, -130, 80] }, extras: { bboxFit: fitted } }).status).toBe('succeeded')
        expect(verifyCommand('zoom_to', { before, after: before, args: { bbox: [-170, 65, -130, 80] }, extras: { bboxFit: { ...fitted, fitted: false } } }).status).toBe('failed')
        expect(verifyCommand('zoom_to', { before, after: before, args: { bbox: [-170, 65, -130, 80] }, extras: {} }).status).toBe('failed')
    })

    test('set_time: needs at least one updated layer; reports skipped layers', () => {
        const before = snapshot()
        const after = { ...withLayer(before, 'swot', { time: { start: null, end: '2024-03-01T00:00:00Z' } }), time: { ...before.time, end: '2024-03-01T00:00:00Z' } }
        const ok = verifyCommand('set_time', { before, after, returnValue: { ok: true, updates: [{ id: 'swot' }], skipped: [{ name: 'Land Mask', reason: 'not time-enabled' }] } })
        expect(ok).toMatchObject({ status: 'succeeded', verified: true })
        expect(ok.notes).toEqual(['Skipped Land Mask: not time-enabled'])
        const none = verifyCommand('set_time', { before, after: before, returnValue: { ok: false, lines: ['No time-enabled layers are visible.'] } })
        expect(none).toMatchObject({ status: 'no_effect', error: { message: 'No time-enabled layers are visible.' } })
    })

    test('threshold highlight: overlay with the handler expression; unsupported operators are reported, not hidden', () => {
        const before = snapshot()
        const after = { ...before, highlight: { active: true, opacity: 0.6, expression: '(b1>0.3)*1' } }
        expect(verifyCommand('threshold_highlight', { before, after, args: { operator: '>' }, returnValue: { found: true, operator: '>', expression: '(b1>0.3)*1' } })).toMatchObject({ status: 'succeeded', notes: [] })
        const between = verifyCommand('threshold_highlight', { before, after, args: { operator: 'between' }, returnValue: { found: true, operator: '>', expression: '(b1>0.3)*1' } })
        expect(between.status).toBe('succeeded')
        expect(between.notes[0]).toContain("operator 'between' was executed as '>'")
        expect(HIGHLIGHT_OPERATORS).toEqual(['>', '>=', '<', '<='])
        expect(verifyCommand('threshold_highlight', { before, after: before, args: { operator: '>' }, returnValue: { found: false } }).status).toBe('no_effect')
    })

    test('highlight opacity/toggle/clear check the overlay state; missing overlay is no_effect', () => {
        const active = snapshot({ highlight: { active: true, opacity: 0.3, expression: 'e' } })
        expect(verifyCommand('highlight_opacity', { before: active, after: active, args: { delta: -0.3 }, returnValue: { overlay: true, previous: 0.6, opacity: 0.3 } }).status).toBe('succeeded')
        const clamped = verifyCommand('highlight_opacity', { before: active, after: active, args: { delta: -0.9 }, returnValue: { overlay: true, previous: 0.6, opacity: 0.3 } })
        expect(clamped.notes[0]).toContain('clamped')
        expect(verifyCommand('highlight_toggle', { before: active, after: active, returnValue: { overlay: false } }).status).toBe('no_effect')
        const cleared = snapshot()
        expect(verifyCommand('highlight_clear', { before: active, after: cleared, returnValue: { overlay: true, cleared: true } }).status).toBe('succeeded')
        expect(verifyCommand('highlight_clear', { before: active, after: active, returnValue: { overlay: true, cleared: true } }).status).toBe('failed')
    })

    test('calculate_layer_mean / difference: values must equal the analytics API responses they came from', () => {
        const after = snapshot({ overlays: { mean: { features: 1 } } })
        const apiCalls = [{ method: 'GET', url: '/api/agent/analytics/statistics?mission=frozon', status: 200, body: { mean: 0.0788 } }]
        expect(verifyCommand('calculate_layer_mean', { after, apiCalls, returnValue: { source: 'server', stats: { mean: 0.0788 } } })).toMatchObject({ status: 'succeeded', verified: true })
        expect(verifyCommand('calculate_layer_mean', { after, apiCalls, returnValue: { source: 'server', stats: { mean: 0.5 } } }).status).toBe('failed')
        expect(verifyCommand('calculate_layer_mean', { after: snapshot(), apiCalls, returnValue: { source: 'server', stats: { mean: 0.0788 } } }).status).toBe('failed') // area not drawn
        expect(verifyCommand('calculate_layer_mean', { after, returnValue: { supported: false }, output: ['Layer is not analyzable.'] })).toMatchObject({ status: 'failed', error: { message: 'Layer is not analyzable.' } })
        const diffCalls = [{ url: '/api/agent/analytics/difference?x', status: 200, body: { mean: -0.17 } }]
        expect(verifyCommand('calculate_layer_difference', { after, apiCalls: diffCalls, returnValue: { mean: -0.17 } }).status).toBe('succeeded')
        expect(verifyCommand('calculate_layer_difference', { after, apiCalls: [], returnValue: { mean: -0.17 } }).status).toBe('failed')
    })

    test('simulated and synthetic Copilot handlers are labelled, never reported as verified data', () => {
        const anomalies = verifyCommand('detect_anomalies', { returnValue: { simulated: true } })
        expect(anomalies).toMatchObject({ status: 'succeeded', verified: null })
        expect(anomalies.notes[0]).toContain('SIMULATED')
        const exported = verifyCommand('data_export', { returnValue: { status: 'ready' } })
        expect(exported.notes[0]).toContain('SYNTHETIC')
    })

    test('in-browser analytics require results and the drawn analysis area', () => {
        const drawn = snapshot({ overlays: { 'multilayer-stats': { features: 1 }, 'temporal-trends': { features: 1 }, 'spatial-analysis': { features: 3 }, 'change-detection': { features: 1 } } })
        expect(verifyCommand('multilayer_statistics', { after: drawn, returnValue: {} }).status).toBe('succeeded')
        expect(verifyCommand('temporal_trends', { after: snapshot(), returnValue: {} }).status).toBe('failed')
        expect(verifyCommand('spatial_statistics', { after: snapshot(), args: { visualize: false }, returnValue: { spatialStats: {} } }).status).toBe('succeeded')
        expect(verifyCommand('change_detection', { after: drawn, args: {}, returnValue: {} }).status).toBe('succeeded')
        expect(verifyCommand('time_series_animation', { after: snapshot({ animation_ui: true }), returnValue: {} }).status).toBe('succeeded')
        expect(verifyCommand('time_series_animation', { after: snapshot(), returnValue: {} }).status).toBe('failed')
    })

    test('tool-opening actions are confirmed by the active tool; a tool missing from the mission is CAPABILITY_UNAVAILABLE', () => {
        const opened = snapshot({ tools: { active: 'AnalysisTool', separated: [], available: ['AnalysisTool'] } })
        expect(verifyCommand('run_analysis', { after: opened, output: ['Analysis Tool opened for: SWOT'] }).status).toBe('succeeded')
        expect(verifyCommand('run_analysis', { after: snapshot(), output: ['Analysis Tool is not available. Please open it from the toolbar.'] }).error.code).toBe('CAPABILITY_UNAVAILABLE')
        const missing = verifyCommand('open_animation_tool', { after: snapshot(), output: ['Animation Tool opened for: SWOT freeboard'] })
        expect(missing).toMatchObject({ status: 'failed', error: { code: 'CAPABILITY_UNAVAILABLE' } })
        expect(missing.error.message).toContain('not enabled for this mission')
        const animation = snapshot({ tools: { active: 'AnimationTool', separated: [], available: ['AnimationTool'] } })
        expect(verifyCommand('open_animation_tool', { after: animation }).status).toBe('succeeded')
    })

    test('read-only tools succeed with output; describe_layer flags the Copilot printing a wrong visibility', () => {
        expect(verifyCommand('list_layers', { output: ['Layers:\n- A (on)'] })).toMatchObject({ status: 'succeeded', verified: null })
        expect(verifyCommand('list_layers', { output: [] }).status).toBe('failed')
        const after = withLayer(snapshot(), 'swot', { visible: true })
        const described = verifyCommand('describe_layer', { after, output: ['Layer: SWOT freeboard', 'Visible: No'], returnValue: { found: true, id: 'swot', visible: false } })
        expect(described.status).toBe('succeeded')
        expect(described.notes.join(' ')).toContain('actually visible')
    })
})

test.describe('CopilotMCPBridge state diff @unit', () => {
    test('diffSnapshots lists exactly what changed', () => {
        const before = snapshot()
        const after = { ...withLayer(before, 'swot', { visible: true, on_map: true }), highlight: { active: true, opacity: 0.6, expression: 'e' } }
        const diff = diffSnapshots(before, after)
        expect(diff.layers).toEqual([{ uuid: 'swot', name: 'SWOT freeboard', visible: { from: false, to: true }, on_map: { from: false, to: true } }])
        expect(diff.highlight).toEqual({ from: before.highlight, to: after.highlight })
        expect(diff.map).toBeUndefined()
        expect(diffSnapshots(before, before)).toEqual({})
        expect(diffSnapshots(null, before)).toBe(null)
    })

    test('summarizeSnapshot keeps visible layers only', () => {
        const summary = summarizeSnapshot(snapshot())
        expect(Object.keys(summary.visible_layers)).toEqual(['countries'])
        expect(summary.layer_count).toBe(2)
        expect(summary.layers).toBeUndefined()
    })
})
