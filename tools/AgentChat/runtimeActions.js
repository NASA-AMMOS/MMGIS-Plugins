import { createToolResult } from './agentProtocol'

const SAFE_MMGIS_API_METHODS = new Set(['toggleLayer', 'setLayerOpacity'])

function clean(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function cleanAnalyticsList(values) {
    if (!Array.isArray(values)) return []
    return Array.from(
        new Set(values.map(clean).filter(Boolean).slice(0, 32))
    )
}

function normalizeAnalyticsMetadata(metadata) {
    if (!metadata || typeof metadata !== 'object') return null
    const operations = cleanAnalyticsList(metadata.operations)
    const dataKinds = cleanAnalyticsList(metadata.dataKinds)
    if (
        !operations.length &&
        !dataKinds.length &&
        typeof metadata.requiresScalar !== 'boolean'
    )
        return null
    return {
        ...(operations.length ? { operations } : {}),
        ...(dataKinds.length ? { dataKinds } : {}),
        ...(typeof metadata.requiresScalar === 'boolean'
            ? { requiresScalar: metadata.requiresScalar }
            : {}),
    }
}

export function normalizeRuntimeAction(action, index = 0) {
    if (!action || typeof action !== 'object') return null
    const name = clean(action.id || action.name || action.action)
    if (!name) return null
    const plugin = clean(
        action.plugin || action.pluginId || action.provider || action.namespace
    )
    const parameters =
        action.parameters && typeof action.parameters === 'object'
            ? action.parameters
            : { type: 'object', properties: {}, additionalProperties: true }
    return {
        name,
        displayName: clean(action.name) || name,
        description:
            clean(action.description) ||
            `Execute ${name}${plugin ? ` from ${plugin}` : ''}.`,
        category: clean(action.category) || 'plugin actions',
        plugin: plugin || null,
        analytics: normalizeAnalyticsMetadata(action.analytics),
        parameters,
        // The host action descriptor has one authoritative schema. Ignore any
        // legacy duplicate so model registration and execution validation
        // cannot drift apart.
        modelParameters: parameters,
        execution: {
            adapter: 'pluginAction',
            action: name,
            plugin: plugin || undefined,
        },
        order: Number.isFinite(action.order) ? action.order : index,
    }
}

export function isSafeMmgisApiMethod(method) {
    return SAFE_MMGIS_API_METHODS.has(clean(method))
}

export function mergeToolRegistries(runtimeTools = [], staticTools = []) {
    const merged = new Map()
    // Insert runtime capabilities first so bundled/static definitions replace
    // collisions, matching the backend registry's trust semantics.
    ;[...runtimeTools, ...staticTools].forEach((tool) => {
        if (tool?.name) merged.set(tool.name, tool)
    })
    return Array.from(merged.values())
}

export function toRuntimeCapabilityDescriptor(action) {
    if (!action?.name) return null
    return {
        name: action.name,
        id: action.name,
        displayName: action.displayName || action.name,
        plugin: action.plugin || null,
        description: action.description || '',
        category: action.category || 'plugin actions',
        ...(action.analytics ? { analytics: action.analytics } : {}),
        parameters: action.parameters || {
            type: 'object',
            properties: {},
            additionalProperties: true,
        },
    }
}

function firstOwnValue(source, keys) {
    if (!source || typeof source !== 'object') return undefined
    for (const key of keys) {
        if (
            key != null &&
            Object.prototype.hasOwnProperty.call(source, String(key))
        ) {
            return source[String(key)]
        }
    }
    return undefined
}

export function verifyMmgisFacadeResult({
    method,
    targetId,
    targetName,
    requestedVisible,
    requestedOpacity,
    visibleLayers,
    opacityByLayer,
    rawResult,
} = {}) {
    const keys = [targetId, targetName].filter(Boolean)
    if (method === 'toggleLayer') {
        const actual = firstOwnValue(visibleLayers, keys)
        const requested = requestedVisible === true
        if (typeof actual !== 'boolean' || actual !== requested) {
            return {
                ok: false,
                errorCode: 'LAYER_VISIBILITY_NOT_VERIFIED',
                message: `MMGIS could not verify that the layer is ${
                    requested ? 'visible' : 'hidden'
                }.`,
                data: { requested, actual: actual ?? null },
            }
        }
        return { ok: true, data: { visible: actual } }
    }
    if (method === 'setLayerOpacity') {
        const requested = Number(requestedOpacity)
        const fromState = firstOwnValue(opacityByLayer, keys)
        const actual = Number.isFinite(Number(fromState))
            ? Number(fromState)
            : Number(rawResult?.opacity)
        if (
            !Number.isFinite(requested) ||
            !Number.isFinite(actual) ||
            Math.abs(actual - requested) > 0.001
        ) {
            return {
                ok: false,
                errorCode: 'LAYER_OPACITY_NOT_VERIFIED',
                message: 'MMGIS could not verify the requested layer opacity.',
                data: {
                    requested: Number.isFinite(requested) ? requested : null,
                    actual: Number.isFinite(actual) ? actual : null,
                },
            }
        }
        return { ok: true, data: { opacity: actual } }
    }
    return { ok: true, data: null }
}

export async function listRegisteredCopilotActions(api) {
    if (!api) return []
    const providers = [
        [api.listCopilotActions, api],
        [api.getCopilotActions, api],
        [api.copilot?.listActions, api.copilot],
    ]
    let raw = []
    for (const [provider, owner] of providers) {
        if (typeof provider !== 'function') continue
        raw = await provider.call(owner, { availableOnly: true })
        break
    }
    if (raw && !Array.isArray(raw) && Array.isArray(raw.actions)) raw = raw.actions
    return (Array.isArray(raw) ? raw : [])
        .filter(
            (action) =>
                action?.available !== false &&
                action?.enabled !== false &&
                action?.isAvailable !== false
        )
        .map(normalizeRuntimeAction)
        .filter(Boolean)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
}

export async function executeRegisteredCopilotAction(
    api,
    action,
    args = {},
    context = {}
) {
    const name = clean(action?.name || action?.action || action)
    const callId = action?.callId || action?.id || null
    const executors = [
        [api?.executeCopilotAction, api],
        [api?.runCopilotAction, api],
        [api?.copilot?.executeAction, api?.copilot],
    ]
    const match = executors.find(([executor]) => typeof executor === 'function')
    if (!name || !match) {
        return createToolResult({
            tool: name || 'plugin_action',
            callId,
            ok: false,
            message: `Plugin action "${name || 'unknown'}" is unavailable.`,
            errorCode: 'PLUGIN_ACTION_UNAVAILABLE',
        })
    }
    try {
        const raw = await match[0].call(match[1], name, args || {}, context)
        if (raw && typeof raw === 'object' && raw.ok === false) {
            return createToolResult({
                tool: name,
                callId,
                ok: false,
                message: raw.message,
                data: raw.data,
                errorCode: raw.errorCode || raw.error?.code,
                errorMessage: raw.error?.message || raw.message,
            })
        }
        return createToolResult({
            tool: name,
            callId,
            ok: true,
            message:
                clean(raw?.message) ||
                clean(raw?.reply) ||
                `Plugin action "${name}" completed successfully.`,
            data: raw?.data !== undefined ? raw.data : raw,
        })
    } catch (error) {
        console.error(`Copilot plugin action "${name}" failed`, error)
        const publicMessage = clean(error?.publicMessage)
        return createToolResult({
            tool: name,
            callId,
            ok: false,
            message:
                publicMessage ||
                `Plugin action "${name}" could not be completed.`,
            errorCode: error?.code || 'PLUGIN_ACTION_FAILED',
            errorMessage:
                publicMessage ||
                `Plugin action "${name}" could not be completed.`,
        })
    }
}
