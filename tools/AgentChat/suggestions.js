import suggestionConfig from '../../backend/Agent/config/copilot_demo_queries.json'
import {
    assessLayerAnalysisCompatibility,
    isUserFacingLayer,
    isLayerVisible,
} from './analysisCompatibility'

function cleanStrings(values) {
    return Array.from(
        new Set(
            (Array.isArray(values) ? values : [])
                .map((value) =>
                    typeof value === 'string' ? value.trim() : ''
                )
                .filter(Boolean)
        )
    )
}

function interpolate(template, values) {
    return String(template || '').replace(
        /\{([a-zA-Z0-9_]+)\}/g,
        (_match, key) => String(values[key] ?? '')
    )
}

function layerName(layer) {
    const config = layer?.config || layer?.layer?.config || layer || {}
    return (
        layer?.displayName ||
        layer?.display_name ||
        config.display_name ||
        config.displayName ||
        config.name ||
        ''
    )
}

export function historyText(entry) {
    return String(entry?.reply || entry?.text || entry?.content || '')
}

export function sanitizeDemoQueries(payload) {
    return cleanStrings(payload?.queries)
}

export function getConfiguredDemoQueries(payload = suggestionConfig) {
    const parsed = sanitizeDemoQueries(payload)
    return parsed.length ? parsed : sanitizeDemoQueries(suggestionConfig)
}

export function buildAllZoomGrammarExamples(config = suggestionConfig) {
    const zoom = config?.zoom || {}
    const regions = Array.isArray(zoom.regions) ? zoom.regions : []
    const levels = Array.isArray(zoom.levels) ? zoom.levels : []
    const grammar = cleanStrings(zoom.grammar)
    const results = []
    for (const region of regions) {
        const name = typeof region === 'string' ? region : region?.name
        if (!name) continue
        for (const template of grammar) {
            if (template.includes('{zoom}')) {
                for (const level of levels) {
                    results.push(
                        interpolate(template, { region: name, zoom: level })
                    )
                }
            } else {
                results.push(interpolate(template, { region: name }))
            }
        }
    }
    return cleanStrings(results)
}

export function buildZoomSuggestions({
    config = suggestionConfig,
    random = Math.random,
} = {}) {
    const zoom = config?.zoom || {}
    const regions = Array.isArray(zoom.regions) ? zoom.regions : []
    const levels = Array.isArray(zoom.levels) ? zoom.levels : []
    const grammar = cleanStrings(zoom.grammar)
    if (!regions.length || !grammar.length) return []
    return cleanStrings(
        regions.map((region, index) => {
            const name = typeof region === 'string' ? region : region?.name
            if (!name) return ''
            const pick = Math.max(
                0,
                Math.min(
                    grammar.length - 1,
                    Math.floor(Number(random()) * grammar.length)
                )
            )
            const template = grammar[(pick + index) % grammar.length]
            const configuredZoom = Number(region?.defaultZoom)
            const level = Number.isFinite(configuredZoom)
                ? configuredZoom
                : levels[index % Math.max(1, levels.length)] || 4
            return interpolate(template, { region: name, zoom: level })
        })
    )
}

export function buildDynamicLayerSuggestions(
    layers,
    { config = suggestionConfig, onState = null, tools = null } = {}
) {
    const templates = config?.dynamicTemplates || {}
    const userLayers = (Array.isArray(layers) ? layers : []).filter(
        isUserFacingLayer
    )
    const catalog = userLayers.map((layer) => ({
        layer,
        name: layerName(layer),
        visible: isLayerVisible(layer, onState),
        compatibility: assessLayerAnalysisCompatibility(layer, {
            onState,
            ...(Array.isArray(tools) ? { tools } : {}),
        }),
    }))
    const analyzable = catalog.filter(
        (entry) => entry.name && entry.compatibility.supported
    )
    const visibleAnalyzable = analyzable.filter((entry) => entry.visible)
    const primary = visibleAnalyzable[0] || analyzable[0]
    const suggestions = []
    if (primary) {
        for (const template of cleanStrings(templates.visibleAnalyzable)) {
            suggestions.push(interpolate(template, { layer: primary.name }))
        }
        const configForLayer =
            primary.layer?.config || primary.layer?.layer?.config || primary.layer
        if (configForLayer?.time?.enabled === true) {
            for (const template of cleanStrings(templates.timeEnabled)) {
                suggestions.push(interpolate(template, { layer: primary.name }))
            }
        }
    }
    if (analyzable.length >= 2) {
        for (const template of cleanStrings(templates.comparison)) {
            suggestions.push(
                interpolate(template, {
                    layerA: analyzable[0].name,
                    layerB: analyzable[1].name,
                })
            )
        }
    }
    if (!suggestions.length) suggestions.push(...cleanStrings(templates.fallback))
    return cleanStrings(suggestions)
}

export function getCopilotSuggestionPool(
    layers = [],
    {
        config = suggestionConfig,
        onState = null,
        random = Math.random,
        tools = null,
    } = {}
) {
    return cleanStrings([
        ...getConfiguredDemoQueries(config),
        ...buildZoomSuggestions({ config, random }),
        ...buildDynamicLayerSuggestions(layers, { config, onState, tools }),
    ])
}

export function buildContextualSuggestions(
    history,
    layers,
    { config = suggestionConfig, onState = null, tools = null } = {}
) {
    const recent = (Array.isArray(history) ? history : []).slice(-6)
    const user = [...recent].reverse().find((entry) => entry?.role === 'user')
    const assistant = [...recent]
        .reverse()
        .find((entry) => entry?.role === 'assistant')
    const combined = `${historyText(user)} ${historyText(assistant)}`.toLowerCase()
    const groups = config?.contextualQueries || {}
    const suggestions = []
    if (/\blayers?\b/.test(combined)) suggestions.push(...cleanStrings(groups.layers))
    if (/\b(time|date|temporal|animate)\b/.test(combined))
        suggestions.push(...cleanStrings(groups.time))
    if (
        /\b(analy(?:sis|ze|tic|tics)?|mean|average|statistics?|threshold|compare|difference)\b/.test(
            combined
        )
    )
        suggestions.push(...cleanStrings(groups.analysis))
    if (/\b(zoom|region|area|sea|ocean|map)\b/.test(combined))
        suggestions.push(...cleanStrings(groups.navigation))
    return cleanStrings([
        ...suggestions,
        ...buildDynamicLayerSuggestions(layers, { config, onState, tools }),
    ])
}

export function getSuggestionChipRange(config = suggestionConfig) {
    const min = Number(config?.suggestionChipRange?.min)
    const max = Number(config?.suggestionChipRange?.max)
    return {
        min: Number.isFinite(min) ? Math.max(0, Math.trunc(min)) : 5,
        max: Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 8,
    }
}

export { suggestionConfig }
