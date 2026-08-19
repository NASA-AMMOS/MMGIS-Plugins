export const ANALYSIS_COPILOT_PLUGIN_ID =
    'NASA-AMMOS--MMGIS-Plugins/tools/Analysis'
export const ANALYSIS_COPILOT_ACTION_NAME = 'configure_analysis'

const SUPPORTED_MODES = Object.freeze([
    'point',
    'bbox',
    'line',
    'vectorpoints',
])
const DEFAULT_LAYER_LOAD_TIMEOUT_MS = 10000

export const ANALYSIS_COPILOT_ACTION_DESCRIPTOR = Object.freeze({
    name: ANALYSIS_COPILOT_ACTION_NAME,
    plugin: ANALYSIS_COPILOT_PLUGIN_ID,
    category: 'analytics',
    description:
        'Configure the open Analysis panel with an unambiguous layer and supported spatial mode. The user remains responsible for reviewing spatial and temporal inputs and generating the analysis.',
    parameters: Object.freeze({
        type: 'object',
        additionalProperties: false,
        required: Object.freeze(['layer_name']),
        properties: Object.freeze({
            layer_name: Object.freeze({
                type: 'string',
                minLength: 1,
                description:
                    'Configured Analysis layer key or an unambiguous display name.',
            }),
            mode: Object.freeze({
                type: 'string',
                enum: SUPPORTED_MODES,
                description:
                    "Spatial input mode. Defaults to the panel's current mode.",
            }),
        }),
    }),
    analytics: Object.freeze({
        operations: Object.freeze(['configure']),
        dataKinds: Object.freeze(['analysis-service-layer']),
        requiresScalar: false,
    }),
})

function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

function failure(message, code, data = null) {
    return { ok: false, message, data, error: { code } }
}

function layerAliases(key, value) {
    return [
        key,
        value?.key,
        value?.name,
        value?.display_name,
        value?.displayName,
    ].filter((entry) => typeof entry === 'string' && entry.trim())
}

/**
 * Resolve user-facing text to one exact Analysis catalog key. The Analysis
 * tool's own selectLayer method deliberately retains its exact-key behavior;
 * Copilot-only fuzzy resolution stays in this adapter.
 */
export function resolveAnalysisLayer(availableLayers, requestedName) {
    if (
        availableLayers == null ||
        typeof availableLayers !== 'object' ||
        Array.isArray(availableLayers)
    ) {
        return { ok: false, code: 'ANALYSIS_LAYER_CATALOG_UNAVAILABLE' }
    }

    const requested = String(requestedName || '').trim()
    if (!requested) return { ok: false, code: 'ANALYSIS_LAYER_REQUIRED' }
    if (Object.hasOwn(availableLayers, requested)) {
        return { ok: true, key: requested }
    }

    const normalized = normalizeName(requested)
    const matches = Object.entries(availableLayers)
        .filter(([key, value]) =>
            layerAliases(key, value).some(
                (candidate) => normalizeName(candidate) === normalized
            )
        )
        .map(([key]) => key)

    if (matches.length === 1) return { ok: true, key: matches[0] }
    if (matches.length > 1) {
        return {
            ok: false,
            code: 'ANALYSIS_LAYER_AMBIGUOUS',
            candidates: matches,
        }
    }
    return { ok: false, code: 'ANALYSIS_LAYER_NOT_FOUND' }
}

export function getAnalysisCopilotAvailability(analysisTool) {
    if (!analysisTool?.copilotPanelOpen) {
        return {
            available: false,
            reason: 'Open the Analysis tool before configuring it with Copilot.',
        }
    }
    if (!analysisTool.apiBaseUrl) {
        return {
            available: false,
            reason: 'The Analysis service is not configured for this mission.',
        }
    }
    return true
}

function withTimeout(promise, timeoutMs) {
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error('Analysis layer catalog timed out.')),
            timeoutMs
        )
    })
    return Promise.race([Promise.resolve(promise), timeout]).finally(() =>
        clearTimeout(timer)
    )
}

export function createAnalysisCopilotHandler(analysisTool, options = {}) {
    const timeoutMs =
        Number.isFinite(options.layerLoadTimeoutMs) &&
        options.layerLoadTimeoutMs > 0
            ? options.layerLoadTimeoutMs
            : DEFAULT_LAYER_LOAD_TIMEOUT_MS

    return async (args = {}) => {
        const availability = getAnalysisCopilotAvailability(analysisTool)
        if (availability !== true) {
            return failure(
                availability.reason,
                'ANALYSIS_TOOL_UNAVAILABLE'
            )
        }

        const requestedLayer = String(args.layer_name || '').trim()
        if (!requestedLayer) {
            return failure(
                'Choose a layer before configuring the Analysis tool.',
                'ANALYSIS_LAYER_REQUIRED'
            )
        }

        if (Object.keys(analysisTool.availableLayers || {}).length === 0) {
            if (typeof analysisTool.fetchLayers !== 'function') {
                return failure(
                    'The Analysis layer catalog is unavailable.',
                    'ANALYSIS_LAYER_CATALOG_UNAVAILABLE'
                )
            }
            try {
                await withTimeout(analysisTool.fetchLayers(), timeoutMs)
            } catch (_error) {
                return failure(
                    'The Analysis layer catalog could not be loaded.',
                    'ANALYSIS_LAYER_CATALOG_UNAVAILABLE'
                )
            }
        }

        const resolution = resolveAnalysisLayer(
            analysisTool.availableLayers,
            requestedLayer
        )
        if (!resolution.ok) {
            if (resolution.code === 'ANALYSIS_LAYER_AMBIGUOUS') {
                return failure(
                    `More than one Analysis layer matches "${requestedLayer}". Choose one exact layer key.`,
                    resolution.code,
                    { candidates: resolution.candidates }
                )
            }
            return failure(
                `Analysis layer "${requestedLayer}" is not available.`,
                resolution.code
            )
        }

        const mode = args.mode || analysisTool.currentMode || 'point'
        if (!SUPPORTED_MODES.includes(mode)) {
            return failure(
                `Analysis mode "${mode}" is not supported.`,
                'ANALYSIS_MODE_UNSUPPORTED'
            )
        }

        analysisTool.selectLayer(resolution.key)
        analysisTool.setMode(mode)
        analysisTool.updateGenerateButtonState?.()

        return {
            ok: true,
            message: `Analysis is configured for ${resolution.key} in ${mode} mode. Review the spatial and temporal inputs, then generate the analysis.`,
            data: {
                layer: resolution.key,
                mode,
                requiresManualGeneration: true,
            },
            error: null,
        }
    }
}

export function registerAnalysisCopilotAction(api, analysisTool, options = {}) {
    if (typeof api?.registerCopilotAction !== 'function') return null
    return api.registerCopilotAction(
        ANALYSIS_COPILOT_ACTION_DESCRIPTOR,
        createAnalysisCopilotHandler(analysisTool, options),
        () => getAnalysisCopilotAvailability(analysisTool),
        { returnHandle: true, replaceExisting: true }
    )
}

export function unregisterAnalysisCopilotAction(api, registration) {
    if (
        registration == null ||
        typeof api?.unregisterCopilotAction !== 'function'
    )
        return false
    return typeof registration === 'string'
        ? api.unregisterCopilotAction(
              registration,
              ANALYSIS_COPILOT_PLUGIN_ID
          )
        : api.unregisterCopilotAction(registration)
}
