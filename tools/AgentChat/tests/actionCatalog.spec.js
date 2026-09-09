import { test, expect } from '@playwright/test'
import { createAgentActionCatalog, setAgentLayerOpacity } from '../actionCatalog'

function fixture() {
    const selected = []
    const analysis = {
        apiBaseUrl: '/analysis', currentMode: 'point',
        availableLayers: {
            ice: { displayName: 'Sea ice' },
            ice2: { displayName: 'Sea ice' },
            temp: { displayName: 'Temperature' },
        },
        selectLayer: (key) => selected.push(key),
        setMode: (mode) => { analysis.currentMode = mode },
    }
    const controller = {
        tools: [{ name: 'Analysis' }, { name: 'Animation' }],
        toolModules: { AnalysisTool: analysis, AnimationTool: {} },
        activeToolName: 'AnalysisTool', activeSeparatedTools: [],
        openTool(name) { this.activeToolName = `${name}Tool` },
    }
    return { analysis, controller, selected }
}

test.describe('@unit Agent-owned tool adapters', () => {
    test('offers only configured, loaded and currently usable tools', () => {
        const { controller, analysis } = fixture()
        const catalog = createAgentActionCatalog(controller)
        expect(catalog.list().map((a) => a.name)).toEqual(['configure_analysis', 'open_animation_tool'])
        analysis.apiBaseUrl = ''
        expect(catalog.list().map((a) => a.name)).toEqual(['open_animation_tool'])
        controller.tools = []
        expect(catalog.list()).toEqual([])
        controller.tools = [{ name: 'Animation' }]
        controller.toolModules = {}
        expect(catalog.list()).toEqual([])
    })

    test('uses the existing Analysis methods without adding fields to the tool', async () => {
        const { controller, analysis, selected } = fixture()
        const keys = Object.keys(analysis)
        const result = await createAgentActionCatalog(controller).execute('configure_analysis', {
            layer_name: 'temperature', mode: 'bbox',
        })
        expect(result).toMatchObject({ ok: true, data: { layer: 'temp', mode: 'bbox', requiresManualGeneration: true } })
        expect(selected).toEqual(['temp'])
        expect(Object.keys(analysis)).toEqual(keys)
    })

    test('rejects ambiguous aliases and accepts an exact catalog key', async () => {
        const { controller, selected } = fixture()
        const catalog = createAgentActionCatalog(controller)
        expect(await catalog.execute('configure_analysis', { layer_name: 'Sea ice' })).toMatchObject({
            ok: false, error: { code: 'ANALYSIS_LAYER_AMBIGUOUS' },
        })
        expect(selected).toEqual([])
        expect((await catalog.execute('configure_analysis', { layer_name: 'ice' })).ok).toBe(true)
    })

    test('rejects malformed model arguments before mutating a tool', async () => {
        const { controller, selected } = fixture()
        const catalog = createAgentActionCatalog(controller)
        for (const args of [{}, { layer_name: 4 }, { layer_name: 'ice', mode: 'unsupported' }, { layer_name: 'ice', extra: true }]) {
            expect(await catalog.execute('configure_analysis', args)).toMatchObject({ ok: false, errorCode: 'INVALID_ARGUMENTS' })
        }
        expect(selected).toEqual([])
    })

    test('rechecks availability when the panel closes between discovery and dispatch', async () => {
        const { controller, selected } = fixture()
        const catalog = createAgentActionCatalog(controller)
        expect(catalog.list()).toHaveLength(2)
        controller.activeToolName = null
        expect(await catalog.execute('configure_analysis', { layer_name: 'ice' })).toMatchObject({ ok: false, errorCode: 'ACTION_UNAVAILABLE' })
        expect(selected).toEqual([])
    })

    test('detects separated panels and opens Animation through ToolController', async () => {
        const { controller } = fixture()
        controller.activeToolName = null
        controller.activeSeparatedTools = ['AnalysisTool']
        const catalog = createAgentActionCatalog(controller)
        expect(catalog.list()).toHaveLength(2)
        expect(await catalog.execute('open_animation_tool')).toMatchObject({ ok: true, data: { open: true } })
        expect(controller.activeToolName).toBe('AnimationTool')
        expect(await catalog.execute('arbitrary_tool')).toMatchObject({ ok: false })
    })

    test('cancellation prevents a late catalog fetch from configuring Analysis', async () => {
        const { controller, analysis, selected } = fixture()
        let finish
        analysis.availableLayers = {}
        analysis.fetchLayers = () => new Promise((resolve) => { finish = resolve })
        const abort = new AbortController()
        const pending = createAgentActionCatalog(controller).execute('configure_analysis', { layer_name: 'ice' }, { signal: abort.signal })
        await Promise.resolve()
        abort.abort()
        await expect(pending).rejects.toThrow(/cancelled/)
        analysis.availableLayers = { ice: {} }
        finish()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(selected).toEqual([])
    })

    test('times out a stalled handler and rejects oversized results', async () => {
        const { controller, analysis } = fixture()
        let finish
        analysis.availableLayers = {}
        analysis.fetchLayers = () => new Promise((resolve) => { finish = resolve })
        await expect(createAgentActionCatalog(controller, { timeoutMs: 5 }).execute('configure_analysis', { layer_name: 'ice' })).rejects.toThrow(/timed out/)
        finish()
        await expect(createAgentActionCatalog(controller, { maxResultBytes: 10 }).execute('open_animation_tool')).rejects.toThrow(/too large/)
    })

    test('validates opacity locally and calls the existing Layers singleton', () => {
        const layers = {
            asLayerUUID: (name) => name === 'ice' ? 'uuid' : null,
            layers: { data: { uuid: {} }, opacity: { uuid: 1 } },
            setLayerOpacity(id, opacity) { this.layers.opacity[id] = opacity },
        }
        for (const value of [-1, 2, NaN, '0.5']) expect(() => setAgentLayerOpacity(layers, 'ice', value)).toThrow()
        expect(() => setAgentLayerOpacity(layers, 'missing', 0.5)).toThrow()
        expect(setAgentLayerOpacity(layers, 'ice', 0.5)).toEqual({ opacity: 0.5 })
    })
})
