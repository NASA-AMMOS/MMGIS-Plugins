import $ from 'jquery'
import L_ from '@basics/Layers_/Layers_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import { transformStacUrl } from '@basics/Layers_/LayerUtils'
import {
    parseTimeQuery,
    getLayerTimeMetadata,
    computeLayerTargetTime,
    describeCadence,
    computePrecisionEndIso,
    detectSpecialTimeKeyword,
    withActiveTimelineBounds,
} from './timeUtils'
import { detectAnomalies, formatAnomalyResults } from './anomalyDetection'
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
    exportLayerData,
    formatExportResults,
    triggerDownload,
} from './dataExport'
import {
    calculateLocalBasicStats,
    calculateLocalAlignedDifference,
    calculateLocalHistogram,
    calculateLocalThresholdMask,
    logLocalAnalyticsEvent,
} from './localAnalytics'
import {
    assessLayerAnalysisCompatibility,
    formatAnalyzableLayerCatalog,
    isUserFacingLayer,
    selectFirstVisibleAnalyzableLayer,
} from './analysisCompatibility'
import {
    resolveNamedRegion,
    resolveConfiguredArea,
    createAreaUnresolvedError,
    isFullLayerExtentArea,
    resolveFullLayerExtentArea,
} from './regionNavigation'
import { resolveLayerSelection } from './layerResolver'
import {
    buildRelativeMeanThresholdAction,
    buildDifferenceRequestUrl,
    formatDifferenceStatistics,
} from './analysisWorkflows'
import {
    buildThresholdExpression,
    convertThresholdValuesToLayerUnit,
    normalizeThresholdOperator,
    resolveThresholdBand,
    resolveThresholdUnit,
} from './thresholdWorkflow'
import {
    appendQueryParameters,
    buildConfiguredAgentEndpoint,
} from './agentEndpoints'
import { resolveSpatialAnalysisType } from './spatialAnalysisPolicy'
import { describeStatisticsProvenance } from './statisticsProvenance'
import {
    assessProviderScalarSemantics,
    resolveScalarRasterTransform,
} from './scalarRasterTransform'

function analysisCompatibilityOptions() {
    const tools = window.mmgisAgentChat?.getToolRegistry?.()?.tools
    return {
        onState: L_?.layers?.on || null,
        ...(Array.isArray(tools) ? { tools } : {}),
    }
}

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
            '.agentChatTranscript',
        ]
        for (const selector of altSelectors) {
            const $alt = $(selector)
            if ($alt.length) {
                const div = $(
                    `<div style='margin:4px 0;white-space:pre-wrap'></div>`
                ).text(String(text))
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

const analyticsLayerCatalogPromises = new Map()
const CONFIGURED_AGENT_ANALYTICS = '__configured-agent-analytics__'

function buildRendererAgentEndpoint(path, params = {}) {
    return buildConfiguredAgentEndpoint({
        path,
        mission: L_?.mission || '',
        rootPath: window.mmgisglobal?.ROOT_PATH || '',
        configuredUrl: window.mmgisAgentChat?.getAgentApiUrl,
        params,
        origin: window.location?.origin || '',
    })
}

function getAnalyticsBaseUrl() {
    const override =
        (window?.mmgisglobal?.ANALYTICS_BASE_URL &&
            String(window.mmgisglobal.ANALYTICS_BASE_URL).trim()) ||
        ''
    return override.length
        ? override.replace(/\/+$/, '')
        : CONFIGURED_AGENT_ANALYTICS
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
    if (base === CONFIGURED_AGENT_ANALYTICS)
        return buildRendererAgentEndpoint(`/analytics/${safePath}`)
    return appendQueryParameters(`${base}/${safePath}`, {
        mission: L_?.mission || '',
    })
}

async function fetchAnalyticsLayerCatalog(baseOverride = null) {
    const base = resolveAnalyticsBase(baseOverride)
    if (!base) return null
    const cacheKey = L_.mission ? `${base}::${L_.mission}` : base
    if (analyticsLayerCatalogPromises.has(cacheKey)) {
        return analyticsLayerCatalogPromises.get(cacheKey)
    }
    const url = buildAnalyticsUrl('layers', base)
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
        push(layerConfig.analyticsLayerKey)
        push(layerConfig.analyticsKey)
        push(layerConfig.dataset)
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
        const targetNorms = gatherAnalyticsAliases(layerName, null, layerConfig)
            .map(normalizeName)
            .filter(Boolean)
        if (!targetNorms.length) return null
        let best = null
        let bestScore = 0
        entries.forEach(({ key, info }) => {
            const candidates = gatherAnalyticsAliases(key, info, null)
            candidates.forEach((candidate) => {
                const candidateNorm = normalizeName(candidate)
                if (!candidateNorm) return
                targetNorms.forEach((targetNorm) => {
                    const score = scoreSimilarity(targetNorm, candidateNorm)
                    if (score > bestScore) {
                        bestScore = score
                        best = { key, info }
                    }
                })
            })
        })
        const MIN_SCORE = 0.55
        if (!best || bestScore < MIN_SCORE) return null
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
        if (!resolvedKey) return null
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
    const url = buildAnalyticsUrl('statistics', baseOverride)
    if (!url) {
        throw new Error('Analytics endpoint is not configured for this layer.')
    }
    const fullUrl = appendQueryParameters(url, params)
    const res = await fetch(fullUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
        throw new Error(`Analytics statistics failed (${res.status})`)
    }
    return res.json()
}

function differenceProviderSemantics(data, side) {
    const suffix = side === 'layer_a' ? 'a' : 'b'
    return (
        data?.[`${side}_semantics`] ||
        data?.semantics?.[side] ||
        data?.semantics?.[suffix] ||
        data?.provenance?.[side] || {
            value_expression:
                data?.[`value_expression_${suffix}`] ||
                data?.[`expression_${suffix}`],
            valid_range: data?.[`valid_range_${suffix}`],
            nodata_value: data?.[`nodata_value_${suffix}`],
            nodata_values: data?.[`nodata_values_${suffix}`],
            unit: data?.[`unit_${suffix}`] || data?.[`units_${suffix}`],
        }
    )
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
    const url = buildAnalyticsUrl('histogram/data', baseOverride)
    if (!url) {
        throw new Error('Analytics histogram endpoint is unavailable.')
    }
    const fullUrl = appendQueryParameters(url, params)
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
    const layerOn = L_?.layers?.on || {}
    const liveLayers = api.getLayers?.() || {}
    const items = []
    const seen = new Set()

    Object.keys(configs).forEach((key) => {
        const layerConfig = configs[key] || {}
        if (String(layerConfig.type || '').toLowerCase() === 'header') return
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
                layerOn[uuid] ||
                (layerConfig.name && layerOn[layerConfig.name]) ||
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

function waitForMapState(map, predicate, timeoutMs = 1500) {
    if (predicate()) return Promise.resolve(true)
    return new Promise((resolve) => {
        let finished = false
        let timer = null
        const finish = (matched) => {
            if (finished) return
            finished = true
            if (timer) clearTimeout(timer)
            map.off?.('moveend', check)
            map.off?.('zoomend', check)
            resolve(matched)
        }
        const check = () => {
            if (predicate()) finish(true)
        }
        timer = setTimeout(() => finish(predicate()), timeoutMs)
        map.on?.('moveend', check)
        map.on?.('zoomend', check)
        // Leaflet may complete a non-animated setView before listeners attach.
        check()
    })
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

function resolveArea(name) {
    return resolveConfiguredArea(name, {
        map: window.mmgisAPI?.map,
        runtimePresets: window.mmgisAgentAreaPresets,
    })
}

function resolveLayerContext(payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('A layer_name is required for this request.')
    }
    const layerMatch = findLayerMatch(layerName)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(
            `Unable to locate configuration for layer "${layerName}".`
        )
    }
    const resolvedLayerName =
        layerMatch.displayName || layerMatch.layer?.displayName || layerName
    const areaName =
        payload?.geographical_area ||
        payload?.area ||
        payload?.region ||
        'current view'
    const area = isFullLayerExtentArea(areaName)
        ? resolveFullLayerExtentArea(layerMatch)
        : resolveArea(areaName)
    if (!area) {
        throw createAreaUnresolvedError(areaName)
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
        try {
            host = ` (${new URL(cfg.url || cfg.source).hostname})`
        } catch (_e) {
            /* ignore */
        }
        const name =
            context.resolvedLayerName || payload?.layer_name || 'This layer'
        throw new Error(
            `${name} is served from an external tile service${host}` +
                ` and does not have a local raster file. ` +
                `Raster statistics require a locally hosted COG or GeoTIFF layer.`
        )
    }
    const timeTokens = getLayerTimeTokens(context.layerMatch, payload)
    const stats = await calculateLocalBasicStats(
        context.layerMatch,
        context.area,
        {
            geometry: payload?.geometry,
            time: timeTokens.time,
            startTime: timeTokens.startTime,
            endTime: timeTokens.endTime,
        }
    )
    return { ...context, stats, timeTokens }
}

async function fetchLayerMetadata(layerName) {
    const url = buildRendererAgentEndpoint('/layer-info', {
        name: layerName,
    })
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

function sanitizeLayerSummaryText(value, maxLength = 800) {
    if (typeof value !== 'string') return ''
    return value
        .replace(/<[^>]*>/g, ' ')
        .replace(/\bhttps?:\/\/\S+/gi, ' ')
        .replace(
            /\b(?:access[_ -]?token|api[_ -]?key|secret|password)\s*[:=]\s*\S+/gi,
            ' '
        )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength)
}

function buildLiveLayerInformation(layerName) {
    let match = null
    try {
        match = findLayerMatch(layerName)
    } catch (error) {
        console.warn(
            '[AgentChat] Live layer metadata could not be inspected.',
            error
        )
    }
    if (!match?.layer || match.score < 0.8) {
        const message =
            `No loaded layer uniquely matches "${layerName}". Choose a layer from “List layers” and try again.`
        return {
            ok: false,
            message,
            data: { requestedLayer: layerName },
            errorCode: 'LAYER_NOT_FOUND',
        }
    }

    const layer = match.layer
    const config = layer.config || {}
    const summaryCandidates = [
        config.description,
        config.summary,
        config.longDescription,
        config.metadata?.description,
        config.metadata?.summary,
    ]
    const summary = summaryCandidates
        .map((value) => sanitizeLayerSummaryText(value))
        .find(Boolean)
    const type = String(config.type || 'layer')
    const visibility = layer.visible ? 'visible' : 'hidden'
    const timeEnabled = config.time?.enabled === true
    const state = `${type} layer; currently ${visibility}${
        timeEnabled ? '; time-enabled' : ''
    }`
    if (!summary) {
        const message =
            `${layer.displayName} is a loaded ${state}, but this mission does not expose a descriptive summary for it. Its current type and visibility are available; additional scientific context must come from mission metadata or documentation.`
        return {
            ok: false,
            message,
            data: {
                layer: layer.displayName,
                type,
                visible: layer.visible,
                timeEnabled,
                source: 'live-mission-config',
            },
            errorCode: 'LAYER_INFORMATION_UNAVAILABLE',
        }
    }
    const message = `${layer.displayName}: ${summary} (${state}).`
    return {
        ok: true,
        message,
        data: {
            layer: layer.displayName,
            type,
            visible: layer.visible,
            timeEnabled,
            source: 'live-mission-config',
        },
    }
}

function isUserSelectableLayer(item) {
    return isUserFacingLayer(item)
}

// Pure builder — derives the listing entirely from the live layer index
// (i.e. the current mission's actual configuration), never a hardcoded
// name list. Kept separate from the renderer so the structured result and
// visible transcript always describe the same live mission state.
export function buildLayersLineText() {
    const items = buildLayerIndex().filter(isUserSelectableLayer)
    if (!items.length) {
        throw new Error('No layers available to list.')
    }
    const lines = items.map((item, index) => {
        const timeEnabled = item.config?.time?.enabled === true
        const invariant = timeEnabled ? '' : ', time-invariant'
        return `${index + 1}. ${item.displayName} — ${
            item.visible ? 'visible' : 'hidden'
        }${invariant}.`
    })
    return `Layers:\n${lines.join('\n')}`
}

export async function render_layers_line() {
    const text = buildLayersLineText()
    appendLine(text)
    return { ok: true, message: text, data: { kind: 'layer-list' } }
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
    const parsedTime = special
        ? { special, original: rawQuery }
        : parseTimeQuery(rawQuery)
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
        targets = index.filter(
            (layer) => layer.visible && layer.config?.time?.enabled === true
        )
    }
    targets = uniqueLayerTargets(targets)
    if (!targets.length) {
        return {
            ok: false,
            lines: [
                'No time-capable layers found. The visible layers do not support time control.',
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
        const timeUi = TimeControl?.timeUI
        const meta = withActiveTimelineBounds(
            getLayerTimeMetadata(target.config),
            {
                startTimestamp: timeUi?._timelineStartTimestamp,
                endTimestamp: timeUi?._timelineEndTimestamp,
            }
        )
        if (!meta.enabled) {
            skipped.push({
                name: target.displayName,
                reason: 'layer is not time-enabled',
            })
            continue
        }
        const resolution = computeLayerTargetTime(meta, parsedTime)
        if (!resolution.ok || !resolution.iso) {
            const specificReason =
                resolution.reason === 'no_max_bound'
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
            const rangeEndIso =
                !parsedTime.special && parsedTime.date
                    ? computePrecisionEndIso(parsedTime.date, queryPrecision) ||
                      resolution.iso
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

            const applied = await api.setLayerTime(
                target.id,
                rangeStartIso,
                rangeEndIso
            )
            if (applied === false) {
                throw new Error('setLayerTime rejected the request.')
            }
            const reloaded = await api.reloadLayer(target.id)
            if (reloaded === false) {
                throw new Error('the layer could not be reloaded')
            }
            updates.push({
                name: target.displayName,
                iso: resolution.iso,
                cadence: describeCadence(resolution.cadence),
                rangeStart: resolution.availableStart,
                rangeEnd: resolution.availableEnd,
                outOfRange: resolution.outOfRange,
                notes: resolution.notes || [],
                timelineBoundsUsed: meta.timelineBoundsUsed === true,
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
            if (entry.timelineBoundsUsed)
                extras.push('used the active MMGIS timeline bounds')
            const suffix = extras.length ? ` (${extras.join('; ')})` : ''
            lines.push(
                `• ${entry.name}: Displaying data for ${entry.iso}${suffix}`
            )
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
    const message = result.lines.join('\n')
    if (message) appendLine(message)
    return {
        ok: result.ok,
        message,
        data: null,
        ...(result.ok ? {} : { errorCode: 'TIME_UPDATE_FAILED' }),
    }
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
    const api = window.mmgisAPI
    if (typeof payload?.region === 'string' && payload.region.trim()) {
        const region = await resolveNamedRegion(payload.region, {
            apiUrl: buildRendererAgentEndpoint('/regions/resolve'),
        })
        if (!region) {
            const message = `I couldn't resolve the named region "${payload.region}".`
            appendLine(message)
            return {
                ok: false,
                message,
                data: null,
                errorCode: 'REGION_NOT_FOUND',
            }
        }
        const explicitZoom = Number(payload.zoom)
        const zoom = Number.isFinite(explicitZoom) ? explicitZoom : region.zoom
        let usedFacade = false
        if (region.center && Number.isFinite(zoom) && api?.setMapView) {
            await api.setMapView(region.center[1], region.center[0], zoom)
            usedFacade = true
            await waitForMapState(map, () => map.getZoom?.() === zoom)
        } else if (region.bbox && api?.fitMapBounds) {
            await api.fitMapBounds(region.bbox)
            usedFacade = true
            if (Number.isFinite(explicitZoom) && api?.setMapView) {
                const center = map.getCenter()
                await api.setMapView(center.lat, center.lng, explicitZoom)
                await waitForMapState(
                    map,
                    () => map.getZoom?.() === explicitZoom
                )
            } else if (Number.isFinite(explicitZoom)) {
                map.setZoom(explicitZoom)
                await waitForMapState(
                    map,
                    () => map.getZoom?.() === explicitZoom
                )
            } else {
                await waitForMapState(map, () => !map._animatingZoom)
            }
        } else if (region.center && Number.isFinite(zoom)) {
            map.setView([region.center[1], region.center[0]], zoom)
            await waitForMapState(map, () => map.getZoom?.() === zoom)
        } else if (region.bbox) {
            const bounds = window.L.latLngBounds(
                window.L.latLng(region.bbox[1], region.bbox[0]),
                window.L.latLng(region.bbox[3], region.bbox[2])
            )
            map.fitBounds(bounds, { padding: [16, 16] })
            if (Number.isFinite(explicitZoom)) {
                map.setZoom(explicitZoom)
                await waitForMapState(
                    map,
                    () => map.getZoom?.() === explicitZoom
                )
            } else {
                await waitForMapState(map, () => !map._animatingZoom)
            }
        }
        let actualZoom = map.getZoom?.() ?? zoom
        const zoomMatches = () =>
            Number.isFinite(Number(actualZoom)) &&
            Math.abs(Number(actualZoom) - explicitZoom) < 1e-6
        if (Number.isFinite(explicitZoom) && !zoomMatches()) {
            // A layer/plugin moveend hook may finish a pending fitBounds just
            // after setMapView. Re-apply the requested final view once through
            // the same MMGIS facade and verify the settled map state.
            const targetCenter = region.center
                ? { lat: region.center[1], lng: region.center[0] }
                : region.bbox
                  ? {
                        lat: (region.bbox[1] + region.bbox[3]) / 2,
                        lng: (region.bbox[0] + region.bbox[2]) / 2,
                    }
                  : map.getCenter?.()
            if (targetCenter && api?.setMapView) {
                await api.setMapView(
                    targetCenter.lat,
                    targetCenter.lng,
                    explicitZoom
                )
                await waitForMapState(
                    map,
                    () =>
                        Math.abs(Number(map.getZoom?.()) - explicitZoom) < 1e-6,
                    2500
                )
                actualZoom = map.getZoom?.() ?? actualZoom
            }
        }
        if (Number.isFinite(explicitZoom) && !zoomMatches()) {
            const message = `The ${region.name} was located, but MMGIS could not verify zoom level ${explicitZoom}.`
            appendLine(message)
            return {
                ok: false,
                message,
                data: { ...region, requestedZoom: explicitZoom, actualZoom },
                errorCode: 'MAP_VIEW_NOT_VERIFIED',
            }
        }
        const message = `Zoomed to the ${region.name}${
            Number.isFinite(actualZoom) ? ` at zoom level ${actualZoom}` : ''
        }.`
        appendLine(message)
        return {
            ok: true,
            message,
            data: { ...region, zoom: actualZoom, usedFacade },
        }
    }
    if (Array.isArray(payload?.center) && typeof payload?.zoom === 'number') {
        const [lon, lat] = payload.center
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
            throw new Error('Center coordinates must be finite numbers.')
        }
        if (api?.setMapView) await api.setMapView(lat, lon, payload.zoom)
        else map.setView([lat, lon], payload.zoom)
        await waitForMapState(map, () => map.getZoom?.() === payload.zoom)
        const actualZoom = map.getZoom?.()
        if (actualZoom !== payload.zoom) {
            const message = `MMGIS could not verify zoom level ${payload.zoom} at the requested center.`
            appendLine(message)
            return {
                ok: false,
                message,
                data: {
                    center: [lon, lat],
                    requestedZoom: payload.zoom,
                    actualZoom,
                },
                errorCode: 'MAP_VIEW_NOT_VERIFIED',
            }
        }
        const message = `Zoomed to center (${lon}, ${lat}) at zoom level ${payload.zoom}.`
        appendLine(message)
        return {
            ok: true,
            message,
            data: {
                center: [lon, lat],
                zoom: payload.zoom,
                usedFacade: !!api?.setMapView,
            },
        }
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
        if (api?.fitMapBounds) await api.fitMapBounds(payload.bbox)
        else map.fitBounds(bounds, { padding: [16, 16] })
        await waitForMapState(map, () => !map._animatingZoom)
        const message = 'Zoomed to the requested bounding box.'
        appendLine(message)
        return {
            ok: true,
            message,
            data: { bbox: payload.bbox, usedFacade: !!api?.fitMapBounds },
        }
    }
    throw new Error(
        'Zoom request missing region, center/zoom, or bbox parameters.'
    )
}

export async function render_layer_information(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('layer_information requires a layer_name string.')
    }
    let info
    try {
        info = await fetchLayerMetadata(layerName)
    } catch (error) {
        console.warn(
            '[AgentChat] Structured layer metadata endpoint is unavailable.',
            error
        )
        info = { items: [], match: null, unavailable: true }
    }
    if (info.unavailable || !info.items.length) {
        const localResult = buildLiveLayerInformation(layerName)
        appendLine(localResult.message)
        return localResult
    }
    const item = info.items[0]
    const headline = item.name || layerName
    const summary =
        item.summary && item.summary.trim().length
            ? item.summary.trim()
            : 'No description available.'
    const message = `${headline}: ${summary}${
        item.citation ? `\nSource: ${item.citation}` : ''
    }`
    appendLine(message)
    return {
        ok: true,
        message,
        data: {
            layer: headline,
            source: 'agent-layer-metadata',
            citation: item.citation || null,
        },
    }
}

export async function render_layer_mean(_ctx, payload) {
    const { layerMatch, resolvedLayerName, area } = resolveLayerContext(payload)
    const compatibility = assessLayerAnalysisCompatibility(
        layerMatch.layer,
        analysisCompatibilityOptions()
    )
    if (!compatibility.supported) {
        const message =
            `**${resolvedLayerName}** cannot provide scalar statistics. ${compatibility.reason} ` +
            'Choose a layer listed by “Which layers can I analyze?” instead.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: { layer: resolvedLayerName, compatibility },
            errorCode: 'UNSUPPORTED_ANALYSIS',
        }
    }
    // A full-raster request has no reliable WGS84 footprint until the source
    // is opened. Do not fit a custom/polar map to the synthetic world envelope
    // used as a resolution sentinel; that can trigger a large invalid tile
    // fan-out while analytics is running.
    if (!area.fullLayerExtent) {
        drawAreaHighlight(area, 'mean', {
            color: '#0ea5e9',
            fillOpacity: 0.18,
        })
    }
    const timeTokens = getLayerTimeTokens(layerMatch, payload)
    let analyticsBase = determineAnalyticsEndpoint(layerMatch, null)
    let analyticsLayer = null
    let analyticsCatalogMiss = false
    if (analyticsBase) {
        try {
            analyticsLayer = await resolveAnalyticsLayerKey(
                resolvedLayerName,
                layerMatch?.layer?.config,
                analyticsBase
            )
            if (!analyticsLayer?.key) {
                analyticsCatalogMiss = true
                analyticsBase = null
            } else {
                analyticsBase = determineAnalyticsEndpoint(
                    layerMatch,
                    analyticsLayer
                )
            }
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
            timeTokens.endTime || analyticsLayer?.info?.time_range?.end || null,
    }
    const matchConfidence =
        typeof analyticsLayer?.confidence === 'number'
            ? analyticsLayer.confidence
            : (layerMatch?.score ?? null)
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
            const semantics = assessProviderScalarSemantics(
                layerMatch?.layer?.config || layerMatch?.layer || {},
                stats
            )
            if (!semantics.ok) {
                const error = new Error(semantics.message)
                error.code = semantics.errorCode
                remoteError = error
                stats = null
            }
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
            console.error(
                `[AgentChat] Local statistics failed for ${resolvedLayerName}.`,
                localError
            )
            const crsMessages = {
                LOCAL_ANALYTICS_CRS_MISSING:
                    'its GeoTIFF does not declare a coordinate reference system',
                LOCAL_ANALYTICS_CRS_UNSUPPORTED:
                    'its GeoTIFF uses an unknown or unsupported coordinate reference system',
                LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED:
                    'its coordinates could not be transformed safely into the raster reference system',
                LOCAL_ANALYTICS_BAND_UNAVAILABLE:
                    'the requested raster band is not present in the selected GeoTIFF',
                LOCAL_ANALYTICS_TRANSFORM_UNSUPPORTED:
                    'its configured scalar display expression cannot be evaluated safely by local analytics',
            }
            const crsReason = crsMessages[localError?.code]
            const message = crsReason
                ? `Statistics could not be calculated for **${resolvedLayerName}** because ${crsReason}. Add valid CRS metadata, configure the required projection, or use a compatible analytics service.`
                : `Statistics could not be calculated for **${resolvedLayerName}** because its scalar data source could not be reached or read. ` +
                  'Try again, choose another analyzable layer, or verify that the data service is available.'
            appendLine(message)
            return {
                ok: false,
                message,
                data: {
                    layer: resolvedLayerName,
                    area,
                    analyticsCatalogMiss,
                },
                errorCode:
                    (crsReason && localError.code) ||
                    'STATISTICS_SOURCE_UNAVAILABLE',
            }
        }
    }
    if (remoteError) {
        console.warn(
            'Analytics endpoint failed; used local statistics.',
            remoteError
        )
    }

    if (!stats || !Number.isFinite(Number(stats.mean))) {
        console.error(
            `[AgentChat] Statistics provider returned an invalid result for ${resolvedLayerName}.`,
            stats
        )
        const message =
            `Statistics could not be calculated for **${resolvedLayerName}** because the data provider returned no valid numerical mean. ` +
            'Try again or choose another analyzable layer.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: { layer: resolvedLayerName, area },
            errorCode: 'STATISTICS_RESULT_INVALID',
        }
    }
    stats.mean = Number(stats.mean)

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
    } else if (analyticsCatalogMiss) {
        lines.push(
            'The named layer was not present in the analytics catalog; statistics were computed from its active scalar source instead.'
        )
    }
    if (stats?.source === 'local-cog') {
        lines.push(
            'Analytics service unavailable; statistics computed locally from the active raster.'
        )
    }
    lines.push(
        area.fullLayerExtent
            ? 'Confirmed area: full layer extent.'
            : `Confirmed area: ${area.label} (bbox ${area.bbox
                  .map((v) => v.toFixed(4))
                  .join(', ')})`
    )
    const statisticsUnit =
        typeof stats.unit === 'string' && stats.unit.trim()
            ? ` ${stats.unit.trim()}`
            : ''
    lines.push(
        `Mean: ${stats.mean.toFixed(4)}${statisticsUnit} (std ${
            typeof stats.std === 'number' ? stats.std.toFixed(4) : 'n/a'
        }${statisticsUnit})`
    )
    if (quantiles?.quantiles) {
        const { quantiles: q } = quantiles
        if (typeof q[0.25] === 'number') {
            lines.push(
                `25th percentile: ${q[0.25].toFixed(4)}${statisticsUnit}`
            )
        }
        if (typeof q[0.5] === 'number') {
            lines.push(`Median: ${q[0.5].toFixed(4)}${statisticsUnit}`)
        } else if (typeof stats.median === 'number') {
            lines.push(`Median: ${stats.median.toFixed(4)}${statisticsUnit}`)
        }
        if (typeof q[0.75] === 'number') {
            lines.push(
                `75th percentile: ${q[0.75].toFixed(4)}${statisticsUnit}`
            )
        }
    } else if (typeof stats.median === 'number') {
        lines.push(`Median: ${stats.median.toFixed(4)}${statisticsUnit}`)
    }
    if (typeof stats.min === 'number') {
        lines.push(`Min: ${stats.min.toFixed(4)}${statisticsUnit}`)
    }
    if (typeof stats.max === 'number') {
        lines.push(`Max: ${stats.max.toFixed(4)}${statisticsUnit}`)
    }
    if (typeof stats.valid_count === 'number') {
        const formatted =
            typeof stats.valid_count.toLocaleString === 'function'
                ? stats.valid_count.toLocaleString()
                : String(stats.valid_count)
        lines.push(`Valid samples: ${formatted}`)
    }
    if (stats.value_expression) {
        lines.push(
            `Applied configured scalar expression: ${stats.value_expression}`
        )
    }
    // Explanation of how the statistics were computed
    lines.push('')
    lines.push('**How these statistics were computed:**')
    lines.push(...describeStatisticsProvenance(stats))

    const message = lines.join('\n')
    appendLine(message)
    return {
        ok: true,
        message,
        data: {
            layer: resolvedLayerName,
            area,
            stats,
            quantiles: quantiles?.quantiles || null,
            source:
                stats?.source || (analyticsBase ? 'analytics-service' : null),
        },
    }
}

export function findFirstVisibleAnalyzableLayer(index = null) {
    return selectFirstVisibleAnalyzableLayer(
        index || buildLayerIndex(),
        analysisCompatibilityOptions()
    )
}

export async function render_statistics_first_visible(ctx, payload = {}) {
    const selected = findFirstVisibleAnalyzableLayer()
    if (!selected) {
        const message =
            'No analyzable scalar data layer is currently visible. Turn on a layer listed by “Which layers can I analyze?” and try again.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'NO_VISIBLE_ANALYZABLE_LAYER',
        }
    }
    const result = await render_layer_mean(ctx, {
        ...payload,
        layer_name: selected.layerName,
        geographical_area:
            payload.geographical_area || payload.area || 'current view',
    })
    return {
        ...result,
        message: result.ok
            ? `Statistics for the first visible analyzable layer, **${selected.layerName}**:\n${result.message}`
            : result.message,
        data: {
            ...(result.data || {}),
            selectedLayer: selected.layerName,
        },
    }
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
                typeof stats.median === 'number'
                    ? stats.median.toFixed(4)
                    : 'n/a'
            }`,
        ]
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(`Unable to compute local mean: ${error?.message || error}`)
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
            `Valid samples: ${stats.count.toLocaleString?.() || String(stats.count)}`,
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
            `Valid samples: ${stats.count.toLocaleString?.() || String(stats.count)}`,
        ]
        appendLine(lines.join('\n'))
    } catch (error) {
        appendLine(
            `Unable to compute local standard deviation: ${error?.message || error}`
        )
        throw error
    }
}

export async function render_local_calculate_histogram(_ctx, payload) {
    try {
        const { layerMatch, resolvedLayerName, area } =
            resolveLayerContext(payload)
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
        const { layerMatch, resolvedLayerName, area } =
            resolveLayerContext(payload)
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
            `Matches: ${result.matchCount.toLocaleString()} of ${result.totalCount.toLocaleString()} valid sampled cells (${coveragePct}% of the sampled valid cells).`,
        ]
        if (result.isSampled) {
            lines.push(
                `The bounded sample contains ${result.sampleCount.toLocaleString()} grid cells representing an estimated ${result.populationCount.toLocaleString()} source cells; this mask is approximate.`
            )
        }
        if (result.matchCount > points.length) {
            lines.push(
                `Displayed ${points.length.toLocaleString()} representative points on the map (sampled from ${result.matchCount.toLocaleString()} matches).`
            )
        } else {
            lines.push(
                'All matching cells from the bounded sample are visualized on the map.'
            )
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
        const message = `Layer "${layerName}" does not expose a resolvable COG source for threshold highlighting.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_SOURCE_UNAVAILABLE',
        }
    }

    // Resolve {time} placeholder using the current TimeControl time
    if (resolvedSourceUrl.includes('{time}')) {
        const timeFmt = layerConfig.time?.format || '%Y-%m-%dT%H:%M:%SZ'
        const currentIso = TimeControl.endTime || TimeControl.currentTime || ''
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
    const compatibilityA = assessLayerAnalysisCompatibility(
        matchA.layer,
        analysisCompatibilityOptions()
    )
    const compatibilityB = assessLayerAnalysisCompatibility(
        matchB.layer,
        analysisCompatibilityOptions()
    )
    if (!compatibilityA.supported || !compatibilityB.supported) {
        const unsupported = !compatibilityA.supported
            ? `${matchA.displayName}: ${compatibilityA.reason}`
            : `${matchB.displayName}: ${compatibilityB.reason}`
        const message = `Cannot calculate a numeric layer difference. ${unsupported}`
        appendLine(message)
        return {
            ok: false,
            message,
            data: { compatibilityA, compatibilityB },
            errorCode: 'UNSUPPORTED_ANALYSIS',
        }
    }
    // Get current map time
    let currentTimeStr = ''
    try {
        const tc = TimeControl
        const t =
            tc?.getTime?.() || tc?.currentTime || tc?.getCurrent?.() || null
        if (t) {
            currentTimeStr =
                typeof t === 'string' ? t : new Date(t).toISOString()
        }
        // Also try layer live instance time
        if (!currentTimeStr) {
            const optsA = matchA?.layer?.liveInstance?.options || {}
            const optsB = matchB?.layer?.liveInstance?.options || {}
            currentTimeStr =
                optsA.endtime ||
                optsA.starttime ||
                optsB.endtime ||
                optsB.starttime ||
                ''
        }
    } catch (_) {}

    const timeLabel = currentTimeStr
        ? currentTimeStr.split('T')[0]
        : 'latest available'
    const comparisonArea = resolveArea(
        payload?.geographical_area || payload?.area || 'current view'
    )
    if (!comparisonArea) {
        const message = 'Unable to resolve the requested comparison area.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'AREA_NOT_FOUND',
        }
    }
    appendLine(
        `Computing pixel-by-pixel difference for **${timeLabel}**: **${matchA.displayName}** minus **${matchB.displayName}**...`
    )

    // Use the backend analytics/difference endpoint which works with actual tiff files
    try {
        const origin = window.location.origin
        const url = buildDifferenceRequestUrl({
            baseUrl: buildRendererAgentEndpoint('/analytics/difference'),
            origin,
            layerA: matchA.displayName || matchA.layer?.name || layerA,
            layerB: matchB.displayName || matchB.layer?.name || layerB,
            time: currentTimeStr,
            mission: L_.mission || '',
            bbox: comparisonArea.bbox,
        })

        const res = await fetch(url)
        const data = await res.json()

        if (!res.ok || data.error) {
            throw new Error(data.error || `Server returned ${res.status}`)
        }

        const semanticsA = assessProviderScalarSemantics(
            matchA.layer?.config || matchA.layer || {},
            differenceProviderSemantics(data, 'layer_a')
        )
        const semanticsB = assessProviderScalarSemantics(
            matchB.layer?.config || matchB.layer || {},
            differenceProviderSemantics(data, 'layer_b')
        )
        if (!semanticsA.ok || !semanticsB.ok) {
            const semantics = !semanticsA.ok ? semanticsA : semanticsB
            const error = new Error(semantics.message)
            error.code = semantics.errorCode
            throw error
        }

        // Only use a unit when the analytics service declares it. A value in
        // [0, 1] is not, by itself, proof that the layer represents percent.
        const declaredUnit =
            typeof data.unit === 'string'
                ? data.unit
                : typeof data.units === 'string'
                  ? data.units
                  : ''
        const message = formatDifferenceStatistics(data, {
            layerA: matchA.displayName,
            layerB: matchB.displayName,
            unit: declaredUnit,
        })
        appendLine(message)
        return {
            ok: true,
            message,
            data: {
                layerA: matchA.displayName,
                layerB: matchB.displayName,
                time: currentTimeStr || null,
                area: comparisonArea,
                statistics: data,
                source: 'analytics-service',
            },
        }
    } catch (error) {
        console.warn('[AgentChat] Backend layer difference failed.', error)
        try {
            const statistics = await calculateLocalAlignedDifference(
                matchA,
                matchB,
                comparisonArea,
                { time: currentTimeStr || undefined }
            )
            const formatted = formatDifferenceStatistics(statistics, {
                layerA: matchA.displayName,
                layerB: matchB.displayName,
                unit: statistics.unit || '',
            })
            const provenance = describeStatisticsProvenance(statistics)
            const message = [
                formatted,
                '',
                'The local comparison proceeded only after matching CRS, bounds, affine grids, resampling dimensions, and shared valid-cell masks were confirmed.',
                ...provenance,
            ].join('\n')
            appendLine(message)
            return {
                ok: true,
                message,
                data: {
                    layerA: matchA.displayName,
                    layerB: matchB.displayName,
                    time: currentTimeStr || null,
                    area: comparisonArea,
                    statistics,
                    source: statistics.source,
                },
            }
        } catch (localError) {
            console.warn(
                '[AgentChat] Proven aligned local difference is unavailable.',
                localError
            )
            const message =
                `A scientifically aligned difference between **${matchA.displayName}** and ` +
                `**${matchB.displayName}** is unavailable from the current analytics provider. ` +
                'Copilot did not subtract the rasters locally because their CRS, affine grid, masks, units, and NoData semantics could not all be proven compatible.'
            appendLine(message)
            return {
                ok: false,
                message,
                data: {
                    layerA: matchA.displayName,
                    layerB: matchB.displayName,
                    area: comparisonArea,
                },
                errorCode:
                    localError?.code ||
                    'DIFFERENCE_ALIGNMENT_PROVIDER_REQUIRED',
            }
        }
    }
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
function getHighlightStore() {
    const store = (window.__mmgisAgentChatOverlays =
        window.__mmgisAgentChatOverlays || {})
    return store
}

function resolveThresholdScope(payload = {}) {
    const explicitBbox = payload.bbox || payload.geographical_area?.bbox
    if (isValidBbox(explicitBbox)) {
        return {
            ok: true,
            kind: 'explicit-bounds',
            label: 'the requested bounds',
            bbox: explicitBbox.map(Number),
        }
    }
    const requested = payload.geographical_area ?? payload.area
    if (requested == null || String(requested).trim() === '') {
        return {
            ok: true,
            kind: 'full-raster',
            label: 'the full raster source',
            bbox: null,
        }
    }
    const normalized = normalizeName(requested)
    if (
        ['full layer extent', 'full raster', 'entire layer', 'global'].includes(
            normalized
        )
    ) {
        return {
            ok: true,
            kind: 'full-raster',
            label: 'the full raster source',
            bbox: null,
        }
    }
    if (
        [
            'current view',
            'current map view',
            'visible map',
            'map view',
        ].includes(normalized)
    ) {
        const area = resolveArea('current view')
        if (area && isValidBbox(area.bbox)) {
            return {
                ok: true,
                kind: 'current-view',
                label: 'the current map view',
                bbox: area.bbox.map(Number),
            }
        }
    }
    const configuredArea = resolveArea(requested)
    if (configuredArea && isValidBbox(configuredArea.bbox)) {
        return {
            ok: true,
            kind: 'named-area',
            label: configuredArea.label || String(requested),
            bbox: configuredArea.bbox.map(Number),
        }
    }
    return {
        ok: false,
        errorCode: 'HIGHLIGHT_AREA_UNRESOLVED',
        message: `The requested highlight area "${requested}" could not be resolved to map bounds. Use the current view, a configured named area, explicit bounds, or the full layer extent.`,
    }
}

function waitForFirstTileOutcome(layer, timeoutMs = 10000) {
    if (!layer || typeof layer.on !== 'function') {
        return Promise.resolve({
            ok: false,
            errorCode: 'HIGHLIGHT_RENDERER_UNAVAILABLE',
            message:
                'The highlight tile layer cannot report whether it loaded.',
        })
    }
    return new Promise((resolve) => {
        let timer = null
        let settled = false
        const finish = (result) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            layer.off?.('tileload', onLoad)
            layer.off?.('load', onLoad)
            layer.off?.('tileerror', onError)
            resolve(result)
        }
        const onLoad = () => finish({ ok: true })
        const onError = () =>
            finish({
                ok: false,
                errorCode: 'HIGHLIGHT_TILE_LOAD_FAILED',
                message:
                    'The threshold overlay could not load raster tiles from the configured source.',
            })
        layer.on('tileload', onLoad)
        layer.on('load', onLoad)
        layer.on('tileerror', onError)
        timer = setTimeout(
            () =>
                finish({
                    ok: false,
                    errorCode: 'HIGHLIGHT_TILE_LOAD_TIMEOUT',
                    message:
                        'The threshold overlay did not load a raster tile before the request timed out.',
                }),
            timeoutMs
        )
    })
}

export async function render_threshold_highlight(ctx, payload) {
    const requestedLayer = (
        payload?.layer_name ||
        payload?.name ||
        payload?.variable ||
        ''
    ).toString()
    const variable = (payload?.variable || requestedLayer).toString()
    const operator = normalizeThresholdOperator(payload?.operator || '>')
    if (!operator) {
        const message = `Unsupported threshold operator "${payload?.operator}". Use >, >=, <, <=, =, ==, or between.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'UNSUPPORTED_THRESHOLD_OPERATOR',
        }
    }
    const index = buildLayerIndex()
    // Resolve visible layers first, but never silently choose among multiple
    // equally plausible layer names.
    let resolution = resolveLayerSelection({
        requestedName: requestedLayer,
        userQuery:
            ctx?.originalMessage || payload?.original_query || requestedLayer,
        layers: index.filter((layer) => layer.visible),
    })
    if (!resolution?.match && !resolution?.ambiguous) {
        resolution = resolveLayerSelection({
            requestedName: requestedLayer,
            userQuery:
                ctx?.originalMessage ||
                payload?.original_query ||
                requestedLayer,
            layers: index,
        })
    }
    if (resolution?.ambiguous) {
        const options = (resolution.candidates || [])
            .map((candidate) =>
                candidate.groupPath
                    ? `${candidate.groupPath} > ${candidate.displayName}`
                    : candidate.displayName
            )
            .filter(Boolean)
        const message = `More than one layer matches "${requestedLayer}". Choose one: ${options.join(
            ' | '
        )}.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: { candidates: options },
            errorCode: 'AMBIGUOUS_LAYER',
        }
    }
    const target = resolution?.match?.layer
    if (!target) {
        const message = `I couldn't find a ${requestedLayer} layer to highlight.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'LAYER_NOT_FOUND',
        }
    }
    const layerName = target.displayName || target.name
    const compatibility = assessLayerAnalysisCompatibility(
        target,
        analysisCompatibilityOptions()
    )
    if (!compatibility.supported) {
        const message = `Cannot highlight values for **${layerName}**: ${compatibility.reason}`
        appendLine(message)
        return {
            ok: false,
            message,
            data: { layer: layerName, compatibility },
            errorCode: 'UNSUPPORTED_ANALYSIS',
        }
    }

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
        layerConfig.demtileurl ||
        layerConfig.demUrl ||
        layerConfig.demurl ||
        layerConfig.dem ||
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
        const message = `Layer "${layerName}" does not expose a resolvable COG source for threshold highlighting.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_SOURCE_UNAVAILABLE',
        }
    }

    const bandResolution = resolveThresholdBand(
        layerConfig,
        variable,
        layerName,
        payload?.band
    )
    if (!bandResolution.ok) {
        appendLine(bandResolution.message)
        return {
            ok: false,
            message: bandResolution.message,
            data: null,
            errorCode: bandResolution.errorCode,
        }
    }
    const declaredUnit = resolveThresholdUnit(
        layerConfig,
        variable,
        bandResolution.band
    )
    const convertedThreshold = convertThresholdValuesToLayerUnit({
        operator,
        value: payload?.value,
        valueMin: payload?.value_min,
        valueMax: payload?.value_max,
        inputUnit: payload?.unit,
        declaredUnit,
    })
    if (!convertedThreshold.ok) {
        appendLine(convertedThreshold.message)
        return {
            ok: false,
            message: convertedThreshold.message,
            data: { layer: layerName, declaredUnit },
            errorCode: convertedThreshold.errorCode,
        }
    }
    const scalarTransform = resolveScalarRasterTransform(
        layerConfig,
        Number(bandResolution.band.replace(/^b/i, ''))
    )
    if (!scalarTransform.ok) {
        appendLine(scalarTransform.message)
        return {
            ok: false,
            message: scalarTransform.message,
            data: { layer: layerName, band: bandResolution.band },
            errorCode: scalarTransform.errorCode,
        }
    }
    const threshold = buildThresholdExpression({
        operator,
        value: convertedThreshold.value,
        valueMin: convertedThreshold.valueMin,
        valueMax: convertedThreshold.valueMax,
        band: bandResolution.band,
        valueExpression: scalarTransform.expression,
    })
    if (!threshold.ok) {
        appendLine(threshold.message)
        return {
            ok: false,
            message: threshold.message,
            data: null,
            errorCode: threshold.errorCode,
        }
    }
    const scope = resolveThresholdScope(payload)
    if (!scope.ok) {
        appendLine(scope.message)
        return {
            ok: false,
            message: scope.message,
            data: null,
            errorCode: scope.errorCode,
        }
    }

    // Resolve {time} placeholder using the current TimeControl time
    if (resolvedSourceUrl.includes('{time}')) {
        const timeFmt = layerConfig.time?.format || '%Y-%m-%dT%H:%M:%SZ'
        const currentIso = TimeControl.endTime || TimeControl.currentTime || ''
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

    if (/\{(?:time|starttime|endtime)\}/i.test(resolvedSourceUrl)) {
        const message = `Layer "${layerName}" requires a current time before its COG source can be resolved.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_TIME_UNRESOLVED',
        }
    }

    const isStacCollection =
        resolvedSourceUrl.toLowerCase().startsWith('stac-collection:') ||
        (layerConfig.sourceType || '').toLowerCase() === 'stac-collection'
    const stacCollectionSource = isStacCollection
        ? resolvedSourceUrl.toLowerCase().startsWith('stac-collection:')
            ? resolvedSourceUrl
            : `stac-collection:${resolvedSourceUrl}`
        : null

    // Resolve relative path using L_.getUrl() so TiTiler can find the file
    // (adds mission path prefix and ../../ for non-Docker environments)
    if (
        !isStacCollection &&
        !resolvedSourceUrl.startsWith('/Missions') &&
        !/^(?:https?:)?\/\//i.test(resolvedSourceUrl)
    ) {
        if (typeof L_?.getUrl !== 'function') {
            const message = `Layer "${layerName}" has a relative source that MMGIS could not resolve.`
            appendLine(message)
            return {
                ok: false,
                message,
                data: null,
                errorCode: 'HIGHLIGHT_SOURCE_UNAVAILABLE',
            }
        }
        resolvedSourceUrl = L_.getUrl('tile', resolvedSourceUrl, layerConfig)
    }
    if (typeof resolvedSourceUrl !== 'string' || !resolvedSourceUrl.trim()) {
        const message = `Layer "${layerName}" source resolution returned no usable COG URL.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_SOURCE_UNAVAILABLE',
        }
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
        window.mmgisglobal?.ROOT_PATH || ''
    ).replace(/\/+$/, '')}`

    // Multiply boolean by 1 to produce numeric 0/1 (TiTiler can't render bool).
    // rescale=0,1 maps 0→0 and 1→255 in pixel space.
    // Colormap keys must match the RESCALED pixel values (0 and 255).
    const params = new URLSearchParams()
    params.set('url', resolvedSourceUrl)
    params.set('expression', threshold.expression)
    params.set('resampling', 'nearest')
    params.set('rescale', '0,1')
    params.set(
        'colormap',
        JSON.stringify({ 0: [0, 0, 0, 0], 255: [255, 255, 0, 255] })
    )

    if (typeof window.L?.tileLayer !== 'function') {
        const message = 'MMGIS raster tile rendering is unavailable.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_RENDERER_UNAVAILABLE',
        }
    }
    let leafletBounds = null
    if (scope.bbox) {
        leafletBounds = window.L.latLngBounds(
            window.L.latLng(scope.bbox[1], scope.bbox[0]),
            window.L.latLng(scope.bbox[3], scope.bbox[2])
        )
        if (scope.kind === 'named-area' || scope.kind === 'explicit-bounds') {
            try {
                if (window.mmgisAPI?.fitMapBounds) {
                    await window.mmgisAPI.fitMapBounds(scope.bbox, {
                        padding: [16, 16],
                    })
                } else if (typeof map.fitBounds === 'function') {
                    map.fitBounds(leafletBounds, { padding: [16, 16] })
                }
            } catch (error) {
                console.error('Threshold highlight area fit failed', error)
                const message = `The requested highlight area (${scope.label}) could not be displayed on the map.`
                appendLine(message)
                return {
                    ok: false,
                    message,
                    data: { bbox: scope.bbox },
                    errorCode: 'HIGHLIGHT_AREA_DISPLAY_FAILED',
                }
            }
        }
    }
    let highlightTileUrl
    if (isStacCollection) {
        // Follow the same pgSTAC collection route as MMGIS' normal layer
        // renderer. Deployments may intentionally run TiTiler-pgSTAC without
        // the separate /titiler/cog service, so resolving a collection to a
        // COG and then switching services makes an otherwise valid layer fail.
        const transformed = transformStacUrl(
            stacCollectionSource,
            {
                ...layerConfig,
                cogBands: null,
                cogExpression: threshold.expression,
            },
            'tiles',
            window.location
        )
        if (
            !transformed ||
            transformed.toLowerCase().startsWith('stac-collection:')
        ) {
            const message = `The STAC collection for "${layerName}" could not be converted to MMGIS' raster tile endpoint.`
            appendLine(message)
            return {
                ok: false,
                message,
                data: null,
                errorCode: 'HIGHLIGHT_SOURCE_UNAVAILABLE',
            }
        }
        const queryIndex = transformed.indexOf('?')
        let tilePath =
            queryIndex >= 0 ? transformed.slice(0, queryIndex) : transformed
        const stacParams = new URLSearchParams(
            queryIndex >= 0 ? transformed.slice(queryIndex + 1) : ''
        )
        if (!/\.(?:png|webp|jpg|jpeg)$/i.test(tilePath)) tilePath += '.png'
        stacParams.set('assets', 'asset')
        stacParams.set('exitwhenfull', 'false')
        stacParams.set('skipcovered', 'false')
        stacParams.set('expression', threshold.expression)
        stacParams.set('resampling', 'nearest')
        stacParams.set('rescale', '0,1')
        stacParams.set(
            'colormap',
            JSON.stringify({
                0: [0, 0, 0, 0],
                255: [255, 255, 0, 255],
            })
        )
        const liveOptions = target.liveInstance?.options || {}
        const endTime =
            liveOptions.endtime ||
            TimeControl.endTime ||
            TimeControl.currentTime ||
            null
        const startTime = liveOptions.starttime || null
        if (endTime) {
            stacParams.set(
                'datetime',
                startTime ? `${startTime}/${endTime}` : String(endTime)
            )
        }
        highlightTileUrl = `${tilePath}?${stacParams.toString()}`
    } else {
        highlightTileUrl = `${baseRoot}/titiler/cog/tiles/${tileMatrixStr}/{z}/{x}/{y}.png?${params.toString()}`
    }
    store.highlightTile = window.L.tileLayer(highlightTileUrl, {
        opacity: 0.6,
        interactive: false,
        pane: 'overlayPane',
        zIndex: 650,
        ...(leafletBounds ? { bounds: leafletBounds } : {}),
        tms: tileMatrixStr.toLowerCase().includes('tms')
            ? true
            : layerConfig.tileformat === 'tms' ||
              layerConfig.tms === true ||
              false,
    })
    const tileOutcomePromise = waitForFirstTileOutcome(store.highlightTile)
    try {
        store.highlightTile.addTo(map)
    } catch (error) {
        console.error('Threshold highlight tile attachment failed', error)
        store.highlightTile.fire?.('tileerror')
        const message = 'The threshold overlay could not be added to the map.'
        appendLine(message)
        store.highlightTile = null
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_RENDER_FAILED',
        }
    }
    const tileOutcome = await tileOutcomePromise
    if (!tileOutcome.ok) {
        try {
            store.highlightTile.remove()
        } catch (_) {}
        store.highlightTile = null
        const fallbackBbox = scope.bbox || target.bbox
        if (isValidBbox(fallbackBbox)) {
            try {
                const timeTokens = getLayerTimeTokens(
                    { layer: target },
                    payload
                )
                const local = await calculateLocalThresholdMask(
                    { layer: target, displayName: layerName },
                    {
                        label: scope.label,
                        bbox: fallbackBbox.map(Number),
                    },
                    {
                        operator,
                        value: threshold.value,
                        valueMin: threshold.lower,
                        valueMax: threshold.upper,
                        band: Number(bandResolution.band.replace(/^b/i, '')),
                        geometry: payload?.geometry,
                        time: timeTokens.time,
                        startTime: timeTokens.startTime,
                        endTime: timeTokens.endTime,
                    }
                )
                drawLocalThresholdOverlay(local.matches)
                const sampleDescription = local.isSampled
                    ? `${local.sampleCount.toLocaleString()} sampled raster cells representing an estimated ${local.populationCount.toLocaleString()} source cells`
                    : `${local.sampleCount.toLocaleString()} raster cells in the bounded window`
                const message = local.matchCount
                    ? `The raster tile overlay service was unavailable, so Copilot displayed ${local.matches.length.toLocaleString()} representative map points from ${local.matchCount.toLocaleString()} matching valid cells. The threshold was evaluated locally over ${sampleDescription}; this point overlay is ${
                          local.isSampled ? 'approximate' : 'bounded'
                      }.`
                    : `No valid cells in ${scope.label} satisfied the threshold. Copilot verified this locally over ${sampleDescription}; no highlight points were added.`
                appendLine(message)
                return {
                    ok: true,
                    message,
                    data: {
                        layer: layerName,
                        variable,
                        band: bandResolution.band,
                        operator,
                        threshold:
                            operator === 'between'
                                ? {
                                      min: threshold.lower,
                                      max: threshold.upper,
                                  }
                                : threshold.value,
                        unit: declaredUnit,
                        valueExpression: scalarTransform.expression,
                        scope: 'bounded-local-sample',
                        bbox: fallbackBbox.map(Number),
                        renderer: 'local-sampled-points',
                        matchCount: local.matchCount,
                        displayedCount: local.matches.length,
                        sampleCount: local.sampleCount,
                        populationCount: local.populationCount,
                        approximate: local.isSampled,
                    },
                }
            } catch (localError) {
                console.warn(
                    '[AgentChat] Local threshold fallback failed.',
                    localError
                )
            }
        }
        appendLine(tileOutcome.message)
        return {
            ok: false,
            message: tileOutcome.message,
            data: { layer: layerName, bbox: scope.bbox },
            errorCode: tileOutcome.errorCode,
        }
    }

    const condition =
        operator === 'between'
            ? `between ${payload?.value_min} and ${payload?.value_max}`
            : `${operator} ${payload?.value}`
    const displayUnit = payload?.unit || declaredUnit
    const requestedUnit = displayUnit ? ` ${displayUnit}` : ''
    const convertedCondition =
        operator === 'between'
            ? `${threshold.lower} to ${threshold.upper}`
            : `${threshold.value}`
    const conversionNote = convertedThreshold.converted
        ? ` (${convertedCondition} ${declaredUnit} in raster units)`
        : ''
    const scopeNote = scope.bbox
        ? ` The overlay is limited to raster tiles intersecting ${scope.label}; edge tiles may extend slightly beyond the exact boundary.`
        : ' The tile expression evaluates the full raster source.'
    const message = `Highlighted ${variable} ${condition}${requestedUnit}${conversionNote} on ${layerName} using ${bandResolution.band}.${scopeNote}`
    appendLine(message)
    return {
        ok: true,
        message,
        data: {
            layer: layerName,
            variable,
            band: bandResolution.band,
            operator,
            threshold:
                operator === 'between'
                    ? { min: threshold.lower, max: threshold.upper }
                    : threshold.value,
            unit: declaredUnit,
            valueExpression: scalarTransform.expression,
            scope: scope.bbox ? 'tile-bounds' : 'full-raster',
            bbox: scope.bbox,
            requestedArea: payload?.geographical_area || payload?.area || null,
        },
    }
}

export async function render_highlight_relative_to_mean(ctx, payload = {}) {
    const index = buildLayerIndex()
    let selected = null
    const requested = payload.layer_name || payload.name
    if (requested) {
        const match = findLayerMatch(requested, index)
        if (match?.layer) {
            const compatibility = assessLayerAnalysisCompatibility(
                match.layer,
                analysisCompatibilityOptions()
            )
            selected = compatibility.supported
                ? { ...compatibility, layer: match.layer }
                : null
            if (!selected) {
                const message = `Cannot analyze **${
                    match.displayName || requested
                }**: ${compatibility.reason}`
                appendLine(message)
                return {
                    ok: false,
                    message,
                    data: { compatibility },
                    errorCode: 'UNSUPPORTED_ANALYSIS',
                }
            }
        }
    } else {
        selected = selectFirstVisibleAnalyzableLayer(
            index,
            analysisCompatibilityOptions()
        )
    }
    if (!selected) {
        const message = requested
            ? `Could not find an analyzable layer matching "${requested}".`
            : 'No analyzable scalar data layer is currently visible.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: requested
                ? 'LAYER_NOT_FOUND'
                : 'NO_VISIBLE_ANALYZABLE_LAYER',
        }
    }
    const layerName =
        selected.layerName ||
        selected.layer?.displayName ||
        selected.layer?.name ||
        requested
    const statsResult = await render_layer_mean(ctx, {
        ...payload,
        layer_name: layerName,
        geographical_area:
            payload.geographical_area || payload.area || 'current view',
    })
    if (!statsResult.ok) return statsResult
    const mean = Number(statsResult.data?.stats?.mean)
    if (!Number.isFinite(mean)) {
        const message = `Statistics for **${layerName}** did not contain a numeric mean.`
        appendLine(message)
        return {
            ok: false,
            message,
            data: statsResult.data,
            errorCode: 'MEAN_UNAVAILABLE',
        }
    }
    const thresholdAction = buildRelativeMeanThresholdAction(
        layerName,
        mean,
        payload.direction || payload.relative || 'above',
        payload
    )
    const operator = thresholdAction.operator
    const highlightResult = await render_threshold_highlight(
        ctx,
        thresholdAction
    )
    if (!highlightResult.ok) return highlightResult
    const message = `Highlighted values ${
        operator === '>' ? 'above' : 'below'
    } the mean (${mean.toFixed(4)}) for **${layerName}**.`
    appendLine(message)
    return {
        ok: true,
        message,
        data: {
            layer: layerName,
            mean,
            direction: operator === '>' ? 'above' : 'below',
            statistics: statsResult.data,
            highlight: highlightResult.data,
        },
    }
}

export async function highlight_toggle() {
    const store = getHighlightStore()
    const tile = store.highlightTile
    const local = store['local-threshold']
    if (!tile && !local) {
        const message = 'No highlight overlay is available to hide or show.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_NOT_FOUND',
        }
    }
    const current = tile
        ? (tile.options.opacity ?? 0.2)
        : (store.localHighlightOpacity ?? 0.65)
    const isHidden = current <= 0.001
    const next = isHidden
        ? tile
            ? (store.highlightOpacity ?? 0.2)
            : (store.localHighlightPreviousOpacity ?? 0.65)
        : 0
    if (tile) tile.setOpacity(next)
    else {
        local.eachLayer?.((layer) =>
            layer.setStyle?.({ fillOpacity: next, opacity: next })
        )
        store.localHighlightOpacity = next
    }
    const message = isHidden
        ? `Highlight overlay is visible at opacity ${next.toFixed(2)}.`
        : 'Highlight overlay is now hidden.'
    appendLine(message)
    return {
        ok: true,
        message,
        data: { visible: isHidden, opacity: next },
    }
}

export async function highlight_clear() {
    const store = getHighlightStore()
    const tile = store.highlightTile
    const local = store['local-threshold']
    if (
        (tile && typeof tile.remove === 'function') ||
        (local && typeof local.remove === 'function')
    ) {
        try {
            tile?.remove?.()
            local?.remove?.()
            store.highlightTile = null
            store['local-threshold'] = null
            const message = 'Cleared the highlight overlay.'
            appendLine(message)
            return { ok: true, message, data: { cleared: true } }
        } catch (error) {
            console.error('Unable to clear highlight overlay', error)
            const message = 'The highlight overlay could not be cleared.'
            appendLine(message)
            return {
                ok: false,
                message,
                data: null,
                errorCode: 'HIGHLIGHT_CLEAR_FAILED',
            }
        }
    } else {
        const message = 'No highlight overlay is available to clear.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_NOT_FOUND',
        }
    }
}

export async function highlight_opacity(_ctx, payload) {
    const delta = Number(payload?.delta)
    const store = getHighlightStore()
    const tile = store.highlightTile
    const local = store['local-threshold']
    if (!tile && !local) {
        const message = 'No highlight overlay is available to adjust.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'HIGHLIGHT_NOT_FOUND',
        }
    }
    const cur = Number(
        tile
            ? (tile.options.opacity ?? 0.2)
            : (store.localHighlightOpacity ?? 0.65)
    )
    const next = Math.max(
        0.05,
        Math.min(0.4, cur + (Number.isFinite(delta) ? delta : 0))
    )
    store.highlightOpacity = next
    if (tile) tile.setOpacity(next)
    else {
        local.eachLayer?.((layer) =>
            layer.setStyle?.({ fillOpacity: next, opacity: next })
        )
        store.localHighlightPreviousOpacity = next
        store.localHighlightOpacity = next
    }
    const message = `Highlight opacity set to ${next.toFixed(2)}.`
    appendLine(message)
    return { ok: true, message, data: { opacity: next } }
}

export async function render_anomaly_detection(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.name
    if (!layerName || typeof layerName !== 'string') {
        throw new Error('anomaly_detection requires a layer_name string.')
    }
    const match = findLayerMatch(layerName, buildLayerIndex())
    if (!match?.layer) {
        const message = `Unable to find layer "${layerName}" for anomaly detection.`
        appendLine(message)
        return { ok: false, message, data: null, errorCode: 'LAYER_NOT_FOUND' }
    }
    const compatibility = assessLayerAnalysisCompatibility(
        match.layer,
        analysisCompatibilityOptions()
    )
    if (!compatibility.supported) {
        const message = `Cannot detect anomalies for **${
            match.displayName || layerName
        }**: ${compatibility.reason}`
        appendLine(message)
        return {
            ok: false,
            message,
            data: { compatibility },
            errorCode: 'UNSUPPORTED_ANALYSIS',
        }
    }
    if (String(payload?.method || '').toLowerCase() === 'spatial') {
        const message =
            'Spatial anomaly clustering is not available because no registered analytics source returns cell-level anomaly values. Use z-score, IQR, or auto analysis instead.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'UNSUPPORTED_SPATIAL_ANOMALY',
        }
    }
    try {
        const results = await detectAnomalies(match.displayName || layerName, {
            area: payload?.geographical_area || payload?.area || 'current view',
            timeRange:
                payload?.time_start || payload?.time_end
                    ? {
                          start: payload.time_start || null,
                          end: payload.time_end || null,
                      }
                    : null,
            method: payload?.method || 'auto',
            threshold: Number(payload?.threshold) || 2.5,
            includeVisualization: payload?.visualize !== false,
        })
        const message = formatAnomalyResults(results)
        appendLine(message)
        return { ok: true, message, data: results }
    } catch (error) {
        const message = `Unable to detect anomalies for **${
            match.displayName || layerName
        }**: ${error?.message || error}`
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: error?.code || 'ANOMALY_ANALYSIS_FAILED',
        }
    }
}

export async function render_multilayer_statistics(_ctx, payload) {
    const layerNames = payload?.layer_names || payload?.layers
    if (!Array.isArray(layerNames) || layerNames.length < 2) {
        throw new Error(
            'multi_layer_statistics requires at least 2 layer names.'
        )
    }

    const area = payload?.area || payload?.geographical_area || 'current view'
    const timeRange = payload?.time_range
    const includeCorrelation = payload?.include_correlation === true

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
        return { ok: true, message: formattedOutput, data: results }
    } catch (error) {
        console.error('[AgentChat] Multi-layer statistics failed.', error)
        const message =
            error?.code === 'AREA_UNRESOLVED'
                ? error.message
                : 'Multi-layer statistics could not be completed for the selected layers and area.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: error?.code || 'MULTILAYER_STATISTICS_FAILED',
        }
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
        return { ok: true, message: formattedOutput, data: results }
    } catch (error) {
        console.error('[AgentChat] Temporal trend analysis failed.', error)
        const message =
            error?.code === 'AREA_UNRESOLVED'
                ? error.message
                : 'Temporal trend analysis could not be completed for the selected layer, area, and time range.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: error?.code || 'TEMPORAL_TREND_FAILED',
        }
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
    const resolvedAnalysisType = resolveSpatialAnalysisType(analysisType)
    if (!resolvedAnalysisType.ok) {
        appendLine(resolvedAnalysisType.message)
        return {
            ok: false,
            message: resolvedAnalysisType.message,
            data: null,
            errorCode: resolvedAnalysisType.errorCode,
        }
    }

    const layerMatch = findLayerMatch(layerName)

    try {
        const results = await calculateSpatialStatistics(layerName, {
            area,
            gridSize,
            analysisType: resolvedAnalysisType.analysisType,
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
                    dashArray: '4 6',
                })
            }
        }

        return {
            ok: true,
            message: formattedOutput,
            data: results,
        }
    } catch (error) {
        console.error('[AgentChat] Spatial statistics failed.', error)
        const message =
            error?.code === 'UNSUPPORTED_SPATIAL_ANALYSIS_TYPE' ||
            error?.code === 'AREA_UNRESOLVED'
                ? error.message
                : 'Spatial statistics could not be completed for the selected layer and area.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: error?.code || 'SPATIAL_ANALYSIS_FAILED',
        }
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
                const changeColor =
                    results.changes.meanChange > 0 ? '#22c55e' : '#ef4444'
                drawAreaHighlight(resolvedArea, 'change-detection', {
                    color: changeColor,
                    fillOpacity: 0.2,
                })
            }
        }
        return { ok: true, message: formattedOutput, data: results }
    } catch (error) {
        console.error('[AgentChat] Change detection failed.', error)
        const message =
            error?.code === 'AREA_UNRESOLVED' ||
            error?.code === 'RASTER_ALIGNMENT_REQUIRED'
                ? error.message
                : 'Change detection could not be completed for the selected layer, times, and area.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: error?.code || 'CHANGE_DETECTION_FAILED',
        }
    }
}

export async function render_time_series_animation(_ctx, payload) {
    return render_open_animation_tool(_ctx, {
        layer_name: payload?.layer_name || payload?.layer,
        start_date: payload?.time_start || payload?.start_time,
        end_date: payload?.time_end || payload?.end_time,
        region: payload?.area || payload?.geographical_area,
        format: 'gif',
    })
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
            resolution: payload?.resolution || 'medium',
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

// Pure builder — classifies analyzability from the live layer config
// (STAC collection / COG / local-tile-server data vs. plain reference
// imagery), never a hardcoded layer list. Kept separate from the renderer so
// capability summaries can be generated without optional plug-in knowledge.
export function buildAnalyzableLayersText() {
    return formatAnalyzableLayerCatalog(
        buildLayerIndex(),
        analysisCompatibilityOptions()
    )
}

export async function list_analyzable_layers(_ctx, payload) {
    try {
        const output = buildAnalyzableLayersText()
        appendLine(output)
        return {
            ok: true,
            message: output,
            data: { kind: 'analysis-capability-list' },
        }
    } catch (error) {
        const errorMsg = `Unable to list analyzable layers: ${error?.message || error}`
        appendLine(errorMsg)
        throw error
    }
}

export async function render_open_animation_tool(_ctx, payload) {
    const layerName = payload?.layer_name || payload?.layer
    if (!layerName) {
        const message = 'Choose a layer before opening the Animation tool.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'ANIMATION_LAYER_REQUIRED',
        }
    }

    if (typeof window.mmgisAPI?.openTool !== 'function') {
        const message =
            'The Animation tool is not available in the current mission.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'ANIMATION_TOOL_UNAVAILABLE',
        }
    }
    let toolResult = null
    try {
        toolResult = await window.mmgisAPI.openTool('Animation')
    } catch (error) {
        console.error('[AgentChat] Animation tool could not be opened.', error)
    }
    if (toolResult?.open !== true) {
        const message =
            'The Animation tool is not available in the current mission.'
        appendLine(message)
        return {
            ok: false,
            message,
            data: null,
            errorCode: 'ANIMATION_TOOL_UNAVAILABLE',
        }
    }

    const layerMatch = findLayerMatch(layerName, buildLayerIndex())
    const displayName = layerMatch?.displayName || layerName
    const format = (payload?.format || 'GIF').toUpperCase()
    const parts = [
        'Opened the Animation tool.',
        `Select ${displayName} in the panel, choose the time range, draw export bounds, and then click Export ${format}.`,
        'Copilot did not claim that those manual Animation inputs were applied.',
    ]
    const msg = parts.join('\n')
    appendLine(msg)
    return {
        ok: true,
        message: msg,
        data: {
            layer: displayName,
            requestedRegion: payload?.region || null,
            requestedStartDate:
                payload?.start_date || payload?.time_start || null,
            requestedEndDate: payload?.end_date || payload?.time_end || null,
            format,
            tool: toolResult,
            configured: false,
            requiresManualInput: true,
        },
    }
}

const RENDERERS = {
    layers_line: render_layers_line,
    set_visible_layers_time: set_visible_layers_time,
    opacity: set_opacity,
    toggle: toggle_visibility,
    zoom_view: zoom_view,
    layer_information: render_layer_information,
    layer_mean: render_layer_mean,
    statistics_first_visible: render_statistics_first_visible,
    first_visible_statistics: render_statistics_first_visible,
    layer_difference: render_layer_difference,
    layer_summary: render_layer_summary,
    threshold_highlight: render_threshold_highlight,
    highlight_relative_to_mean: render_highlight_relative_to_mean,
    above_average_highlight: render_highlight_relative_to_mean,
    highlight_toggle: highlight_toggle,
    highlight_clear: highlight_clear,
    highlight_opacity: highlight_opacity,
    anomaly_detection: render_anomaly_detection,
    multilayer_statistics: render_multilayer_statistics,
    temporal_trends: render_temporal_trends,
    spatial_statistics: render_spatial_statistics,
    change_detection: render_change_detection,
    data_export: render_data_export,
    list_analyzable_layers: list_analyzable_layers,
}

export default RENDERERS
