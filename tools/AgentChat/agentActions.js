/* Shared MMGIS Copilot action helpers.

   Layer indexing, layer-name resolution for planned actions, display-name to
   layer-id lookup, mission conflict rules, the layer context sent to the
   planner and the local-command detectors, used by the AgentChat tool and by
   other plugins in this container (e.g. the CopilotMCPBridge component) so that
   both execute Copilot actions with identical semantics. The logic was moved
   verbatim from AgentChatTool.js; only closure state became parameters. This
   module has no webpack-only imports, so it can be unit tested under Node.
*/

import { getLayerTimeMetadata } from './timeUtils'
import { normalizeLayerText, resolveLayerSelection } from './layerResolver'

export const LAYER_ARG_KEYS = ['name', 'layer_name', 'layer_a', 'layer_b']

export function normalizeName(value) {
    return normalizeLayerText(value)
}

function toNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
}

function latLngBoundsToBbox(bounds) {
    if (!bounds) return null
    const sw =
        typeof bounds.getSouthWest === 'function'
            ? bounds.getSouthWest()
            : bounds._southWest
    const ne =
        typeof bounds.getNorthEast === 'function'
            ? bounds.getNorthEast()
            : bounds._northEast
    if (!sw || !ne) return null
    const west = toNumber(sw.lng)
    const south = toNumber(sw.lat)
    const east = toNumber(ne.lng)
    const north = toNumber(ne.lat)
    if ([west, south, east, north].every((v) => v != null))
        return [west, south, east, north]
    return null
}

function normalizeBoundingBox(raw) {
    if (!raw) return null
    if (Array.isArray(raw) && raw.length >= 4) {
        const west = toNumber(raw[0])
        const south = toNumber(raw[1])
        const east = toNumber(raw[2])
        const north = toNumber(raw[3])
        if ([west, south, east, north].every((v) => v != null))
            return [west, south, east, north]
        return null
    }
    if (typeof raw === 'object') {
        if (raw._southWest && raw._northEast) {
            return latLngBoundsToBbox(raw)
        }
        const west =
            toNumber(raw.west) ??
            toNumber(raw.minLon) ??
            toNumber(raw.minX) ??
            toNumber(raw.xmin)
        const south =
            toNumber(raw.south) ??
            toNumber(raw.minLat) ??
            toNumber(raw.minY) ??
            toNumber(raw.ymin)
        const east =
            toNumber(raw.east) ??
            toNumber(raw.maxLon) ??
            toNumber(raw.maxX) ??
            toNumber(raw.xmax)
        const north =
            toNumber(raw.north) ??
            toNumber(raw.maxLat) ??
            toNumber(raw.maxY) ??
            toNumber(raw.ymax)
        if ([west, south, east, north].every((v) => v != null))
            return [west, south, east, north]
    }
    return null
}

function deriveLayerBoundingBox(layerConfig, layerInstance) {
    let bbox =
        normalizeBoundingBox(layerConfig?.boundingBox) ||
        normalizeBoundingBox(layerConfig?.bounds) ||
        normalizeBoundingBox(layerConfig?.extent) ||
        normalizeBoundingBox(layerConfig?.bbox)
    if (!bbox && layerInstance) {
        if (typeof layerInstance.getBounds === 'function') {
            bbox = normalizeBoundingBox(layerInstance.getBounds())
        } else if (layerInstance.bounds) {
            bbox = normalizeBoundingBox(layerInstance.bounds)
        } else if (layerInstance.options?.bounds) {
            bbox = normalizeBoundingBox(layerInstance.options.bounds)
        }
    }
    return bbox
}

function deriveLayerGroupPath(layerConfig) {
    const cfg = layerConfig || {}
    if (typeof cfg.groupPath === 'string' && cfg.groupPath.trim()) {
        return cfg.groupPath.trim()
    }
    if (Array.isArray(cfg.groupPath)) {
        return cfg.groupPath
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join(' > ')
    }
    if (Array.isArray(cfg.path)) {
        return cfg.path
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join(' > ')
    }
    if (typeof cfg.path === 'string' && cfg.path.trim()) {
        return cfg.path.trim()
    }
    if (Array.isArray(cfg.group)) {
        return cfg.group
            .map((value) => String(value || '').trim())
            .filter(Boolean)
            .join(' > ')
    }
    if (typeof cfg.group === 'string' && cfg.group.trim()) {
        return cfg.group.trim()
    }
    return ''
}

// Index of every configured layer, as the Copilot sees it (display/canonical
// names, aliases, visibility, bbox, group path and time metadata).
export function buildAgentLayerIndex() {
    try {
        const api = window.mmgisAPI
        if (!api) return []
        const configs = api.getLayerConfigs?.() || {}
        const visibles = api.getVisibleLayers?.() || {}
        const liveLayers = api.getLayers?.() || {}
        const items = []
        const seen = new Set()

        Object.keys(configs).forEach((key) => {
            const layer = configs[key] || {}
            const uuid = String(layer.uuid || key || layer.name || '')
            if (!uuid || seen.has(uuid)) return
            seen.add(uuid)
            const liveInstance =
                liveLayers[uuid] ||
                liveLayers[layer.name] ||
                liveLayers[layer.display_name] ||
                null
            const display =
                layer.display_name ||
                layer.displayName ||
                layer.title ||
                layer.name ||
                uuid
            const canonical = layer.name || display
            const bbox = deriveLayerBoundingBox(layer, liveInstance)
            const groupPath = deriveLayerGroupPath(layer)
            const aliases = new Set()
            ;[
                display,
                canonical,
                layer.title,
                layer.display_name,
                layer.displayName,
                layer.shortName,
            ].forEach((alias) => {
                if (typeof alias === 'string' && alias.trim())
                    aliases.add(alias.trim())
            })
            if (Array.isArray(layer.aliases || layer.alias)) {
                ;(layer.aliases || layer.alias).forEach((alias) => {
                    if (typeof alias === 'string' && alias.trim())
                        aliases.add(alias.trim())
                })
            } else if (typeof layer.alias === 'string') {
                layer.alias
                    .split(/[,;]+/)
                    .map((a) => a.trim())
                    .filter(Boolean)
                    .forEach((a) => aliases.add(a))
            }
            const normalizedAliases = Array.from(aliases).map((raw) => ({
                raw,
                normalized: normalizeName(raw),
            }))
            const isVisible = !!(
                visibles[uuid] ||
                visibles[key] ||
                (layer.name && visibles[layer.name])
            )
            const timeMeta = getLayerTimeMetadata(layer)
            items.push({
                id: uuid,
                displayName: display,
                canonical,
                visible: isVisible,
                bbox,
                normalizedAliases,
                aliases: Array.from(aliases),
                groupPath,
                tags: Array.isArray(layer.tags) ? layer.tags : [],
                datasetId:
                    layer.datasetId ||
                    layer.dataset ||
                    layer.id ||
                    null,
                config: layer,
                liveInstance,
                timeMeta,
            })
        })
        return items
    } catch (_) {
        return []
    }
}

export function findAgentLayerMatch(value, userQuery = '', layerIndex = []) {
    if (value == null) return null
    const resolution = resolveLayerSelection({
        requestedName: value,
        userQuery,
        layers: layerIndex,
    })
    if (resolution?.ambiguous) {
        return {
            ambiguous: true,
            candidates: resolution.candidates || [],
        }
    }
    return resolution?.match || null
}

// Resolves the layer-name arguments of a planned action ({ tool, args }) to the
// canonical layer names the renderers expect. `findMatch(value, userQuery)`
// performs one lookup; `onResolved(value, match)` is an optional trace hook.
// Returns { prepared, matches } or { error, key }.
export function prepareActionLayerArgs(
    action,
    { userQuery = '', findMatch, onResolved = null } = {}
) {
    const args = action?.args || {}
    const targetKeys = Object.keys(args).filter((key) =>
        LAYER_ARG_KEYS.includes(key)
    )
    if (!targetKeys.length) {
        return {
            prepared: { ...action },
            matches: [],
        }
    }
    const updatedArgs = { ...args }
    const matches = []

    for (const key of targetKeys) {
        const value = updatedArgs[key]
        if (typeof value !== 'string' || !value.trim()) continue
        const match = findMatch(value, userQuery)
        if (match?.ambiguous) {
            const candidates = match.candidates || []
            // Auto-resolve when all candidates share the same normalized
            // display name (duplicate config entries or API aliases).
            const normalizedNames = candidates
                .map((c) => normalizeName(c.displayName || ''))
                .filter(Boolean)
            const allSameName =
                normalizedNames.length > 0 &&
                normalizedNames.every((n) => n === normalizedNames[0])
            if (allSameName && candidates.length > 0) {
                // Pick the highest-scored candidate (first in list)
                const best = candidates[0]
                // Re-resolve with the exact display name to get full match data
                const retry = findMatch(best.displayName, userQuery)
                if (retry && !retry.ambiguous) {
                    updatedArgs[key] = retry.resolved
                    matches.push({ key, ...retry })
                    continue
                }
            }
            const options = candidates
                .map((candidate) => {
                    const name = candidate.displayName || '(unnamed layer)'
                    const path = candidate.groupPath
                        ? `${candidate.groupPath} > ${name}`
                        : name
                    return path
                })
                .filter(Boolean)
            return {
                error: `Layer "${value}" is ambiguous. Choose one: ${options.join(' | ')}.`,
                key,
            }
        }
        if (!match) {
            return {
                error: `Could not find a layer matching "${value}".`,
                key,
            }
        }
        updatedArgs[key] = match.resolved
        matches.push({ key, ...match })
        if (typeof onResolved === 'function') onResolved(value, match)
    }

    return {
        prepared: {
            ...action,
            args: updatedArgs,
            __layerMatches: matches,
        },
        matches,
    }
}

export function resolveDisplayNameToLayerId(value, layerIndex = []) {
    if (!value) return null
    const normalized = normalizeName(value)
    const direct = layerIndex.find(
        (layer) =>
            normalizeName(layer.displayName) === normalized ||
            normalizeName(layer.canonical) === normalized
    )
    if (direct) return direct.id
    return window.mmgisAPI?.asLayerUUID?.(String(value)) || null
}

// Mission-specific conflict rules can be provided via window.mmgisAgentLayerConflicts:
// an array of { trigger: /regex/, conflicts: /regex/ } objects. When a rule's
// trigger matches the query, visible layers matching its conflicts pattern are
// turned off. Without rules nothing happens. Returns the layers turned off.
export async function applyLayerConflictRules(targetId, queryText) {
    const conflictRules = (typeof window !== 'undefined' && window.mmgisAgentLayerConflicts) || []
    if (!conflictRules.length) return []

    const normalizedQuery = normalizeName(queryText)
    const api = window.mmgisAPI
    if (!api) return []

    const matchingRules = conflictRules.filter(r => r.trigger && r.trigger.test(normalizedQuery))
    if (!matchingRules.length) return []

    const visible = api.getVisibleLayers?.() || {}
    const configs = api.getLayerConfigs?.() || {}
    const turnedOff = []

    for (const id of Object.keys(visible)) {
        if (!visible[id]) continue
        if (String(id) === String(targetId)) continue
        const cfg = configs[id] || {}
        const haystack = normalizeName(
            [
                cfg.display_name,
                cfg.displayName,
                cfg.name,
                cfg.title,
                ...(Array.isArray(cfg.aliases) ? cfg.aliases : []),
            ]
                .filter(Boolean)
                .join(' ')
        )
        const shouldDisable = matchingRules.some(r => r.conflicts && r.conflicts.test(haystack))
        if (!shouldDisable) continue
        try {
            await api.toggleLayer(id, false)
            turnedOff.push({
                id,
                name:
                    cfg.display_name ||
                    cfg.displayName ||
                    cfg.name ||
                    String(id),
            })
        } catch (_) {}
    }
    return turnedOff
}

// Layer summaries and the layer context the Copilot sends to its planner.
export function collectAgentLayers(layerIndex = []) {
    return layerIndex.map((layer) => {
        const aliases = Array.from(
            new Set(
                (layer.normalizedAliases || [])
                    .map((alias) => alias.raw)
                    .filter(Boolean)
            )
        )
        const timeMeta = layer.timeMeta
        const time =
            timeMeta && timeMeta.enabled
                ? {
                      enabled: true,
                      cadence: timeMeta.cadence,
                      format: timeMeta.format,
                      available_start: timeMeta.availableStart,
                      available_end: timeMeta.availableEnd,
                      current_start: timeMeta.currentStart,
                      current_end: timeMeta.currentEnd,
                  }
                : null
        return {
            id: layer.id,
            display: layer.displayName,
            name: layer.canonical,
            aliases,
            groupPath: layer.groupPath || '',
            visible: layer.visible,
            bbox: Array.isArray(layer.bbox) ? layer.bbox.slice() : null,
            time,
        }
    })
}

export function buildAgentContextFromLayers(layers = []) {
    if (!layers.length) return null
    const hints = layers.map((layer) => {
        const hint = {
            display_name: layer.display,
            canonical_name: layer.name,
            aliases: layer.aliases,
            group_path: layer.groupPath,
            visible: layer.visible,
            bbox: layer.bbox,
        }
        if (layer.time) hint.time = layer.time
        return hint
    })
    return { layers: hints }
}

// Commands the Copilot answers locally, without the planner: MMGIS overview,
// preset region zoom and time-slider changes (dispatched by localCommands.js).
const LOCAL_REGION_VIEWS = {
    'point barrow': { lat: 71.3875, lon: -156.4797, zoom: 6 },
    barrow: { lat: 71.3875, lon: -156.4797, zoom: 6 },
    'beaufort sea': { lat: 73.5, lon: -146, zoom: 5 },
    'chukchi sea': { lat: 70.5, lon: -166, zoom: 5 },
    'arctic ocean': { lat: 78.5, lon: -150, zoom: 3 },
}

export function detectMmgisOverviewIntent(text) {
    if (!text || typeof text !== 'string') return false
    const lower = text.trim().toLowerCase()
    return (
        lower === 'what is mmgis' ||
        lower === 'what is mmgis?' ||
        lower === 'tell me about mmgis' ||
        lower === 'what does mmgis do'
    )
}

export function handleMmgisOverviewIntent() {
    return {
        reply:
            'MMGIS (Multi-Mission Geographic Information System) is a web mapping platform for mission operations and geospatial analysis.\n' +
            'It helps teams visualize layers in 2D/3D, explore time-enabled data, and collaborate around mission maps.',
    }
}

export function detectZoomRegionIntent(text) {
    if (!text || typeof text !== 'string') return null
    const trimmed = text.trim()
    const match = trimmed.match(
        /^(?:zoom|focus|go|fly)\s+(?:to|on|into)\s+(?:the\s+)?(.+)$/i
    )
    if (!match || !match[1]) return null
    let region = match[1].trim()
    let zoom = null
    const zoomMatch = region.match(/\s+at\s+zoom(?:\s+level)?\s+(\d{1,2})$/i)
    if (zoomMatch && zoomMatch[1]) {
        const parsedZoom = Number(zoomMatch[1])
        if (Number.isFinite(parsedZoom)) {
            zoom = Math.max(0, Math.min(24, parsedZoom))
            region = region.slice(0, zoomMatch.index).trim()
        }
    }
    return { region, zoom }
}

function normalizeRegionKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(region|area)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

export function handleZoomRegionIntent(intent) {
    const key = normalizeRegionKey(intent?.region)
    if (!key) return null
    const preset = LOCAL_REGION_VIEWS[key]
    const map = window.mmgisAPI?.map
    if (!preset || !map || typeof map.setView !== 'function') return null
    const zoom =
        Number.isFinite(intent?.zoom) && intent.zoom >= 0
            ? intent.zoom
            : preset.zoom
    map.setView([preset.lat, preset.lon], zoom)
    return {
        reply: `Focused map on ${intent.region} at zoom level ${zoom}.`,
    }
}

export function detectFastTimeIntent(text) {
    if (!text || typeof text !== 'string') return null
    const trimmed = text.trim()
    if (!trimmed) return null
    const lower = trimmed.toLowerCase()
    if (
        /(latest|most recent|newest)\s+(time|date|timestamp)/.test(lower) ||
        /(move|jump|go)\s+(?:to|toward)\s+the\s+(latest|newest)/.test(lower)
    ) {
        return { query: trimmed, special: 'latest' }
    }
    if (
        /(earliest|first|oldest)\s+(time|date|timestamp)/.test(lower) ||
        /(move|jump|go)\s+(?:to|toward)\s+the\s+(earliest|first|oldest)/.test(
            lower
        )
    ) {
        return { query: trimmed, special: 'earliest' }
    }
    const patterns = [
        /(?:set|change|update|move)\s+(?:the\s+)?time(?:\s+(?:slider|control))?\s+(?:to|for)\s+(.+)/i,
        /(?:go|jump)\s+(?:to|towards?)\s+(.+)/i,
    ]
    for (const pattern of patterns) {
        const match = trimmed.match(pattern)
        if (!match || !match[1]) continue
        const candidate = match[1].trim()
        if (
            candidate &&
            /(\d{2}|\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|'|spring|summer|fall|winter)/i.test(
                candidate
            )
        ) {
            return { query: candidate }
        }
    }
    return null
}
