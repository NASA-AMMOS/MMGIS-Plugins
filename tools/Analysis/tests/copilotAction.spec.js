import fs from 'fs'
import path from 'path'
import { test, expect } from '@playwright/test'
import {
    ANALYSIS_COPILOT_ACTION_DESCRIPTOR,
    ANALYSIS_COPILOT_PLUGIN_ID,
    createAnalysisCopilotHandler,
    getAnalysisCopilotAvailability,
    registerAnalysisCopilotAction,
    resolveAnalysisLayer,
    unregisterAnalysisCopilotAction,
} from '../copilotAction'

function makeAnalysis(overrides = {}) {
    const calls = []
    return {
        calls,
        copilotPanelOpen: true,
        apiBaseUrl: 'https://analysis.example.test',
        currentMode: 'point',
        availableLayers: {
            temperature_key: {
                name: 'temperature',
                display_name: 'Surface Temperature',
            },
        },
        selectLayer(layer) {
            calls.push(['selectLayer', layer])
        },
        setMode(mode) {
            calls.push(['setMode', mode])
        },
        updateGenerateButtonState() {
            calls.push(['updateGenerateButtonState'])
        },
        ...overrides,
    }
}

function sourceFunction(source, name, nextName) {
    const start = source.indexOf(`    ${name}: function`)
    const end = source.indexOf(`    ${nextName}: function`, start + 1)
    expect(start, `${name} should exist`).toBeGreaterThanOrEqual(0)
    expect(end, `${nextName} should follow ${name}`).toBeGreaterThan(start)
    return source.slice(start, end)
}

test.describe('@unit Analysis Copilot adapter', () => {
    test('publishes a bounded configure-only capability', () => {
        expect(ANALYSIS_COPILOT_ACTION_DESCRIPTOR).toEqual(
            expect.objectContaining({
                name: 'configure_analysis',
                plugin: ANALYSIS_COPILOT_PLUGIN_ID,
                category: 'analytics',
            })
        )
        expect(
            ANALYSIS_COPILOT_ACTION_DESCRIPTOR.parameters.additionalProperties
        ).toBe(false)
        expect(ANALYSIS_COPILOT_ACTION_DESCRIPTOR.description).toContain(
            'user remains responsible'
        )
    })

    test('resolves aliases but returns the exact catalog key to Analysis', async () => {
        const analysis = makeAnalysis()
        const result = await createAnalysisCopilotHandler(analysis)({
            layer_name: 'surface temperature',
            mode: 'bbox',
        })

        expect(result).toEqual(
            expect.objectContaining({
                ok: true,
                data: {
                    layer: 'temperature_key',
                    mode: 'bbox',
                    requiresManualGeneration: true,
                },
            })
        )
        expect(analysis.calls).toEqual([
            ['selectLayer', 'temperature_key'],
            ['setMode', 'bbox'],
            ['updateGenerateButtonState'],
        ])
    })

    test('rejects ambiguous aliases instead of taking the first match', () => {
        const result = resolveAnalysisLayer(
            {
                one: { displayName: 'Temperature' },
                two: { display_name: 'Temperature' },
            },
            'temperature'
        )
        expect(result).toEqual({
            ok: false,
            code: 'ANALYSIS_LAYER_AMBIGUOUS',
            candidates: ['one', 'two'],
        })
    })

    test('rejects unsupported modes without calling the ordinary setMode API', async () => {
        const analysis = makeAnalysis()
        const result = await createAnalysisCopilotHandler(analysis)({
            layer_name: 'temperature_key',
            mode: 'unsupported',
        })
        expect(result.error.code).toBe('ANALYSIS_MODE_UNSUPPORTED')
        expect(analysis.calls).toEqual([])
    })

    test('degrades gracefully when Analysis is closed or unconfigured', async () => {
        const closed = makeAnalysis({ copilotPanelOpen: false })
        expect(getAnalysisCopilotAvailability(closed)).toEqual({
            available: false,
            reason: 'Open the Analysis tool before configuring it with Copilot.',
        })
        const result = await createAnalysisCopilotHandler(closed)({
            layer_name: 'temperature_key',
        })
        expect(result.error.code).toBe('ANALYSIS_TOOL_UNAVAILABLE')
        expect(closed.calls).toEqual([])

        expect(
            getAnalysisCopilotAvailability(
                makeAnalysis({ apiBaseUrl: '' })
            )
        ).toEqual({
            available: false,
            reason: 'The Analysis service is not configured for this mission.',
        })
    })

    test('loads an empty catalog through the existing public fetchLayers API', async () => {
        const analysis = makeAnalysis({
            availableLayers: {},
            async fetchLayers() {
                this.availableLayers = {
                    salinity: { displayName: 'Sea Salinity' },
                }
            },
        })
        const result = await createAnalysisCopilotHandler(analysis)({
            layer_name: 'Sea Salinity',
        })
        expect(result.ok).toBe(true)
        expect(analysis.calls[0]).toEqual(['selectLayer', 'salinity'])
    })

    test('registers through mmgisAPI and unregisters the returned registration', () => {
        const analysis = makeAnalysis()
        const registration = Object.freeze({ id: 'opaque-registration' })
        const api = {
            registerCopilotAction(descriptor, handler, availability, options) {
                expect(descriptor).toBe(ANALYSIS_COPILOT_ACTION_DESCRIPTOR)
                expect(typeof handler).toBe('function')
                expect(availability()).toBe(true)
                expect(options).toEqual({
                    returnHandle: true,
                    replaceExisting: true,
                })
                return registration
            },
            unregisterCopilotAction(value) {
                expect(value).toBe(registration)
                return true
            },
        }
        expect(registerAnalysisCopilotAction(api, analysis)).toBe(registration)
        expect(unregisterAnalysisCopilotAction(api, registration)).toBe(true)
        expect(registerAnalysisCopilotAction({}, analysis)).toBeNull()
    })

    test('keeps ordinary selectLayer, setMode, and destroy semantics unchanged', () => {
        const filename = path.resolve(
            process.cwd(),
            'plugins/NASA-AMMOS--MMGIS-Plugins/tools/Analysis/AnalysisTool.js'
        )
        const source = fs.readFileSync(filename, 'utf8')
        const selectLayer = sourceFunction(
            source,
            'selectLayer',
            'updateLayerInfoDisplay'
        )
        expect(selectLayer).toContain(
            'if (!layerName || !this.availableLayers[layerName])'
        )
        expect(selectLayer).toContain(
            'const layerInfo = this.availableLayers[layerName]'
        )
        expect(selectLayer).not.toContain('toLowerCase')
        expect(selectLayer).not.toContain('Object.entries')

        const setMode = sourceFunction(source, 'setMode', 'setupMapInteraction')
        expect(setMode).toContain('this.currentMode = mode')
        expect(setMode).not.toContain('return false')

        const destroy = sourceFunction(source, 'destroy', 'registerCopilotAction')
        expect(destroy).toContain('this.MMGISInterface.separateFromMMGIS()')
        expect(destroy).not.toContain('this.MMGISInterface?.')
        expect(destroy).not.toContain('this.MMGISInterface = null')
    })
})
