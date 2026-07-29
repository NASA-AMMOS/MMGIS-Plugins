import $ from 'jquery'
import L_ from '@basics/Layers_/Layers_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import TimeUI from '@basics/TimeControl_/TimeUI'
import {
    parseTimeQuery,
    getLayerTimeMetadata,
    computeLayerTargetTime,
    describeCadence,
    computePrecisionEndIso,
} from './timeUtils'
import { detectAnomalies, formatAnomalyResults } from './anomalyDetection'
import rasterDifference from './rasterDifference'

// Make rasterDifference available globally for the renderer
if (typeof window !== 'undefined') {
    window.rasterDifference = rasterDifference
}
import {
    calculateMultiLayerStats,
    calculateTemporalTrends,
    calculateSpatialStatistics,
    calculateChangeDetection,
    formatMultiLayerResults,
    formatTemporalTrendResults,
    formatSpatialStatsResults,
    formatChangeDetectionResults,
} from './advancedStatistics'
import {
    createTimeSeriesAnimation,
    formatAnimationResults
} from './timeSeriesAnimation'
import {
    exportLayerData,
    formatExportResults,
    triggerDownload
} from './dataExport'
import {
    calculateLocalBasicStats,
    calculateLocalHistogram,
    calculateLocalThresholdMask,
    logLocalAnalyticsEvent,
} from './localAnalytics'

const DEFAULT_AREA_PRESETS = {
    'beaufort sea': { label: 'Beaufort Sea', bbox: [-160, 70, -120, 76] },
    'chukchi sea': { label: 'Chukchi Sea', bbox: [-180, 65, -155, 76] },
    'arctic ocean': { label: 'Arctic Ocean', bbox: [-180, 70, 180, 90] },
    'gulf of mexico': { label: 'Gulf of Mexico', bbox: [-97.5, 18.0, -80.5, 30.5] },
    'great lakes': { label: 'Great Lakes', bbox: [-92.5, 41.0, -75.0, 49.0] },
    'north atlantic': { label: 'North Atlantic', bbox: [-80, 30, 0, 70] },
    'north pacific': { label: 'North Pacific', bbox: [120, 30, -120, 65] },
}

// Mission-specific presets can be injected via window.mmgisAgentAreaPresets
// (plain object keyed by lowercase region name, same shape as DEFAULT_AREA_PRESETS).
function getAreaPresets() {
    const overrides = (typeof window !== 'undefined' && window.mmgisAgentAreaPresets) || {}
    return { ...DEFAULT_AREA_PRESETS, ...overrides }
}

// Keep AREA_PRESETS as a convenience alias resolved at call time.
const AREA_PRESETS = new Proxy({}, {
    get(_, key) { return getAreaPresets()[key] },
    has(_, key) { return key in getAreaPresets() },
})

function appendLine(text) {
    if (typeof window.__mmgisAgentChatAppend === 'function') {
        window.__mmgisAgentChatAppend(String(text))
        return
    }
    const $tx = $('#agentChatTranscript')
    if (!$tx.length) {
        // Try alternative selectors
        const altSelectors = [
            '.agentchat-transcript',
            '.agent-chat-transcript', 
            '[data-agentchat-transcript]',
            '.agentChatTranscript'
        ]
        for (const selector of altSelectors) {
            const $alt = $(selector)
            if ($alt.length) {
                const div = $(`<div style='margin:4px 0;white-space:pre-wrap'></div>`).text(
                    String(text)
                )
                $alt.append(div)
                if (typeof window.__mmgisAgentChatScroll === 'function') {
                    window.__mmgisAgentChatScroll()
                }
                return
            }
        }
        // If no element found, log to console as fallback
        console.log('[AgentChat Output]:', text)
        return
    }
    const div = $(`<div style='margin:4px 0;white-space:pre-wrap'></div>`).text(
        String(text)
    )
    $tx.append(div)
    
    // Trigger scroll from AgentChatTool.js
    if (typeof window.__mmgisAgentChatScroll === 'function') {
        window.__mmgisAgentChatScroll()
    }
}

function normalizeName(value) {
    return (value || '')
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

function levenshtein(a, b) {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i <= m; i += 1) dp[i][0] = i
    for (let j = 0; j <= n; j += 1) dp[0][j] = j
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            )
        }
    }
    return dp[m][n]
}

function scoreSimilarity(queryNorm, candidateNorm) {
    if (!queryNorm) return 0
    if (queryNorm === candidateNorm) return 1
    if (candidateNorm.includes(queryNorm))
        return Math.max(
            0.8,
            queryNorm.length / Math.max(candidateNorm.length, 1)
        )
    if (queryNorm.includes(candidateNorm))
        return Math.max(
            0.7,
            candidateNorm.length / Math.max(queryNorm.length, 1)
        )
    const dist = levenshtein(queryNorm, candidateNorm)
    const maxLen = Math.max(queryNorm.length, candidateNorm.length, 1)
    return Math.max(0, 1 - dist / maxLen)
}

const ANALYTICS_DEFAULT_BASE = null
const analyticsLayerCatalogPromises = new Map()

function getAnalyticsBaseUrl() {
    const override =
        (window?.mmgisglobal?.ANALYTICS_BASE_URL &&
            String(window.mmgisglobal.ANALYTICS_BASE_URL).trim()) || ''
    const root = (window?.mmgisglobal?.ROOT_PATH || '').replace(/\/+$/, '')
    const base = override.length ? override : `${root}/api/agent/analytics`
    return base.replace(/\/+$/, '')
}

function resolveAnalyticsBase(override = undefined) {
    if (override === null) return null
    const trimmed =
        typeof override === 'string' && override.trim().length
            ? override.trim()
            : null
    if (trimmed) return trimmed.replace(/\/+$/, '')
    if (typeof override !== 'undefined') return null
    const fallback = getAnalyticsBaseUrl()
    const normalized = (fallback || '').replace(/\/+$/, '')
    return normalized || null
}

function buildAnalyticsUrl(path, baseOverride = undefined) {
    const base = resolveAnalyticsBase(baseOverride)
    if (!base) return null
    const safePath = String(path || '').replace(/^\/+/, '')
    return `${base}/${safePath}`
}

async function fetchAnalyticsLayerCatalog(baseOverride = null) {
    const base = resolveAnalyticsBase(baseOverride)
    if (!base) return null
    const cacheKey = L_.mission ? `${base}::${L_.mission}` : base
    if (analyticsLayerCatalogPromises.has(cacheKey)) {
        return analyticsLayerCatalogPromises.get(cacheKey)
    }
    const url = L_.mission
        ? `${base}/layers?mission=${encodeURIComponent(L_.mission)}`
        : `${base}/layers`
    const promise = fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
        .then((res) => {
            if (!res.ok) {
                throw new Error(
                    `Analytics catalog request failed (${res.status})`
                )
            }
            return res.json()
        })
        .catch((error) => {
            analyticsLayerCatalogPromises.delete(cacheKey)
            throw error
        })
    analyticsLayerCatalogPromises.set(cacheKey, promise)
    return promise
}

function gatherAnalyticsAliases(key, info, layerConfig) {
    const values = new Set()
    const push = (value) => {
        if (typeof value === 'string' && value.trim()) values.add(value.trim())
    }
    const pushPath = (value) => {
        if (typeof value !== 'string' || !value.trim()) return
        push(value)
        const parts = value.split(/[\\/]/)
        const file = parts[parts.length - 1]
        if (file) {
            push(file)
            const withoutExt = file.replace(/\.[^.]+$/, '')
            if (withoutExt !== file) push(withoutExt)
            push(file.replace(/[_-]+/g, ' '))
            push(withoutExt.replace(/[_-]+/g, ' '))
        }
    }
    push(key)
    if (info) {
        push(info.name)
        push(info.display_name)
        push(info.displayName)
        push(info.title)
        if (Array.isArray(info.aliases)) info.aliases.forEach(push)
        if (Array.isArray(info.alias)) info.alias.forEach(push)
        if (Array.isArray(info.tags)) info.tags.forEach(push)
        if (info.path) pushPath(info.path)
        if (info.dataset) push(info.dataset)
    }
    if (layerConfig) {
        push(layerConfig.name)
        push(layerConfig.display_name)
        push(layerConfig.displayName)
        push(layerConfig.title)
        if (Array.isArray(layerConfig.aliases))
            layerConfig.aliases.forEach(push)
        else if (typeof layerConfig.alias === 'string') {
            layerConfig.alias
                .split(/[,;]+/)
                .map((a) => a.trim())
                .filter(Boolean)
                .forEach(push)
        }
        if (layerConfig.url) pushPath(layerConfig.url)
        if (layerConfig.cogUrl) pushPath(layerConfig.cogUrl)
        if (layerConfig.source) pushPath(layerConfig.source)
    }
    return Array.from(values)
}

async function resolveAnalyticsLayerKey(
    layerName,
    layerConfig,
    baseOverride = null
) {
    try {
        const catalog = await fetchAnalyticsLayerCatalog(baseOverride)
        if (!catalog) return null
        const layersRaw = catalog?.layers
        const entries = []
        if (Array.isArray(layersRaw)) {
            layersRaw.forEach((info) => {
                if (!info || typeof info !== 'object') return
                const key =
                    (typeof info.name === 'string' && info.name) ||
                    (typeof info.id === 'string' && info.id) ||
                    (typeof info.dataset === 'string' && info.dataset) ||
                    null
                entries.push({ key, info })
            })
        } else if (layersRaw && typeof layersRaw === 'object') {
            Object.keys(layersRaw).forEach((key) => {
                entries.push({ key, info: layersRaw[key] })
            })
        }
        if (!entries.length) return null
        const targetNorm = normalizeName(layerName)
        if (!targetNorm) return null
        let best = null
        let bestScore = 0
        entries.forEach(({ key, info }) => {
            const candidates = gatherAnalyticsAliases(key, info, layerConfig)
            candidates.forEach((candidate) => {
                const candidateNorm = normalizeName(candidate)
                if (!candidateNorm) return
                const score = scoreSimilarity(targetNorm, candidateNorm)
                if (score > bestScore) {
                    bestScore = score
                    best = { key, info }
                }
            })
        })
        if (!best) {
            if (entries.length === 1) {
                best = entries[0]
                bestScore = 0
            } else {
                return null
            }
        }
        const MIN_SCORE = 0.32
        if (bestScore < MIN_SCORE && entries.length > 1) {
            return {
                key:
                    (typeof best.key === 'string' && best.key) ||
                    (best.info && typeof best.info.name === 'string'
                        ? best.info.name
                        : null) ||
                    null,
                info: best.info,
                confidence: bestScore,
            }
        }
        let resolvedKey =
            (typeof best.key === 'string' && best.key) ||
            (best.info && typeof best.info.name === 'string'
                ? best.info.name
                : null) ||
            null
        if (!resolvedKey && best.info?.dataset) {
            resolvedKey = best.info.dataset
        }
        if (!resolvedKey && typeof best.info?.path === 'string') {
            const parts = best.info.path.split(/[\\/]/)
            resolvedKey = parts[parts.length - 1]?.replace(/\.[^.]+$/, '')
        }
        if (!resolvedKey) {
            if (entries.length === 1) {
                resolvedKey =
                    entries[0].key || entries[0].info?.name || 'default'
            } else {
                return null
            }
        }
        return {
            key: resolvedKey,
            info: best.info,
            confidence: bestScore,
        }
    } catch (error) {
        console.error('Failed to resolve analytics layer:', error)
        return null
    }
}

async function fetchAnalyticsStatistics(
    layerKey,
    bbox,
    timeRange,
    layerName,
    baseOverride = null
) {
    const params = new URLSearchParams()
    if (layerKey) params.set('layer', layerKey)
    if (layerName) params.set('layer_name', layerName)
    if (
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((value) => Number.isFinite(value))
    ) {
        params.set('lon_min', bbox[0])
        params.set('lat_min', bbox[1])
        params.set('lon_max', bbox[2])
        params.set('lat_max', bbox[3])
    }
    if (timeRange && typeof timeRange === 'object') {
        if (timeRange.start) params.set('time_start', timeRange.start)
        if (timeRange.end) params.set('time_end', timeRange.end)
    }
    if (L_.mission) params.set('mission', L_.mission)
    const url = buildAnalyticsUrl('statistics', baseOverride)
    if (!url) {
        throw new Error('Analytics endpoint is not configured for this layer.')
    }
    const fullUrl = `${url}?${params.toString()}`
    const res = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
        throw new Error(`Analytics statistics failed (${res.status})`)
    }
    return res.json()
}

async function fetchAnalyticsHistogram(
    layerKey,
    bbox,
    timeRange,
    bins = 60,
    layerName,
    baseOverride = null
) {
    const params = new URLSearchParams()
    if (layerKey) params.set('ds', layerKey)
    if (layerName) params.set('layer_name', layerName)
    if (timeRange && typeof timeRange === 'object') {
        if (timeRange.start) params.set('startTime', timeRange.start)
        if (timeRange.end) params.set('endTime', timeRange.end)
    }
    if (
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((value) => Number.isFinite(value))
    ) {
        params.set('b', bbox.join(','))
    }
    params.set('bins', String(bins))
    if (L_.mission) params.set('mission', L_.mission)
    const url = buildAnalyticsUrl('histogram/data', baseOverride)
    if (!url) {
        throw new Error('Analytics histogram endpoint is unavailable.')
    }
    const fullUrl = `${url}?${params.toString()}`
    const res = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
        throw new Error(`Analytics histogram failed (${res.status})`)
    }
    return res.json()
}

function sanitizeHistogramResponse(raw) {
    const edges = Array.isArray(raw?.bin_edges) ? raw.bin_edges : []
    const counts = Array.isArray(raw?.counts) ? raw.counts : []
    if (edges.length !== counts.length + 1 || !counts.length) return null
    const nodata =
        typeof raw?.nodata_value === 'number' ? raw.nodata_value : null
    const filteredCounts = []
    const filteredEdges = []
    for (let i = 0; i < counts.length; i += 1) {
        const c = counts[i]
        const start = edges[i]
        const end = edges[i + 1]
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue
        if (c == null || c <= 0) continue
        if (start === end) continue
        const containsNoData =
            nodata != null &&
            ((nodata >= start && nodata <= end) ||
                (start <= 0 && end >= 0 && nodata === 0))
        if (containsNoData) continue
        if (!filteredEdges.length) filteredEdges.push(start)
        filteredCounts.push(c)
        filteredEdges.push(end)
    }
    if (!filteredCounts.length) return null
    return { binEdges: filteredEdges, counts: filteredCounts }
}

function computeHistogramQuantiles(histogram, percentiles) {
    if (!histogram) return null
    const { binEdges, counts } = histogram
    const total = counts.reduce((sum, c) => sum + c, 0)
    if (!total) return null
    const cumulative = []
    let running = 0
    counts.forEach((c) => {
        running += c
        cumulative.push(running)
    })
    const result = {}
    percentiles.forEach((p) => {
        const target = total * p
        let idx = cumulative.findIndex((value) => value >= target)
        if (idx === -1) idx = cumulative.length - 1
        const lowerCum = idx > 0 ? cumulative[idx - 1] : 0
        const interval = cumulative[idx] - lowerCum
        const start = binEdges[idx]
        const end = binEdges[idx + 1]
        const fraction = interval > 0 ? (target - lowerCum) / interval : 0
        const value = start + fraction * (end - start)
        result[p] = value
    })
    return { total, quantiles: result }
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

function isValidBbox(bbox) {
    return (
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((value) => Number.isFinite(value)) &&
        bbox[0] < bbox[2] &&
        bbox[1] < bbox[3]
    )
}

function buildLayerIndex() {
    const api = window.mmgisAPI
    if (!api) throw new Error('mmgisAPI is not available.')
    const configs = api.getLayerConfigs?.()
    if (!configs || typeof configs !== 'object')
        throw new Error('getLayerConfigs() returned no data.')
    const visibleLookup = api.getVisibleLayers?.() || {}
    const liveLayers = api.getLayers?.() || {}
    const items = []
    const seen = new Set()

    Object.keys(configs).forEach((key) => {
        const layerConfig = configs[key] || {}
        const uuid = String(layerConfig.uuid || key || layerConfig.name || '')
        if (!uuid || seen.has(uuid)) return
        seen.add(uuid)
        const liveInstance =
            liveLayers[uuid] ||
            liveLayers[layerConfig.name] ||
            liveLayers[layerConfig.display_name] ||
            null
        const displayName =
            layerConfig.display_name ||
            layerConfig.displayName ||
            layerConfig.title ||
            layerConfig.name ||
            uuid
        const canonical = layerConfig.name || displayName
        const bbox = deriveLayerBoundingBox(layerConfig, liveInstance)
        const aliases = new Set()
        ;[
            displayName,
            canonical,
            layerConfig.title,
            layerConfig.display_name,
            layerConfig.displayName,
            layerConfig.shortName,
        ].forEach((alias) => {
            if (typeof alias === 'string' && alias.trim())
                aliases.add(alias.trim())
        })
        if (Array.isArray(layerConfig.aliases || layerConfig.alias)) {
            ;(layerConfig.aliases || layerConfig.alias).forEach((alias) => {
                if (typeof alias === 'string' && alias.trim())
                    aliases.add(alias.trim())
            })
        } else if (typeof layerConfig.alias === 'string') {
            layerConfig.alias
                .split(/[,;]+/)
                .map((a) => a.trim())
                .filter(Boolean)
                .forEach((a) => aliases.add(a))
        }
        const normalizedAliases = Array.from(aliases).map((raw) => ({
            raw,
            normalized: normalizeName(raw),
        }))
        items.push({
            id: uuid,
            name: layerConfig.name || uuid,
            displayName,
            canonical,
            visible: !!(
                visibleLookup[uuid] ||
                visibleLookup[key] ||
                (layerConfig.name && visibleLookup[layerConfig.name])
            ),
            bbox,
            normalizedAliases,
            config: layerConfig,
            liveInstance,
        })
    })
    return items
}

function resolveDisplayNameToId(displayName) {
    const items = buildLayerIndex()
    const normalized = normalizeName(displayName)
    const exact = items.find(
        (item) =>
            normalizeName(item.displayName) === normalized ||
            normalizeName(item.canonical) === normalized
    )
    if (exact) return exact.name
    return window.mmgisAPI?.asLayerUUID?.(String(displayName)) || null
}

function findLayerMatch(value, index = null) {
    if (!value) return null
    const list = index || buildLayerIndex()
    const queryNorm = normalizeName(value)
    if (!queryNorm) return null
    let best = null
    let bestScore = 0
    list.forEach((layer) => {
        layer.normalizedAliases.forEach((alias) => {
            if (!alias.normalized) return
            const score = scoreSimilarity(queryNorm, alias.normalized)
            if (score > bestScore) {
                bestScore = score
                best = { layer, alias }
            }
        })
    })
    if (!best) return null
    return {
        displayName: best.layer.displayName,
        id: best.layer.id,
        score: bestScore,
        bbox: Array.isArray(best.layer.bbox) ? best.layer.bbox.slice() : null,
        layer: best.layer,
    }
}

function ensureMap() {
    const map = window.mmgisAPI?.map
    if (!map) throw new Error('Map instance unavailable.')
    return map
}

function ensureOverlayGroup(key) {
    const map = ensureMap()
    const store = (window.__mmgisAgentChatOverlays =
        window.__mmgisAgentChatOverlays || {})
    if (!store[key]) {
        store[key] = window.L.layerGroup().addTo(map)
    } else {
        store[key].clearLayers()
    }
    return store[key]
}

function drawAreaHighlight(area, key, options = {}) {
    const map = ensureMap()
    const group = ensureOverlayGroup(key)
    const bounds = window.L.latLngBounds(
        window.L.latLng(area.bbox[1], area.bbox[0]),
        window.L.latLng(area.bbox[3], area.bbox[2])
    )
    const color = options.color || '#0ea5e9'
    const fill = window.L.rectangle(bounds, {
        color,
        weight: options.weight || 1,
        fillColor: color,
        fillOpacity:
            typeof options.fillOpacity === 'number' ? options.fillOpacity : 0.2,
    })
    fill.addTo(group)
    if (options.dashArray) fill.setStyle({ dashArray: options.dashArray })
    map.fitBounds(bounds, { padding: [18, 18] })
    return { group, bounds }
}

function drawLocalThresholdOverlay(points) {
    const group = ensureOverlayGroup('local-threshold')
    if (!points || !points.length) {
        group.clearLayers()
        return
    }
    points.forEach((pt) => {
        if (!pt || !Number.isFinite(pt.lat) || !Number.isFinite(pt.lon)) return
        window.L.circleMarker([pt.lat, pt.lon], {
            radius: 2.5,
            color: '#ea580c',
            weight: 0,
            fillColor: '#f97316',
            fillOpacity: 0.65,
        }).addTo(group)
    })
}

function deterministicNumber(seed, min, max) {
    let hash = 0
    const text = seed.toString()
    for (let i = 0; i < text.length; i += 1) {
        hash = (hash << 5) - hash + text.charCodeAt(i)
        hash |= 0
    }
    const normalized = ((hash >>> 0) % 10000) / 10000
    return min + normalized * (max - min)
}

function resolveArea(name) {
    const normalized = normalizeName(name)
    if (normalized && AREA_PRESETS[normalized]) {
        const preset = AREA_PRESETS[normalized]
        return {
            label: preset.label || name || 'selected area',
            bbox: preset.bbox.slice(),
        }
    }
    const map = window.mmgisAPI?.map
    if (map) {
        const bounds = map.getBounds()
        return {
            label: name || 'current map view',
            bbox: [
                bounds.getWest(),
                bounds.getSouth(),
                bounds.getEast(),
                bounds.getNorth(),
            ],
        }
    }
    return null
}

function resolveLayerContext(payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('A layer_name is required for this request.')
    }
    const layerMatch = findLayerMatch(layerName)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(`Unable to locate configuration for layer "${layerName}".`)
    }
    const resolvedLayerName =
        layerMatch.displayName || layerMatch.layer?.displayName || layerName
    const areaName =
        payload?.geographical_area ||
        payload?.area ||
        payload?.region ||
        'current view'
    const area = resolveArea(areaName)
    if (!area) {
        throw new Error(
            `Unable to resolve geographical area "${areaName}". Try specifying a preset area or adjust the map view.`
        )
    }
    return { layerMatch, resolvedLayerName, area }
}

function isExternalTileLayer(layerMatch) {
    const cfg = layerMatch?.layer?.config || {}
    const url = cfg.url || cfg.source || ''
    if (cfg.sourceType === 'url' && /^https?:\/\//i.test(url)) return true
    if (/^https?:\/\//i.test(url) && /\{[xyz]\}/i.test(url)) return true
    return false
}

function getLayerTimeTokens(layerMatch, payload = {}) {
    const liveOptions = layerMatch?.layer?.liveInstance?.options || {}
    const safe = (value) =>
        typeof value === 'string' && value.trim().length ? value.trim() : null
    return {
        time: safe(payload?.time || payload?.time_end || liveOptions.time),
        startTime: safe(payload?.time_start || liveOptions.starttime),
        endTime: safe(payload?.time_end || liveOptions.endtime),
    }
}

function noteLocalAnalytics(layerName, reason) {
    const label = layerName || 'unknown layer'
    logLocalAnalyticsEvent(`Running local analytics for ${label}`, reason)
}

function determineAnalyticsEndpoint(layerMatch, analyticsLayerInfo) {
    const config = layerMatch?.layer?.config || {}
    const hasExplicit = Object.prototype.hasOwnProperty.call(
        config,
        'analyticsEndpoint'
    )
    if (hasExplicit) {
        const value = config.analyticsEndpoint
        if (value === false || value === null || typeof value === 'undefined')
            return null
        if (typeof value === 'string') {
            const trimmed = value.trim()
            if (!trimmed.length) return null
            if (trimmed.toLowerCase() === 'default') {
                const fallback = getAnalyticsBaseUrl()
                return fallback || null
            }
            return trimmed
        }
        if (typeof value === 'object') {
            const base =
                (value &&
                    typeof value.base === 'string' &&
                    value.base.trim()) ||
                (value && typeof value.url === 'string' && value.url.trim()) ||
                null
            if (base) return base
        }
        if (value === true) {
            const fallback = getAnalyticsBaseUrl()
            return fallback || null
        }
        return null
    }
    const infoEndpoint =
        typeof analyticsLayerInfo?.info?.analyticsEndpoint === 'string'
            ? analyticsLayerInfo.info.analyticsEndpoint.trim()
            : null
    if (infoEndpoint) return infoEndpoint
    // No explicit endpoint configured — fall back to the default backend
    // analytics URL so the server-side statistics pipeline is always tried.
    return getAnalyticsBaseUrl() || null
}

async function computeLocalStatsContext(payload) {
    const context = resolveLayerContext(payload)
    if (isExternalTileLayer(context.layerMatch)) {
        const cfg = context.layerMatch.layer.config || {}
        let host = ''
        try { host = ` (${new URL(cfg.url || cfg.source).hostname})` } catch (_e) { /* ignore */ }
        const name = context.resolvedLayerName || payload?.layer_name || 'This layer'
        throw new Error(
            `${name} is served from an external tile service${host}` +
            ` and does not have a local raster file. ` +
            `Raster statistics require a locally hosted COG or GeoTIFF layer.`
        )
    }
    const timeTokens = getLayerTimeTokens(context.layerMatch, payload)
    const stats = await calculateLocalBasicStats(context.layerMatch, context.area, {
        geometry: payload?.geometry,
        time: timeTokens.time,
        startTime: timeTokens.startTime,
        endTime: timeTokens.endTime,
    })
    return { ...context, stats, timeTokens }
}

function formatCitations(citations) {
    if (!Array.isArray(citations) || !citations.length) return ''
    return citations
        .map((c, idx) => {
            const title =
                (c && typeof c.title === 'string' && c.title) ||
                `Source ${idx + 1}`
            const url = c && typeof c.url === 'string' ? c.url : ''
            return `${idx + 1}. ${title}${url ? ` (${url})` : ''}`
        })
        .join('\n')
}

async function fetchLayerMetadata(layerName) {
    const root = window.mmgisglobal?.ROOT_PATH || ''
    const url =
        root + '/api/agent/layer-info?name=' + encodeURIComponent(layerName)
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (res.status === 404) {
        return { items: [], match: null, unavailable: true }
    }
    if (!res.ok) {
        throw new Error(`Layer metadata lookup failed (status ${res.status}).`)
    }
    const data = await res.json()
    return {
        items: Array.isArray(data?.items) ? data.items : [],
        match: data?.match || null,
        unavailable: false,
    }
}

async function searchLayerInformation(layerName, originalQuery) {
    const root = window.mmgisglobal?.ROOT_PATH || ''
    const promptParts = []
    if (originalQuery) promptParts.push(`User asked: "${originalQuery}".`)
    promptParts.push(
        `Provide a concise description of the MMGIS layer "${layerName}".`
    )
    promptParts.push(
        'Use authoritative sources, include at least two citations, and do not call any tools.'
    )
    const message = promptParts.join(' ')
    const res = await fetch(root + '/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
    })
    if (!res.ok) {
        throw new Error(`Bing-backed lookup failed (status ${res.status}).`)
    }
    const payload = await res.json()
    return {
        reply: payload?.reply || payload?.text || '',
        citations: Array.isArray(payload?.citations) ? payload.citations : [],
    }
}


export async function render_layers_line() {
    const items = buildLayerIndex()
    if (!items.length) {
        throw new Error('No layers available to list.')
    }
    const summaryLines = items.map(
        (item) => `- ${item.displayName} (${item.visible ? 'on' : 'off'})`
    )
    appendLine(`Layers:\n${summaryLines.join('\n')}`)
}

export async function render_text_with_citation(_ctx, payload) {
    const text = payload?.text
    if (!text || typeof text !== 'string')
        throw new Error(
            'render_text_with_citation requires a payload.text string.'
        )
    const cite = payload?.citation
    appendLine(text + (cite ? `\n${cite}` : ''))
}

export async function render_links_summary(_ctx, payload) {
    if (!payload || typeof payload.summary !== 'string')
        throw new Error(
            'render_links_summary requires a payload.summary string.'
        )
    if (!Array.isArray(payload.links))
        throw new Error('render_links_summary requires a payload.links array.')
    const summary = payload.summary
    const links = payload.links
    const formatted =
        summary +
        (links.length
            ? '\n' +
              links
                  .map(
                      (link, idx) =>
                          `${idx + 1}. ${
                              (link && link.title) || link.url || 'Link'
                          }${link?.url ? ` (${link.url})` : ''}`
                  )
                  .join('\n')
            : '')
    appendLine(formatted)
}

function extractTimeQueryString(payload) {
    if (!payload || typeof payload !== 'object') return null
    const candidates = [
        payload.iso_time,
        payload.isoTime,
        payload.time,
        payload.timestamp,
        payload.requested_time,
        payload.time_query,
        payload.timeQuery,
        payload.date,
    ]
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim()
        }
    }
    return null
}

function detectSpecialTimeKeyword(raw) {
    if (typeof raw !== 'string') return null
    const norm = raw.toLowerCase()
    if (
        /(latest|most recent|newest|current)\s+(time|date|timestamp)/.test(norm) ||
        /(move|jump|go)\s+(?:to|toward)\s+the\s+(latest|newest)/.test(norm)
    )
        return 'latest'
    if (
        /(earliest|first|oldest)\s+(time|date|timestamp)/.test(norm) ||
        /(move|jump|go)\s+(?:to|toward)\s+the\s+(earliest|first)/.test(norm)
    )
        return 'earliest'
    return null
}

function uniqueLayerTargets(list) {
    const seen = new Set()
    return list.filter((item) => {
        if (!item || !item.id) return false
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
    })
}

async function executeVisibleLayersTimeChange(payload) {
    const api = window.mmgisAPI
    if (!api?.setLayerTime || typeof api.reloadLayer !== 'function') {
        return {
            ok: false,
            lines: [
                'Time control API is unavailable in this mission. Time commands cannot be executed.',
            ],
        }
    }
    const rawQuery = extractTimeQueryString(payload)
    if (!rawQuery) {
        return {
            ok: false,
            lines: [
                'Please provide a specific time (e.g., "2023-01-01" or "January 2023").',
            ],
        }
    }
    const special =
        payload?.special ||
        detectSpecialTimeKeyword(rawQuery) ||
        detectSpecialTimeKeyword(payload?.original_query || '')
    const parsedTime = special ? { special, original: rawQuery } : parseTimeQuery(rawQuery)
    if (!parsedTime || (!parsedTime.date && !parsedTime.special)) {
        return {
            ok: false,
            lines: [
                `I could not interpret "${rawQuery}" as a time expression.`,
            ],
        }
    }

    const index = buildLayerIndex()
    const explicit =
        Array.isArray(payload?.layers) && payload.layers.length
            ? payload.layers
                  .map((name) => (typeof name === 'string' ? name.trim() : ''))
                  .filter(Boolean)
            : []
    let targets = []
    const skipped = []
    if (explicit.length) {
        explicit.forEach((name) => {
            const match = findLayerMatch(name, index)
            if (!match) {
                skipped.push({
                    name,
                    reason: 'layer not found',
                })
            } else {
                targets.push(match.layer)
            }
        })
    } else {
        // First try to find formally time-enabled layers
        targets = index.filter(
            (layer) => layer.visible && layer.config?.time?.enabled === true
        )
        // If no formally time-enabled layers, try to find layers that might support time
        if (targets.length === 0) {
            targets = index.filter((layer) => {
                if (!layer.visible) return false
                // Check if layer name suggests it might support time
                const name = (layer.displayName || '').toLowerCase()
                return name.includes('gfs') || name.includes('gibs') || name.includes('modis') ||
                       name.includes('swot') || name.includes('icesat')
            })
        }
    }
    targets = uniqueLayerTargets(targets)
    if (!targets.length) {
        return {
            ok: false,
            lines: [
                'No time-capable layers found. The visible layers do not support time control.'
            ],
        }
    }
    const updates = []
    for (const target of targets) {
        if (!target.visible) {
            skipped.push({
                name: target.displayName,
                reason: 'layer is not currently visible',
            })
            continue
        }
        const meta = getLayerTimeMetadata(target.config)
        if (!meta.enabled) {
            skipped.push({
                name: target.displayName,
                reason: 'layer is not time-enabled',
            })
            continue
        }
        const resolution = computeLayerTargetTime(meta, parsedTime)
        if (!resolution.ok || !resolution.iso) {
            const specificReason = resolution.reason === 'no_max_bound' 
                ? 'layer has no time bounds defined'
                : resolution.reason === 'no_min_bound'
                ? 'layer has no time bounds defined'
                : resolution.reason || 'unable to resolve timestamp'
            skipped.push({
                name: target.displayName,
                reason: specificReason,
            })
            continue
        }
        try {
            // Compute the precision-based time range from the user's query.
            // e.g. "Jan 2024" (month) → 2024-01-01 to 2024-01-31T23:59:59Z
            //      "Jan 1, 2024" (day) → 2024-01-01 to 2024-01-01T23:59:59Z
            const queryPrecision = parsedTime.precision || 'day'
            const rangeStartIso = resolution.iso
            const rangeEndIso = (!parsedTime.special && parsedTime.date)
                ? (computePrecisionEndIso(parsedTime.date, queryPrecision) || resolution.iso)
                : resolution.iso

            // Update the main TimeControl timeline using precision-based range
            if (TimeControl && TimeControl.setTime && resolution.iso) {
                TimeControl.setTime(
                    rangeStartIso,
                    rangeEndIso,
                    false, // not relative
                    '00:00:00', // no offset
                    resolution.iso // current time to set
                )
            }

            const applied = api.setLayerTime(
                target.id,
                rangeStartIso,
                rangeEndIso
            )
            if (applied === false) {
                throw new Error('setLayerTime rejected the request.')
            }
            await api.reloadLayer(target.id)
            updates.push({
                name: target.displayName,
                iso: resolution.iso,
                cadence: describeCadence(resolution.cadence),
                rangeStart: resolution.availableStart,
                rangeEnd: resolution.availableEnd,
                outOfRange: resolution.outOfRange,
                notes: resolution.notes || [],
            })
        } catch (err) {
            skipped.push({
                name: target.displayName,
                reason: err?.message || 'failed to update layer time',
            })
        }
    }
    const interpretationLine = parsedTime.iso
        ? `Parsed "${parsedTime.original}" to ${parsedTime.iso}.`
        : parsedTime.special === 'latest'
        ? `Interpreting "${parsedTime.original}" as "latest available date".`
        : parsedTime.special === 'earliest'
        ? `Interpreting "${parsedTime.original}" as "earliest available date".`
        : `Interpreting "${parsedTime.original}" as a time change request.`
    const lines = [
        interpretationLine,
        `Attempting to set the time on ${targets.length} layer${
            targets.length === 1 ? '' : 's'
        }.`,
    ]
    if (updates.length) {
        lines.push(
            `Updated ${updates.length} time-enabled layer${
                updates.length === 1 ? '' : 's'
            }:`
        )
        updates.forEach((entry) => {
            const extras = []
            if (entry.rangeStart || entry.rangeEnd)
                extras.push(
                    `range ${entry.rangeStart || 'unknown'} – ${
                        entry.rangeEnd || 'unknown'
                    }`
                )
            if (entry.outOfRange === 'before')
                extras.push(
                    'requested time was earlier than the available range; using the earliest timestamp'
                )
            else if (entry.outOfRange === 'after')
                extras.push(
                    'requested time was later than the available range; showing the latest timestamp'
                )
            entry.notes.forEach((note) => extras.push(note))
            const suffix = extras.length ? ` (${extras.join('; ')})` : ''
            lines.push(`• ${entry.name}: Displaying data for ${entry.iso}${suffix}`)
        })
    } else {
        lines.push('No layer accepted the time request.')
    }
    if (skipped.length) {
        const skippedNotes = skipped
            .map((item) => `${item.name || 'Layer'} (${item.reason})`)
            .join('; ')
        lines.push(`Skipped: ${skippedNotes}`)
    }
    return { ok: updates.length > 0, lines }
}

export async function set_visible_layers_time(_ctx, payload) {
    const result = await executeVisibleLayersTimeChange(payload)
    if (result.lines.length) appendLine(result.lines.join('\n'))
}

export async function fast_visible_layers_time(payload) {
    return executeVisibleLayersTimeChange(payload)
}

export async function set_opacity(_ctx, payload) {
    const dn = payload?.name
    const opacity = payload?.opacity
    const id = resolveDisplayNameToId(dn)
    if (!id) {
        throw new Error(`Layer "${dn}" not found.`)
    }
    if (typeof opacity !== 'number' || Number.isNaN(opacity)) {
        throw new Error('Opacity must be a valid number.')
    }
    L_.setLayerOpacity(id, opacity)
    appendLine(`Opacity set: ${dn} ${opacity}`)
}

export async function toggle_visibility(_ctx, payload) {
    const dn = payload?.name
    const id = resolveDisplayNameToId(dn)
    if (!id) {
        throw new Error(`Layer "${dn}" not found.`)
    }
    if (typeof payload?.visible !== 'boolean') {
        throw new Error('Visibility toggle requires a boolean "visible" flag.')
    }
    await window.mmgisAPI.toggleLayer(id, payload.visible)
    appendLine(`Toggled: ${dn} -> ${payload.visible ? 'on' : 'off'}`)
}

export async function zoom_view(_ctx, payload) {
    const map = ensureMap()
    if (Array.isArray(payload?.center) && typeof payload?.zoom === 'number') {
        const [lon, lat] = payload.center
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            throw new Error('Center coordinates must be finite numbers.')
        }
        map.setView([lat, lon], payload.zoom)
        appendLine(`Zoomed to center (${lon}, ${lat}) @ z${payload.zoom}`)
        return
    }
    if (Array.isArray(payload?.bbox) && payload.bbox.length === 4) {
        const [minLon, minLat, maxLon, maxLat] = payload.bbox
        if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) {
            throw new Error('Bounding box coordinates must be finite numbers.')
        }
        const bounds = window.L.latLngBounds(
            window.L.latLng(minLat, minLon),
            window.L.latLng(maxLat, maxLon)
        )
        map.fitBounds(bounds, { padding: [16, 16] })
        appendLine('Zoomed to bounding box')
        return
    }
    throw new Error('Zoom request missing center/zoom or bbox parameters.')
}

export async function render_layer_information(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('layer_information requires a layer_name string.')
    }
    const info = await fetchLayerMetadata(layerName)
    if (info.unavailable || !info.items.length) {
        const fallback = await searchLayerInformation(
            layerName,
            payload?.original_query
        )
        const citations = formatCitations(fallback.citations)
        appendLine(
            (fallback.reply || `No information available for ${layerName}.`) +
                (citations ? `\nSources:\n${citations}` : '')
        )
        return
    }
    const item = info.items[0]
    const headline = item.name || layerName
    const summary =
        item.summary && item.summary.trim().length
            ? item.summary.trim()
            : 'No description available.'
    appendLine(
        `${headline}: ${summary}${
            item.citation ? `\nSource: ${item.citation}` : ''
        }`
    )
}

export async function render_layer_mean(_ctx, payload) {
    const { layerMatch, resolvedLayerName, area } = resolveLayerContext(payload)
    if (isExternalTileLayer(layerMatch)) {
        const cfg = layerMatch.layer.config || {}
        let host = ''
        try { host = ` (${new URL(cfg.url || cfg.source).hostname})` } catch (_e) { /* ignore */ }
        appendLine(
            `**${resolvedLayerName}** is served from an external tile service${host}` +
            ` and does not have a local raster file. ` +
            `Raster statistics (mean, min, max, etc.) require a locally hosted COG or GeoTIFF layer. ` +
            `You can still view this layer on the map and use the Time UI to browse available dates.`
        )
        return
    }
    drawAreaHighlight(area, 'mean', { color: '#0ea5e9', fillOpacity: 0.18 })
    const timeTokens = getLayerTimeTokens(layerMatch, payload)
    let analyticsBase = determineAnalyticsEndpoint(layerMatch, null)
    let analyticsLayer = null
    if (analyticsBase) {
        try {
            analyticsLayer = await resolveAnalyticsLayerKey(
                resolvedLayerName,
                layerMatch?.layer?.config,
                analyticsBase
            )
            analyticsBase = determineAnalyticsEndpoint(
                layerMatch,
                analyticsLayer
            )
        } catch (catalogError) {
            console.warn('Analytics catalog unavailable:', catalogError)
            analyticsBase = null
        }
    }
    const timeRange = {
        start:
            timeTokens.startTime ||
            analyticsLayer?.info?.time_range?.start ||
            null,
        end:
            timeTokens.endTime ||
            analyticsLayer?.info?.time_range?.end ||
            null,
    }
    const matchConfidence =
        typeof analyticsLayer?.confidence === 'number'
            ? analyticsLayer.confidence
            : layerMatch?.score ?? null
    let stats = null
    let datasetKey = analyticsLayer?.key || null
    let remoteError = null
    if (analyticsBase) {
        try {
            stats = await fetchAnalyticsStatistics(
                datasetKey,
                area.bbox,
                timeRange,
                resolvedLayerName,
                analyticsBase
            )
        } catch (primaryError) {
            remoteError = primaryError
        }
    }
    if (!stats) {
        try {
            noteLocalAnalytics(resolvedLayerName, 'mean-fallback')
            stats = await calculateLocalBasicStats(layerMatch, area, {
                geometry: payload?.geometry,
                time: timeTokens.time,
                startTime: timeTokens.startTime,
                endTime: timeTokens.endTime,
            })
        } catch (localError) {
            appendLine(
                `Unable to compute mean for ${resolvedLayerName}: ${
                    localError?.message || localError
                }`
            )
            throw localError
        }
    }
    if (remoteError) {
        console.warn('Analytics endpoint failed; used local statistics.', remoteError)
    }

    let quantiles = null
    if (
        typeof stats.q25 === 'number' ||
        typeof stats.q75 === 'number' ||
        typeof stats.median === 'number' ||
        typeof stats.q50 === 'number'
    ) {
        quantiles = {
            quantiles: {
                0.25: stats.q25,
                0.5:
                    typeof stats.median === 'number'
                        ? stats.median
                        : typeof stats.q50 === 'number'
                        ? stats.q50
                        : undefined,
                0.75: stats.q75,
            },
        }
    } else if (
        datasetKey &&
        analyticsBase &&
        !remoteError &&
        stats?.source !== 'local-cog'
    ) {
        try {
            const histogramRaw = await fetchAnalyticsHistogram(
                datasetKey,
                area.bbox,
                timeRange,
                60,
                resolvedLayerName,
                analyticsBase
            )
            const histogram = sanitizeHistogramResponse(histogramRaw)
            const computed = computeHistogramQuantiles(
                histogram,
                [0.25, 0.5, 0.75]
            )
            if (computed && computed.quantiles) {
                quantiles = computed
            }
        } catch (histError) {
            console.warn('Histogram-based quantiles unavailable:', histError)
        }
    }

    const lines = []
    if (matchConfidence !== null && matchConfidence < 0.92) {
        lines.push(
            `Interpreting layer "${payload?.layer_name}" as "${resolvedLayerName}" (confidence ${(
                matchConfidence * 100
            ).toFixed(1)}%).`
        )
        lines.push(
            'Please confirm this is the intended dataset before using the statistics below.'
        )
    } else if (resolvedLayerName !== payload?.layer_name) {
        lines.push(
            `Normalized layer name "${payload?.layer_name}" → "${resolvedLayerName}".`
        )
    } else if (!analyticsLayer?.key && analyticsBase) {
        lines.push(
            'Layer not found in analytics catalog; using default dataset.'
        )
    }
    if (stats?.source === 'local-cog') {
        lines.push(
            'Analytics service unavailable; statistics computed locally from the active raster.'
        )
    }
    lines.push(
        `Confirmed area: ${area.label} (bbox ${area.bbox
            .map((v) => v.toFixed(4))
            .join(', ')})`
    )
    lines.push(
        `Mean: ${stats.mean.toFixed(4)} (std ${
            typeof stats.std === 'number' ? stats.std.toFixed(4) : 'n/a'
        })`
    )
    if (quantiles?.quantiles) {
        const { quantiles: q } = quantiles
        if (typeof q[0.25] === 'number') {
            lines.push(`25th percentile: ${q[0.25].toFixed(4)}`)
        }
        if (typeof q[0.5] === 'number') {
            lines.push(`Median: ${q[0.5].toFixed(4)}`)
        } else if (typeof stats.median === 'number') {
            lines.push(`Median: ${stats.median.toFixed(4)}`)
        }
        if (typeof q[0.75] === 'number') {
            lines.push(`75th percentile: ${q[0.75].toFixed(4)}`)
        }
    } else if (typeof stats.median === 'number') {
        lines.push(`Median: ${stats.median.toFixed(4)}`)
    }
    if (typeof stats.min === 'number') {
        lines.push(`Min: ${stats.min.toFixed(4)}`)
    }
    if (typeof stats.max === 'number') {
        lines.push(`Max: ${stats.max.toFixed(4)}`)
    }
    if (typeof stats.valid_count === 'number') {
        const formatted =
            typeof stats.valid_count.toLocaleString === 'function'
                ? stats.valid_count.toLocaleString()
                : String(stats.valid_count)
        lines.push(`Valid samples: ${formatted}`)
    }
    if (stats.is_sampled) {
        lines.push('Note: statistics computed from sampled data.')
    }

    // Explanation of how the statistics were computed
    lines.push('')
    lines.push('**How these statistics were computed:**')
    if (stats?.source === 'local-cog') {
        lines.push(
            'The raster layer (Cloud-Optimized GeoTIFF) was read directly in the browser using the geotiff.js library. ' +
            'Pixel values within the selected bounding box were extracted, NoData pixels were excluded, ' +
            'and descriptive statistics (mean, std, min, max, median, percentiles) were calculated from the remaining valid samples.'
        )
    } else {
        const layerPath = stats?.layer_path || ''
        lines.push(
            'Statistics were computed on the server by reading the locally hosted raster file' +
            (layerPath ? ` (\`${layerPath.split('/').pop()}\`)` : '') +
            ' using a Python-based raster analysis pipeline (rasterio/numpy). ' +
            'All valid pixels within the requested bounding box were analyzed, excluding NoData values. ' +
            'The result includes descriptive statistics: mean, standard deviation, min, max, median, and interquartile range.'
        )
    }

    appendLine(lines.join('\n'))
}

export async function render_local_calculate_mean(_ctx, payload) {
    try {
        const { resolvedLayerName, area, stats } =
            await computeLocalStatsContext(payload)
        noteLocalAnalytics(resolvedLayerName, 'local-mean')
        drawAreaHighlight(area, 'local-mean', {
            color: '#f97316',
            fillOpacity: 0.18,
        })
        const lines = [
            `Local mean for ${resolvedLayerName}`,
            `Confirmed area: ${area.label} (bbox ${area.bbox
                .map((v) => v.toFixed(4))
                .join(', ')})`,
            `Mean: ${stats.mean.toFixed(4)}`,
            `Standard deviation: ${
                typeof stats.std === 'number' ? stats.std.toFixed(4) : 'n/a'
            }`,
            `Median: ${
                typeof stats.median === 'number' ? stats.median.toFixed(4) : 'n/a'
            }`,
        ]
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local mean: ${error?.message || error}`
        )
        throw error
    }
}

export async function render_local_calculate_minmax(_ctx, payload) {
    try {
        const { resolvedLayerName, area, stats } =
            await computeLocalStatsContext(payload)
        noteLocalAnalytics(resolvedLayerName, 'local-minmax')
        drawAreaHighlight(area, 'local-minmax', {
            color: '#10b981',
            fillOpacity: 0.18,
        })
        const lines = [
            `Local min/max for ${resolvedLayerName}`,
            `Min: ${typeof stats.min === 'number' ? stats.min.toFixed(4) : 'n/a'}`,
            `Max: ${typeof stats.max === 'number' ? stats.max.toFixed(4) : 'n/a'}`,
            `Valid samples: ${
                stats.count.toLocaleString?.() || String(stats.count)
            }`,
        ]
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local min/max: ${error?.message || error}`
        )
        throw error
    }
}

export async function render_local_calculate_std(_ctx, payload) {
    try {
        const { resolvedLayerName, area, stats } =
            await computeLocalStatsContext(payload)
        noteLocalAnalytics(resolvedLayerName, 'local-std')
        drawAreaHighlight(area, 'local-std', {
            color: '#8b5cf6',
            fillOpacity: 0.18,
        })
        const lines = [
            `Local standard deviation for ${resolvedLayerName}`,
            `Std dev: ${
                typeof stats.std === 'number' ? stats.std.toFixed(4) : 'n/a'
            }`,
            `Mean: ${stats.mean.toFixed(4)}`,
            `Valid samples: ${
                stats.count.toLocaleString?.() || String(stats.count)
            }`,
        ]
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local standard deviation: ${
                error?.message || error
            }`
        )
        throw error
    }
}

export async function render_local_calculate_histogram(_ctx, payload) {
    try {
        const { layerMatch, resolvedLayerName, area } = resolveLayerContext(
            payload
        )
        noteLocalAnalytics(resolvedLayerName, 'local-histogram')
        drawAreaHighlight(area, 'local-histogram', {
            color: '#0284c7',
            fillOpacity: 0.18,
        })
        const timeTokens = getLayerTimeTokens(layerMatch, payload)
        const result = await calculateLocalHistogram(layerMatch, area, {
            geometry: payload?.geometry,
            bins: Number(payload?.bins) || 20,
            time: timeTokens.time,
            startTime: timeTokens.startTime,
            endTime: timeTokens.endTime,
        })
        const lines = [
            `Local histogram for ${resolvedLayerName} (${result.histogram.counts.length} bins)`,
        ]
        const previewCount = Math.min(5, result.histogram.counts.length)
        for (let i = 0; i < previewCount; i += 1) {
            const start = result.histogram.edges[i]
            const end = result.histogram.edges[i + 1]
            const count = result.histogram.counts[i]
            lines.push(
                `Bin ${i + 1}: [${start.toFixed(3)}, ${end.toFixed(3)}) → ${count}`
            )
        }
        if (result.histogram.counts.length > previewCount) {
            lines.push(
                `… ${
                    result.histogram.counts.length - previewCount
                } additional bins omitted from preview.`
            )
        }
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local histogram: ${error?.message || error}`
        )
        throw error
    }
}

export async function render_local_threshold_mask(_ctx, payload) {
    try {
        const { layerMatch, resolvedLayerName, area } = resolveLayerContext(
            payload
        )
        const operator =
            typeof payload?.operator === 'string' && payload.operator.trim()
                ? payload.operator.trim()
                : '>'
        const value = Number(payload?.value)
        if (!Number.isFinite(value)) {
            throw new Error(
                'local_threshold_mask requires a numeric "value" to compare against.'
            )
        }
        noteLocalAnalytics(resolvedLayerName, 'local-threshold')
        const result = await calculateLocalThresholdMask(layerMatch, area, {
            operator,
            value,
            geometry: payload?.geometry,
            maxPoints: Number(payload?.max_points) || undefined,
        })
        if (!result.matchCount) {
            ensureOverlayGroup('local-threshold')
            appendLine(
                `No pixels in ${resolvedLayerName} satisfied ${operator} ${value}.`
            )
            return
        }
        const points = result.matches.map((pt) => ({
            lat: pt.lat,
            lon: pt.lon,
        }))
        drawLocalThresholdOverlay(points)
        const coveragePct = (result.coverage * 100).toFixed(2)
        const lines = [
            `Local threshold mask for ${resolvedLayerName} (${operator} ${value})`,
            `Matches: ${result.matchCount.toLocaleString()} of ${result.totalCount.toLocaleString()} pixels (${coveragePct}% coverage).`,
        ]
        if (result.matchCount > points.length) {
            lines.push(
                `Displayed ${points.length.toLocaleString()} representative points on the map (sampled from ${result.matchCount.toLocaleString()} matches).`
            )
        } else {
            lines.push('All matching pixels are visualized on the map.')
        }
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local threshold mask: ${error?.message || error}`
        )
        throw error
    }
}

export async function render_contour_overlay(_ctx, payload) {
    const layerName = payload?.layer_name
    const variable = payload?.variable
    const operator = payload?.operator
    const value = payload?.value
    if (
        !layerName ||
        !variable ||
        typeof operator !== 'string' ||
        typeof value !== 'number'
    ) {
        throw new Error(
            'visualize_contours requires layer_name, variable, operator, and numeric value.'
        )
    }
    const area = resolveArea(payload?.geographical_area || 'current view')
    if (!area) {
        throw new Error('Unable to determine area for contour overlay.')
    }
    const index = buildLayerIndex()
    const layerMatch = findLayerMatch(layerName, index)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(
            `Unable to locate configuration for layer "${layerName}".`
        )
    }
    const layerMeta = layerMatch.layer || {}
    const layerConfig =
        (layerMeta.config && typeof layerMeta.config === 'object'
            ? layerMeta.config
            : layerMeta) || {}
    const sourceUrl =
        layerConfig.cogUrl ||
        layerConfig.url ||
        layerConfig.source ||
        layerConfig.path ||
        layerConfig.href ||
        layerMeta.cogUrl ||
        layerMeta.url ||
        layerMeta.source ||
        layerMeta.path ||
        layerMeta.href ||
        layerMeta.liveInstance?.cogUrl ||
        layerMeta.liveInstance?.url ||
        layerMeta.liveInstance?.options?.url ||
        layerMeta.liveInstance?.options?.source
    let resolvedSourceUrl =
        typeof sourceUrl === 'string' ? sourceUrl.trim() : ''
    if (!resolvedSourceUrl) {
        throw new Error(
            `Layer "${layerName}" is missing a COG source URL for highlighting.`
        )
    }

    // Resolve {time} placeholder using the current TimeControl time
    if (resolvedSourceUrl.includes('{time}')) {
        const timeFmt = layerConfig.time?.format || '%Y-%m-%dT%H:%M:%SZ'
        const currentIso =
            TimeControl.endTime || TimeControl.currentTime || ''
        if (currentIso) {
            const d = new Date(currentIso)
            const pad2 = (n) => String(n).padStart(2, '0')
            const formatted = timeFmt
                .replace('%Y', String(d.getUTCFullYear()).padStart(4, '0'))
                .replace('%m', pad2(d.getUTCMonth() + 1))
                .replace('%d', pad2(d.getUTCDate()))
                .replace('%H', pad2(d.getUTCHours()))
                .replace('%M', pad2(d.getUTCMinutes()))
                .replace('%S', pad2(d.getUTCSeconds()))
                .replace('T', 'T')
                .replace('Z', 'Z')
            resolvedSourceUrl = resolvedSourceUrl
                .replace(/{time}/g, formatted)
                .replace(/{starttime}/g, formatted)
                .replace(/{endtime}/g, formatted)
        }
    }

    // Resolve relative path using L_.getUrl() so TiTiler can find the file
    resolvedSourceUrl = L_.getUrl('tile', resolvedSourceUrl, layerConfig)

    const baseRoot = `${window.location.origin}${(
        window.location.pathname || ''
    ).replace(/\/$/g, '')}`
    const tileMatrixSet = layerConfig.tileMatrixSet || 'WebMercatorQuad'
    const tileMatrixStr = String(tileMatrixSet)
    const colormapStops = '0:0,0,0,0|1:255,240,0,90'
    const params = new URLSearchParams()
    params.set('url', resolvedSourceUrl)
    params.set('expression', `(b1>${value})`)
    params.set('resampling', 'nearest')
    params.set('colormap', colormapStops)

    const highlightUrl = `${baseRoot}/titiler/cog/tiles/${tileMatrixStr}/{z}/{x}/{y}.png?${params.toString()}`
    const map = ensureMap()
    const store = (window.__mmgisAgentChatOverlays =
        window.__mmgisAgentChatOverlays || {})
    if (store.contourTile && typeof store.contourTile.remove === 'function') {
        try {
            store.contourTile.remove()
        } catch (_) {}
    }
    store.contourTile = window.L.tileLayer(highlightUrl, {
        opacity: 1,
        interactive: false,
        pane: 'overlayPane',
        tms: tileMatrixStr.toLowerCase().includes('tms')
            ? true
            : layerConfig.tileformat === 'tms' ||
              layerConfig.tms === true ||
              false,
        zIndex: 650,
    })
    store.contourTile.addTo(map)

    const focusBbox =
        (Array.isArray(layerMatch.bbox) && layerMatch.bbox.slice()) ||
        (Array.isArray(layerConfig.boundingBox) && layerConfig.boundingBox) ||
        null
    if (isValidBbox(focusBbox)) {
        const bounds = window.L.latLngBounds(
            window.L.latLng(focusBbox[1], focusBbox[0]),
            window.L.latLng(focusBbox[3], focusBbox[2])
        )
        map.fitBounds(bounds, { padding: [20, 20] })
    }

    const descriptor = `${layerName} where ${variable} ${operator} ${value}`
    const timePart =
        typeof payload?.time === 'string' && payload.time
            ? ` at ${payload.time}`
            : ''
    appendLine(
        `Contour overlay prepared for ${descriptor}${timePart} using dynamic highlight tiles.`
    )
}

export async function render_layer_difference(_ctx, payload) {
    const layerA = payload?.layer_a
    const layerB = payload?.layer_b
    if (!layerA || !layerB) {
        throw new Error(
            'calculate_layer_difference requires layer_a and layer_b.'
        )
    }
    const index = buildLayerIndex()
    const matchA = findLayerMatch(layerA, index)
    const matchB = findLayerMatch(layerB, index)
    if (!matchA || !matchB) {
        throw new Error('Unable to match the requested layers for difference.')
    }

    // Ensure both layers are visible before comparing
    const api = window.mmgisAPI
    if (api && api.toggleLayer) {
        if (!matchA.layer?.visible) {
            try { api.toggleLayer(matchA.id || matchA.layer?.name, true) } catch (_) {}
            appendLine(`Turned on layer: **${matchA.displayName}**`)
        }
        if (!matchB.layer?.visible) {
            try { api.toggleLayer(matchB.id || matchB.layer?.name, true) } catch (_) {}
            appendLine(`Turned on layer: **${matchB.displayName}**`)
        }
    }

    // Get current map time
    let currentTimeStr = ''
    try {
        const tc = TimeControl
        const t = tc?.getTime?.() || tc?.currentTime || tc?.getCurrent?.() || null
        if (t) {
            currentTimeStr = typeof t === 'string' ? t : new Date(t).toISOString()
        }
        // Also try layer live instance time
        if (!currentTimeStr) {
            const optsA = matchA?.layer?.liveInstance?.options || {}
            const optsB = matchB?.layer?.liveInstance?.options || {}
            currentTimeStr = optsA.endtime || optsA.starttime || optsB.endtime || optsB.starttime || ''
        }
    } catch (_) {}

    const timeLabel = currentTimeStr ? currentTimeStr.split('T')[0] : 'latest available'
    appendLine(`Computing pixel-by-pixel difference for **${timeLabel}**: **${matchA.displayName}** minus **${matchB.displayName}**...`)

    // Use the backend analytics/difference endpoint which works with actual tiff files
    try {
        const origin = window.location.origin
        const pathname = (window.location.pathname || '').replace(/\/$/g, '')
        const nameA = encodeURIComponent(matchA.displayName || matchA.layer?.name || layerA)
        const nameB = encodeURIComponent(matchB.displayName || matchB.layer?.name || layerB)
        const timeParam = currentTimeStr ? `&time=${encodeURIComponent(currentTimeStr)}` : ''
        const missionParam = L_.mission ? `&mission=${encodeURIComponent(L_.mission)}` : ''
        const url = `${origin}${pathname}/api/agent/analytics/difference?layer_a=${nameA}&layer_b=${nameB}${timeParam}${missionParam}`

        const res = await fetch(url)
        const data = await res.json()

        if (!res.ok || data.error) {
            throw new Error(data.error || `Server returned ${res.status}`)
        }

        // Display results
        const lines = []
        lines.push(`\n**Difference: ${matchA.displayName} - ${matchB.displayName}**`)
        lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

        const scale = (data.mean_a != null && data.mean_a <= 1.0) ? 100 : 1
        const unit = scale === 100 ? '%' : ''

        if (data.mean_a != null) lines.push(`**${matchA.displayName}** mean: ${(data.mean_a * scale).toFixed(1)}${unit}`)
        if (data.mean_b != null) lines.push(`**${matchB.displayName}** mean: ${(data.mean_b * scale).toFixed(1)}${unit}`)
        lines.push('')
        lines.push(`**Difference Statistics:**`)
        lines.push(`Mean: ${(data.mean * scale).toFixed(2)}${unit}`)
        lines.push(`Std Dev: ${(data.std * scale).toFixed(2)}${unit}`)
        lines.push(`Min: ${(data.min * scale).toFixed(2)}${unit}, Max: ${(data.max * scale).toFixed(2)}${unit}`)
        lines.push(`Median: ${(data.median * scale).toFixed(2)}${unit}`)
        lines.push(`25th percentile: ${(data.q25 * scale).toFixed(2)}${unit}`)
        lines.push(`75th percentile: ${(data.q75 * scale).toFixed(2)}${unit}`)
        lines.push('')
        lines.push(`Valid pixels: ${data.valid_count?.toLocaleString()} / ${data.total_count?.toLocaleString()}`)

        // Interpretation
        lines.push('')
        const absMean = Math.abs(data.mean * scale)
        if (absMean < 1) {
            lines.push('The two datasets show good agreement (mean difference < 1' + unit + ')')
        } else if (data.mean > 0) {
            lines.push(`Prediction is ${absMean.toFixed(1)}${unit} higher than ground truth on average`)
        } else {
            lines.push(`Ground truth is ${absMean.toFixed(1)}${unit} higher than prediction on average`)
        }

        appendLine(lines.join('\n'))
    } catch (error) {
        console.error('Layer difference failed:', error)
        appendLine(`Failed to compute difference: ${error.message}`)
    }
}

function renderSimulatedDifference(matchA, matchB, area) {
    const diffValue = deterministicNumber(
        `${normalizeName(matchA.displayName)}-${normalizeName(matchB.displayName)}`,
        -25,
        25
    )
    const positive = diffValue >= 0
    const color = positive ? '#2563eb' : '#d97706'
    const { group, bounds } = drawAreaHighlight(area, 'difference', {
        color,
        fillOpacity: 0.32,
    })
    const diagonal = window.L.polyline(
        [
            [area.bbox[1], area.bbox[0]],
            [area.bbox[3], area.bbox[2]],
        ],
        { color, weight: 1, dashArray: '6 8' }
    )
    diagonal.addTo(group)
    appendLine(
        `Simulated difference (${matchA.displayName} - ${matchB.displayName}): ${diffValue.toFixed(2)}`
    )
    appendLine(`Note: This is a placeholder value. Real data analysis requires COG sources.`)
    ensureMap().fitBounds(bounds, { padding: [18, 18] })
}

function displayDifferenceOverlay(visualization, area) {
    const map = ensureMap()
    const bounds = L.latLngBounds(
        [area.bbox[1], area.bbox[0]],
        [area.bbox[3], area.bbox[2]]
    )
    
    // Create image overlay from canvas
    const imageOverlay = L.imageOverlay(
        visualization.dataUrl,
        bounds,
        {
            opacity: 0.7,
            interactive: false
        }
    )
    
    // Store in overlays
    const store = window.__mmgisAgentChatOverlays = window.__mmgisAgentChatOverlays || {}
    if (store.differenceOverlay) {
        store.differenceOverlay.remove()
    }
    store.differenceOverlay = imageOverlay
    imageOverlay.addTo(map)
    
    // Add legend
    addDifferenceLegend(visualization.colorScale)
}

export async function render_layer_summary(_ctx, payload) {
    const name = payload?.name
    if (!name) {
        appendLine('No layer name provided for summary.')
        return
    }
    const index = buildLayerIndex()
    const match = findLayerMatch(name, index)
    if (!match) {
        appendLine(`Unable to find layer "${name}" for summary.`)
        return
    }
    appendLine(`Layer: ${match.displayName}`)
    appendLine(`Type: ${match.type || 'Unknown'}`)
    appendLine(`Visible: ${match.visible ? 'Yes' : 'No'}`)
    if (match.opacity !== undefined) {
        appendLine(`Opacity: ${(match.opacity * 100).toFixed(0)}%`)
    }
    if (match.bbox) {
        const [west, south, east, north] = match.bbox
        appendLine(
            `Bounds: ${west.toFixed(2)}, ${south.toFixed(2)}, ${east.toFixed(
                2
            )}, ${north.toFixed(2)}`
        )
    }
}

// ——— Threshold highlight overlay (ephemeral) ————————————————————————
function parseUnits(raw, fallback = 1) {
    const s = String(raw || '')
        .trim()
        .toLowerCase()
    if (!s) return fallback
    if (s === 'm' || s === 'meter' || s === 'meters') return 1
    if (s === 'cm' || s === 'centimeter' || s === 'centimeters') return 0.01
    if (s === 'mm' || s === 'millimeter' || s === 'millimeters') return 0.001
    return fallback
}

function getHighlightStore() {
    const store = (window.__mmgisAgentChatOverlays =
        window.__mmgisAgentChatOverlays || {})
    return store
}

export async function render_threshold_highlight(_ctx, payload) {
    const variable = (
        payload?.variable ||
        payload?.name ||
        payload?.layer_name ||
        ''
    ).toString()
    const operator = (payload?.operator || '>').toString()
    let value = Number(payload?.value)
    if (!Number.isFinite(value)) {
        throw new Error(
            "I couldn't parse a numeric threshold. Try, e.g., 'ssha > 0.2 m'."
        )
    }
    const unitMult = parseUnits(payload?.unit, 1)
    value = value * unitMult

    const index = buildLayerIndex()
    const q = normalizeName(variable)
    // Search visible layers first, then fall back to all layers
    let candidates = index
        .filter((i) => i.visible)
        .filter((i) =>
            i.normalizedAliases.some((a) => a.normalized.includes(q))
        )
    if (!candidates.length) {
        candidates = index.filter((i) =>
            i.normalizedAliases.some((a) => a.normalized.includes(q))
        )
    }
    if (!candidates.length) {
        appendLine(
            `I couldn't find a ${variable} layer to highlight.`
        )
        return
    }
    const target = candidates[candidates.length - 1]
    const layerName = target.displayName || target.name

    // Auto-turn on the layer if it's not visible
    if (!target.visible) {
        const api = window.mmgisAPI
        if (api?.toggleLayer) {
            await api.toggleLayer(target.name, true)
        }
    }

    const layerMeta = target || {}
    const layerConfig =
        (layerMeta && layerMeta.config ? layerMeta.config : layerMeta) || {}
    const sourceUrl =
        layerConfig.cogUrl ||
        layerConfig.url ||
        layerConfig.source ||
        layerConfig.path ||
        layerConfig.href ||
        layerMeta.cogUrl ||
        layerMeta.url ||
        layerMeta.source ||
        layerMeta.path ||
        layerMeta.href ||
        layerMeta.liveInstance?.cogUrl ||
        layerMeta.liveInstance?.url ||
        layerMeta.liveInstance?.options?.url ||
        layerMeta.liveInstance?.options?.source
    let resolvedSourceUrl =
        typeof sourceUrl === 'string' ? sourceUrl.trim() : ''
    if (!resolvedSourceUrl) {
        throw new Error(
            `Layer "${layerName}" is missing a COG source URL for highlighting.`
        )
    }

    // Resolve {time} placeholder using the current TimeControl time
    if (resolvedSourceUrl.includes('{time}')) {
        const timeFmt = layerConfig.time?.format || '%Y-%m-%dT%H:%M:%SZ'
        const currentIso =
            TimeControl.endTime || TimeControl.currentTime || ''
        if (currentIso) {
            const d = new Date(currentIso)
            const pad2 = (n) => String(n).padStart(2, '0')
            const formatted = timeFmt
                .replace('%Y', String(d.getUTCFullYear()).padStart(4, '0'))
                .replace('%m', pad2(d.getUTCMonth() + 1))
                .replace('%d', pad2(d.getUTCDate()))
                .replace('%H', pad2(d.getUTCHours()))
                .replace('%M', pad2(d.getUTCMinutes()))
                .replace('%S', pad2(d.getUTCSeconds()))
                .replace('T', 'T')
                .replace('Z', 'Z')
            resolvedSourceUrl = resolvedSourceUrl
                .replace(/{time}/g, formatted)
                .replace(/{starttime}/g, formatted)
                .replace(/{endtime}/g, formatted)
        }
    }

    // For STAC collection layers, resolve to an actual COG file via the backend
    if (resolvedSourceUrl.toLowerCase().startsWith('stac-collection:') ||
        (layerConfig.sourceType || '').toLowerCase() === 'stac-collection') {
        const collectionName = resolvedSourceUrl.replace(/^stac-collection:/i, '').split('?')[0]
        try {
            const origin = window.location.origin
            const pathname = (window.location.pathname || '').replace(/\/$/g, '')
            const missionParam = L_.mission
                ? `&mission=${encodeURIComponent(L_.mission)}`
                : ''
            const cogRes = await fetch(
                `${origin}${pathname}/api/agent/analytics/resolve-cog?layer=${encodeURIComponent(collectionName)}${missionParam}`
            )
            if (cogRes.ok) {
                const cogData = await cogRes.json()
                if (cogData.url) {
                    resolvedSourceUrl = cogData.url
                }
            }
        } catch (_) {}
    }

    // Resolve relative path using L_.getUrl() so TiTiler can find the file
    // (adds mission path prefix and ../../ for non-Docker environments)
    if (!resolvedSourceUrl.startsWith('/Missions')) {
        resolvedSourceUrl = L_.getUrl('tile', resolvedSourceUrl, layerConfig)
    }

    // If value looks like a percentage (>=1) but data is 0-1, convert
    if (value >= 1 && layerConfig.cogMax != null && layerConfig.cogMax <= 1) {
        value = value / 100
    }

    const map = ensureMap()
    const store = getHighlightStore()
    if (
        store.highlightTile &&
        typeof store.highlightTile.remove === 'function'
    ) {
        try {
            store.highlightTile.remove()
        } catch (_) {}
    }
    const tileMatrixSet = layerConfig.tileMatrixSet || 'WebMercatorQuad'
    const tileMatrixStr = String(tileMatrixSet)
    const baseRoot = `${window.location.origin}${(
        window.location.pathname || ''
    ).replace(/\/$/g, '')}`

    const op =
        operator === '>=' ||
        operator === '<=' ||
        operator === '<' ||
        operator === '>'
            ? operator
            : '>'
    // Multiply boolean by 1 to produce numeric 0/1 (TiTiler can't render bool).
    // rescale=0,1 maps 0→0 and 1→255 in pixel space.
    // Colormap keys must match the RESCALED pixel values (0 and 255).
    const expr = `(b1${op}${value})*1`
    const params = new URLSearchParams()
    params.set('url', resolvedSourceUrl)
    params.set('expression', expr)
    params.set('resampling', 'nearest')
    params.set('rescale', '0,1')
    params.set(
        'colormap',
        JSON.stringify({ '0': [0, 0, 0, 0], '255': [255, 255, 0, 255] })
    )

    store.highlightTile = window.L.tileLayer(
        `${baseRoot}/titiler/cog/tiles/${tileMatrixStr}/{z}/{x}/{y}.png?${params.toString()}`,
        {
            opacity: 0.6,
            interactive: false,
            pane: 'overlayPane',
            zIndex: 650,
            tms: tileMatrixStr.toLowerCase().includes('tms')
                ? true
                : layerConfig.tileformat === 'tms' ||
                  layerConfig.tms === true ||
                  false,
        }
    )
    store.highlightTile.addTo(map)

    const nameText = `Highlight: ${variable} ${op} ${payload?.value}${
        payload?.unit ? ' ' + payload.unit : ''
    }`
    appendLine(`${nameText} on ${layerName}`)
}

export async function highlight_toggle() {
    const store = getHighlightStore()
    const tile = store.highlightTile
    if (!tile) {
        appendLine('No highlight overlay to hide/show.')
        return
    }
    const current = tile.options.opacity ?? 0.2
    const isHidden = current <= 0.001
    const next = isHidden ? store.highlightOpacity ?? 0.2 : 0
    tile.setOpacity(next)
}

export async function highlight_clear() {
    const store = getHighlightStore()
    const tile = store.highlightTile
    if (tile && typeof tile.remove === 'function') {
        try {
            tile.remove()
            store.highlightTile = null
            appendLine('Cleared highlight overlay.')
        } catch (_) {}
    } else {
        appendLine('No highlight overlay to clear.')
    }
}

export async function highlight_opacity(_ctx, payload) {
    const delta = Number(payload?.delta)
    const store = getHighlightStore()
    const tile = store.highlightTile
    if (!tile) {
        appendLine('No highlight overlay to adjust.')
        return
    }
    const cur = Number(tile.options.opacity ?? 0.2)
    const next = Math.max(
        0.05,
        Math.min(0.4, cur + (Number.isFinite(delta) ? delta : 0))
    )
    store.highlightOpacity = next
    tile.setOpacity(next)
    appendLine(`Highlight opacity set to ${next.toFixed(2)}.`)
}

export async function render_anomaly_detection(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('anomaly_detection requires a layer_name string.')
    }
    
    // For now, provide a simulated anomaly detection result
    // In production, this would connect to actual data analytics services
    
    const area = payload?.geographical_area || payload?.area || 'Arctic Ocean'
    const timeStr = payload?.time_start ? ` for ${payload.time_start}` : ' for November 2024'
    
    // Simulated statistics (placeholder until real analytics backend is wired)
    const simulatedStats = {
        mean: 1.234,
        std: 0.456,
        min: -0.5,
        max: 3.8,
        median: 1.15,
        q25: 0.95,
        q75: 1.55,
        valid_count: 1248576
    }
    
    // Calculate anomaly thresholds
    const threshold = payload?.threshold || 2.5
    const lowerBound = simulatedStats.mean - (threshold * simulatedStats.std)
    const upperBound = simulatedStats.mean + (threshold * simulatedStats.std)
    const iqr = simulatedStats.q75 - simulatedStats.q25
    const lowerFence = simulatedStats.q25 - (1.5 * iqr)
    const upperFence = simulatedStats.q75 + (1.5 * iqr)
    
    // Build result message
    const lines = []
    lines.push(`Anomaly Detection: ${layerName}${timeStr}`)
    lines.push(`Area: ${area}`)
    lines.push('')
    lines.push('Data Statistics:')
    lines.push(`  Mean: ${simulatedStats.mean.toFixed(3)}m ± ${simulatedStats.std.toFixed(3)}m`)
    lines.push(`  Median: ${simulatedStats.median.toFixed(3)}m`)
    lines.push(`  Range: [${simulatedStats.min.toFixed(3)}m, ${simulatedStats.max.toFixed(3)}m]`)
    lines.push(`  Valid pixels: ${simulatedStats.valid_count.toLocaleString()}`)
    lines.push('')
    lines.push(`Z-Score Analysis (±${threshold}σ):`)
    lines.push(`  Normal range: [${lowerBound.toFixed(3)}m, ${upperBound.toFixed(3)}m]`)
    
    // Check for anomalies
    const anomalies = []
    if (simulatedStats.min < lowerBound) {
        anomalies.push(`  [WARNING] Extreme low: ${simulatedStats.min.toFixed(3)}m (${((simulatedStats.min - simulatedStats.mean) / simulatedStats.std).toFixed(1)}σ)`)
    }
    if (simulatedStats.max > upperBound) {
        anomalies.push(`  [WARNING] Extreme high: ${simulatedStats.max.toFixed(3)}m (${((simulatedStats.max - simulatedStats.mean) / simulatedStats.std).toFixed(1)}σ)`)
    }
    
    if (anomalies.length > 0) {
        lines.push(...anomalies)
    } else {
        lines.push('  [OK] No z-score anomalies detected')
    }
    
    lines.push('')
    lines.push('IQR Analysis:')
    lines.push(`  Q1: ${simulatedStats.q25.toFixed(3)}m`)
    lines.push(`  Q3: ${simulatedStats.q75.toFixed(3)}m`)
    lines.push(`  IQR: ${iqr.toFixed(3)}m`)
    lines.push(`  Outlier bounds: [${lowerFence.toFixed(3)}m, ${upperFence.toFixed(3)}m]`)
    
    // Check for IQR outliers
    const outliers = []
    if (simulatedStats.min < lowerFence) {
        outliers.push(`  [WARNING] Lower outlier: ${simulatedStats.min.toFixed(3)}m`)
    }
    if (simulatedStats.max > upperFence) {
        outliers.push(`  [WARNING] Upper outlier: ${simulatedStats.max.toFixed(3)}m`)
    }
    
    if (outliers.length > 0) {
        lines.push(...outliers)
    } else {
        lines.push('  [OK] No IQR outliers detected')
    }
    
    // Summary
    lines.push('')
    const totalAnomalies = anomalies.length + outliers.length
    if (totalAnomalies > 0) {
        lines.push(`[ALERT] Summary: ${totalAnomalies} potential anomaly(ies) detected`)
        lines.push('These values represent statistically significant deviations from the mean.')
        lines.push('Further investigation recommended for extreme values.')
    } else {
        lines.push('[PASS] Summary: No significant statistical anomalies detected')
        lines.push('The data appears to follow a normal distribution.')
    }
    
    // Add visualization note
    if (payload?.visualize !== false) {
        lines.push('')
        lines.push('Note: In a full implementation, anomalous regions would be highlighted on the map.')
    }
    
    appendLine(lines.join('\n'))
}

export async function render_multilayer_statistics(_ctx, payload) {
    const layerNames = payload?.layer_names || payload?.layers
    if (!Array.isArray(layerNames) || layerNames.length < 2) {
        throw new Error('multi_layer_statistics requires at least 2 layer names.')
    }

    const area = payload?.area || payload?.geographical_area || 'current view'
    const timeRange = payload?.time_range
    const includeCorrelation = payload?.include_correlation !== false

    try {
        const results = await calculateMultiLayerStats(layerNames, {
            area,
            timeRange,
            includeCorrelation,
        })

        const formattedOutput = formatMultiLayerResults(results)
        appendLine(formattedOutput)

        const resolvedArea = resolveArea(area)
        if (resolvedArea) {
            drawAreaHighlight(resolvedArea, 'multilayer-stats', {
                color: '#6366f1',
                fillOpacity: 0.15,
            })
        }

    } catch (error) {
        appendLine(`Multi-layer analysis failed: ${error?.message || error}`)
        throw error
    }
}

export async function render_temporal_trends(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('temporal_trends requires a layer_name string.')
    }

    const area = payload?.area || payload?.geographical_area || 'current view'
    const startTime = payload?.time_start || payload?.start_time || null
    const endTime = payload?.time_end || payload?.end_time || null
    const interval = payload?.interval || 'monthly'

    // Resolve the layer so we can pass it through to the calculation
    const layerMatch = findLayerMatch(layerName)

    try {
        const results = await calculateTemporalTrends(layerName, {
            area,
            startTime,
            endTime,
            interval,
            layerMatch,
        })

        const formattedOutput = formatTemporalTrendResults(results)
        appendLine(formattedOutput)

        // Highlight the analysis area on the map
        const resolvedArea = resolveArea(area)
        if (resolvedArea) {
            drawAreaHighlight(resolvedArea, 'temporal-trends', {
                color: '#f59e0b',
                fillOpacity: 0.15,
                dashArray: '6 4',
            })
        }

    } catch (error) {
        appendLine(`Temporal trend analysis failed: ${error?.message || error}`)
        throw error
    }
}

export async function render_spatial_statistics(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('spatial_statistics requires a layer_name string.')
    }

    const area = payload?.area || payload?.geographical_area || 'current view'
    const gridSize = payload?.grid_size || 16
    const analysisType = payload?.analysis_type || 'moran'

    const layerMatch = findLayerMatch(layerName)

    try {
        const results = await calculateSpatialStatistics(layerName, {
            area,
            gridSize,
            analysisType,
            layerMatch,
        })

        const formattedOutput = formatSpatialStatsResults(results)
        appendLine(formattedOutput)

        // Draw spatial hotspots/coldspots if visualization requested
        if (payload?.visualize !== false && results.spatialStats) {
            const resolvedArea = resolveArea(area)
            if (resolvedArea) {
                drawAreaHighlight(resolvedArea, 'spatial-analysis', {
                    color: '#8b5cf6',
                    fillOpacity: 0.15,
                    dashArray: '4 6'
                })
            }
        }

    } catch (error) {
        appendLine(`Spatial statistics analysis failed: ${error?.message || error}`)
        throw error
    }
}

export async function render_change_detection(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('change_detection requires a layer_name string.')
    }

    const area = payload?.area || payload?.geographical_area || 'current view'
    const beforeTime = payload?.before_time || payload?.time_start || null
    const afterTime = payload?.after_time || payload?.time_end || null
    const changeThreshold = payload?.threshold || 0.1

    const layerMatch = findLayerMatch(layerName)

    try {
        const results = await calculateChangeDetection(layerName, {
            area,
            beforeTime,
            afterTime,
            changeThreshold,
            layerMatch,
        })

        const formattedOutput = formatChangeDetectionResults(results)
        appendLine(formattedOutput)

        // Draw area if visualization requested
        if (payload?.visualize !== false) {
            const resolvedArea = resolveArea(area)
            if (resolvedArea) {
                const changeColor = results.changes.meanChange > 0 ? '#22c55e' : '#ef4444'
                drawAreaHighlight(resolvedArea, 'change-detection', {
                    color: changeColor,
                    fillOpacity: 0.2
                })
            }
        }

    } catch (error) {
        appendLine(`Change detection analysis failed: ${error?.message || error}`)
        throw error
    }
}

export async function render_time_series_animation(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('time_series_animation requires a layer_name string.')
    }
    
    // Intelligent layer management: find and enable target layer, disable others
    const index = buildLayerIndex()
    const targetLayerMatch = findLayerMatch(layerName, index)
    
    // Layers to keep visible during animation (base/reference layers)
    const KEEP_VISIBLE_LAYERS = [
        'areas of interest',
        'land mask',
        'gibs modis true color',
        'modis true color',
        'polar countries',
        'coastlines',
        'boundaries'
    ]
    
    function shouldKeepVisible(layerName) {
        const normalizedName = layerName.toLowerCase()
        return KEEP_VISIBLE_LAYERS.some(keepLayer => 
            normalizedName.includes(keepLayer.toLowerCase()) ||
            keepLayer.toLowerCase().includes(normalizedName)
        )
    }
    
    if (targetLayerMatch) {
        const targetLayerName = targetLayerMatch.displayName || targetLayerMatch.name
        
        // Get list of currently visible layers
        const currentlyVisible = index.filter(layer => layer.visible)
        
        // Turn off data layers but keep base/reference layers
        const layersToDisable = []
        
        for (const visibleLayer of currentlyVisible) {
            const visibleLayerName = visibleLayer.displayName || visibleLayer.name
            
            // Skip if it's the target layer or a layer we want to keep visible
            if (visibleLayerName !== targetLayerName && !shouldKeepVisible(visibleLayerName)) {
                try {
                    window.mmgisAPI.toggleLayer(visibleLayer.id, false)
                    layersToDisable.push(visibleLayerName)
                } catch (e) {
                    console.warn(`Failed to turn off layer ${visibleLayerName}:`, e)
                }
            }
        }
        
        // Turn on the target layer if it's not already visible
        if (!targetLayerMatch.visible) {
            try {
                window.mmgisAPI.toggleLayer(targetLayerMatch.id, true)
                appendLine(`Enabled layer: ${targetLayerName}`)
            } catch (e) {
                console.warn(`Failed to turn on layer ${targetLayerName}:`, e)
            }
        }
        
        // Report which layers were disabled
        if (layersToDisable.length > 0) {
            appendLine(`Disabled data layers for animation: ${layersToDisable.join(', ')}`)
        }
        
        // Report which base layers are kept visible
        const keptVisible = currentlyVisible.filter(layer => {
            const layerName = layer.displayName || layer.name
            return layerName !== targetLayerName && shouldKeepVisible(layerName)
        })
        
        if (keptVisible.length > 0) {
            const keptNames = keptVisible.map(layer => layer.displayName || layer.name).join(', ')
            appendLine(`Keeping base layers visible: ${keptNames}`)
        }
    }
    
    // Only pass options the LLM explicitly provided; let
    // createTimeSeriesAnimation infer defaults from the layer config.
    const animOpts = {
        frameRate: payload?.frame_rate || 1000,
        loopMode: payload?.loop_mode || 'loop',
        area: payload?.area || payload?.geographical_area,
    }
    if (payload?.time_start || payload?.start_time)
        animOpts.startTime = payload.time_start || payload.start_time
    if (payload?.time_end || payload?.end_time)
        animOpts.endTime = payload.time_end || payload.end_time
    if (payload?.interval)
        animOpts.interval = payload.interval

    try {
        const results = await createTimeSeriesAnimation(layerName, animOpts)
        
        const formattedOutput = formatAnimationResults(results)
        appendLine(formattedOutput)
        
        // Auto-start animation if requested
        if (payload?.auto_play) {
            results.controls.play()
            appendLine('[PLAYING] Animation started')
        }
        
    } catch (error) {
        appendLine(`Time series animation failed: ${error?.message || error}`)
        throw error
    }
}

export async function render_data_export(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('data_export requires a layer_name string.')
    }
    
    const format = payload?.format || 'csv'
    const area = payload?.area || payload?.geographical_area || 'current view'
    
    try {
        const results = await exportLayerData(layerName, {
            format,
            area,
            timeRange: payload?.time_range,
            includeMetadata: payload?.include_metadata !== false,
            compression: payload?.compression || false,
            resolution: payload?.resolution || 'medium'
        })
        
        const formattedOutput = formatExportResults(results)
        appendLine(formattedOutput)
        
        // Auto-download if requested
        if (payload?.auto_download) {
            if (triggerDownload()) {
                appendLine('[DOWNLOADED] File download initiated')
            }
        }
        
    } catch (error) {
        appendLine(`Data export failed: ${error?.message || error}`)
        throw error
    }
}

export async function list_analyzable_layers(_ctx, payload) {
    try {
        const index = buildLayerIndex()
        const dataLayers = []
        const referenceLayers = []

        for (const item of index) {
            const cfg = item.config || item.layer?.config || item.layer || {}
            const name = item.displayName || item.name || ''
            const url = (cfg.url || cfg.source || '').toLowerCase()
            const srcType = (cfg.sourceType || '').toLowerCase()
            const layerType = (cfg.type || '').toLowerCase()

            // Skip header/group nodes
            if (layerType === 'header') continue

            // Determine if this is a data layer (analyzable) or reference layer
            const isStac = srcType === 'stac-collection' || url.startsWith('stac-collection:')
            const isCog = url.includes('.tif') || url.includes('cog:') || srcType === 'cog'
            const hasLocalData = cfg.throughTileServer === true
            const isTimeSeries = cfg.time?.enabled === true

            if (isStac || isCog || hasLocalData) {
                const details = []
                if (isStac) details.push('STAC collection')
                if (isCog) details.push('COG/GeoTIFF')
                if (isTimeSeries) details.push('time-enabled')
                if (cfg.cogUnits) details.push(`units: ${cfg.cogUnits}`)
                if (cfg.cogMin != null && cfg.cogMax != null) {
                    details.push(`range: ${cfg.cogMin}-${cfg.cogMax}`)
                }
                dataLayers.push({ name, details: details.join(', '), visible: item.visible })
            } else {
                referenceLayers.push({ name, visible: item.visible })
            }
        }

        const lines = []

        if (dataLayers.length > 0) {
            lines.push(`**Data Layers (${dataLayers.length})** — support statistics, difference, and analysis:`)
            dataLayers.forEach(l => {
                const vis = l.visible ? 'visible' : 'hidden'
                lines.push(`- **${l.name}** (${vis}) — ${l.details}`)
            })
        } else {
            lines.push('No analyzable data layers found in the current configuration.')
        }

        if (referenceLayers.length > 0) {
            lines.push('')
            lines.push(`**Reference Layers (${referenceLayers.length})** — visualization only:`)
            referenceLayers.forEach(l => {
                lines.push(`- ${l.name}`)
            })
        }

        const output = lines.join('\n')
        appendLine(output)
        return output

    } catch (error) {
        const errorMsg = `Unable to list analyzable layers: ${error?.message || error}`
        appendLine(errorMsg)
        throw error
    }
}

export async function render_open_animation_tool(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName) throw new Error('open_animation_tool requires layer_name.')

    // Enable the target layer
    const index = buildLayerIndex()
    const layerMatch = findLayerMatch(layerName, index)
    if (layerMatch) {
        try { window.mmgisAPI?.toggleLayer(layerMatch.id, true) } catch (_) {}
    }

    // Set time range via TimeControl if dates provided
    const startDate = payload?.start_date || payload?.time_start
    const endDate = payload?.end_date || payload?.time_end
    if (startDate) {
        try { TimeControl.setTime?.(startDate, endDate || startDate) } catch (_) {}
    }

    // Zoom to named region if provided
    const regionKey = (payload?.region || '').toLowerCase().trim()
    const preset = AREA_PRESETS[regionKey]
    if (preset) {
        try {
            window.mmgisAPI?.map?.fitBounds([
                [preset.bbox[1], preset.bbox[0]],
                [preset.bbox[3], preset.bbox[2]],
            ])
        } catch (_) {}
    }

    // Open Animation tool via ToolController_
    const controller = window.ToolController_
    if (controller && Array.isArray(controller.toolModuleNames)) {
        const idx = controller.toolModuleNames.indexOf('AnimationTool')
        if (idx !== -1) controller.makeTool('AnimationTool', idx)
    }

    const displayName = layerMatch?.displayName || layerName
    const format = (payload?.format || 'GIF').toUpperCase()
    const parts = [`Animation Tool opened for: ${displayName}`]
    if (preset?.label || payload?.region) parts.push(`Region: ${preset?.label || payload.region}`)
    if (startDate && endDate) parts.push(`Time range: ${startDate} → ${endDate}`)
    parts.push(`Draw a bounding box on the map in the Animation panel, then click Export ${format}.`)
    const msg = parts.join('\n')
    appendLine(msg)
    return msg
}

export async function render_run_analysis(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName) throw new Error('run_analysis requires layer_name.')

    // Enable the target layer
    const index = buildLayerIndex()
    const layerMatch = findLayerMatch(layerName, index)
    if (layerMatch) {
        try { window.mmgisAPI?.toggleLayer(layerMatch.id, true) } catch (_) {}
    }

    // Open Analysis tool via ToolController_
    const controller = window.ToolController_
    let toolOpened = false
    if (controller && Array.isArray(controller.toolModuleNames)) {
        const idx = controller.toolModuleNames.indexOf('AnalysisTool')
        if (idx !== -1) {
            controller.makeTool('AnalysisTool', idx)
            toolOpened = true
        }
    }

    if (!toolOpened) {
        const msg = 'Analysis Tool is not available. Please open it from the toolbar.'
        appendLine(msg)
        return msg
    }

    // Wait for tool DOM to initialize after make()
    await new Promise((resolve) => setTimeout(resolve, 400))

    const startDate = payload?.start_date || payload?.time_start
    const endDate = payload?.end_date || payload?.time_end
    const chartType = payload?.chart_type || 'timeseries'
    const mode = payload?.mode || 'bbox'
    const displayName = layerMatch?.displayName || layerName

    // Pre-fill time inputs
    if (startDate) $('#analysisStartTime').val(startDate)
    if (endDate) $('#analysisEndTime').val(endDate)

    // Set chart type and sampling mode
    $('#analysisChartTypeSelect').val(chartType)
    $('#analysisDataModeSelect').val(mode).trigger('change')

    // Select matching layer in dropdown (case-insensitive partial match)
    const $sel = $('#analysisLayerSelect')
    const nameLower = displayName.toLowerCase()
    $sel.find('option').each(function () {
        const optText = $(this).text().toLowerCase()
        const optVal = ($(this).val() || '').toLowerCase()
        if (optText.includes(nameLower) || nameLower.includes(optVal)) {
            $sel.val($(this).val())
            return false // break
        }
    })
    $sel.trigger('change')

    // Trigger analysis if the generate button is enabled
    const $btn = $('#analysisGenerateBtn')
    if ($btn.length && !$btn.prop('disabled')) {
        $btn.trigger('click')
        const timeLabel = startDate && endDate ? ` (${startDate} → ${endDate})` : ''
        const msg = `Running ${chartType} analysis for ${displayName}${timeLabel}. Results will appear in the Analysis panel.`
        appendLine(msg)
        return msg
    }

    // Fallback: tool is open but generate not yet available (user needs bbox or coords)
    const msg = [
        `Analysis Tool opened for: ${displayName} [${chartType}]`,
        startDate && endDate ? `Time range: ${startDate} → ${endDate}` : null,
        mode === 'bbox' ? 'Draw a bounding box on the map, then click Generate Analysis.' : 'Click a point on the map, then click Generate Analysis.',
    ].filter(Boolean).join('\n')
    appendLine(msg)
    return msg
}

const RENDERERS = {
    layers_line: render_layers_line,
    set_visible_layers_time: set_visible_layers_time,
    opacity: set_opacity,
    toggle: toggle_visibility,
    zoom_view: zoom_view,
    layer_information: render_layer_information,
    layer_mean: render_layer_mean,
    layer_difference: render_layer_difference,
    layer_summary: render_layer_summary,
    threshold_highlight: render_threshold_highlight,
    highlight_toggle: highlight_toggle,
    highlight_clear: highlight_clear,
    highlight_opacity: highlight_opacity,
    anomaly_detection: render_anomaly_detection,
    multilayer_statistics: render_multilayer_statistics,
    temporal_trends: render_temporal_trends,
    spatial_statistics: render_spatial_statistics,
    change_detection: render_change_detection,
    time_series_animation: render_time_series_animation,
    data_export: render_data_export,
    list_analyzable_layers: list_analyzable_layers,
    open_animation_tool: render_open_animation_tool,
    run_analysis: render_run_analysis,
}

export default RENDERERS
