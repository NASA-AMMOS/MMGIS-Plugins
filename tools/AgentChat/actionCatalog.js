import Ajv from 'ajv'
import {
    ANALYSIS_COPILOT_ACTION_DESCRIPTOR,
    createAnalysisCopilotHandler,
    getAnalysisCopilotAvailability,
} from './analysisAdapter'

// Agent owns knowledge of the tools it drives. Optional tools never register
// with Agent and do not need to import it or expose anything on window.
export function loadedAgentTool(controller, name) {
    if (!controller?.tools?.some((tool) => tool.name === name)) return null
    return controller.toolModules?.[`${name}Tool`] || null
}

export function isAgentToolOpen(controller, name) {
    const moduleName = `${name}Tool`
    return !!loadedAgentTool(controller, name) && (
        controller.activeToolName === moduleName ||
        controller.activeSeparatedTools?.includes(moduleName) === true
    )
}

export function openAgentTool(controller, name) {
    if (loadedAgentTool(controller, name)) controller.openTool(name)
    return isAgentToolOpen(controller, name)
        ? { ok: true, message: `Opened the ${name} tool.`, data: { open: true } }
        : { ok: false, message: `The ${name} tool is unavailable in this mission.`,
            errorCode: 'TOOL_UNAVAILABLE' }
}

export function setAgentLayerOpacity(layers, layer, opacity) {
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new TypeError('Layer opacity must be a number between 0 and 1.')
    const id = layers.asLayerUUID(layer)
    if (!id || !layers.layers?.data?.[id]) throw new Error('Layer is unavailable.')
    layers.setLayerOpacity(id, opacity)
    return { opacity: layers.layers.opacity[id] }
}

export function createAgentActionCatalog(controller, { timeoutMs = 10000, maxResultBytes = 65536 } = {}) {
    const isAnalysisOpen = () => isAgentToolOpen(controller, 'Analysis')
    const entries = [
        {
            descriptor: ANALYSIS_COPILOT_ACTION_DESCRIPTOR,
            available: () => getAnalysisCopilotAvailability(
                loadedAgentTool(controller, 'Analysis'), isAnalysisOpen
            ) === true,
            run: (args, context) => createAnalysisCopilotHandler(
                loadedAgentTool(controller, 'Analysis'), { isOpen: isAnalysisOpen }
            )(args, context),
        },
        {
            descriptor: {
                name: 'open_animation_tool', category: 'temporal',
                description: 'Open the Animation tool so the user can configure and export an animation.',
                parameters: { type: 'object', properties: {}, additionalProperties: false },
            },
            available: () => !!loadedAgentTool(controller, 'Animation'),
            run: () => openAgentTool(controller, 'Animation'),
        },
    ]
    const ajv = new Ajv({ strict: false })
    for (const entry of entries) entry.validate = ajv.compile(entry.descriptor.parameters)
    return {
        list: () => entries.filter((entry) => entry.available()).map((entry) => entry.descriptor),
        async execute(name, args = {}, context = {}) {
            const entry = entries.find((item) => item.descriptor.name === name)
            if (!entry?.available()) return {
                ok: false, message: 'This action is no longer available.',
                errorCode: 'ACTION_UNAVAILABLE',
            }
            if (!entry.validate(args)) return {
                ok: false, message: 'The action arguments are invalid.', errorCode: 'INVALID_ARGUMENTS',
            }
            const abort = new AbortController()
            const cancelled = () => abort.abort(context.signal?.reason)
            context.signal?.addEventListener('abort', cancelled, { once: true })
            if (context.signal?.aborted) cancelled()
            let timer
            let onAbort
            try {
                const stopped = new Promise((_, reject) => {
                    onAbort = () => reject(new Error('Action cancelled or timed out.'))
                    abort.signal.addEventListener('abort', onAbort, { once: true })
                    if (abort.signal.aborted) onAbort()
                    timer = setTimeout(() => abort.abort(), timeoutMs)
                })
                const result = await Promise.race([
                    stopped,
                    Promise.resolve().then(() => {
                        abort.signal.throwIfAborted()
                        return entry.run(args, { ...context, signal: abort.signal })
                    }),
                ])
                // Bound handler output before it can enter a model prompt.
                if (new TextEncoder().encode(JSON.stringify(result)).length > maxResultBytes)
                    throw new Error('Action result is too large.')
                return result
            } finally {
                clearTimeout(timer)
                abort.signal.removeEventListener('abort', onAbort)
                context.signal?.removeEventListener('abort', cancelled)
            }
        },
    }
}
