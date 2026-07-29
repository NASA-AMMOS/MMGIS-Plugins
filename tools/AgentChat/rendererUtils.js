// Shared utility functions for AgentChat renderers
// Extracted from renderers.js to support modular functionality

import L_ from '@basics/Layers_/Layers_'

// The active mission is only ever sourced from the running MMGIS instance, so
// analytics requests always carry the mission the user is actually viewing.
// (The backend has no default mission — admins add/remove missions freely.)
export function getCurrentMission() {
    const mission = L_ && typeof L_.mission === 'string' ? L_.mission.trim() : ''
    return mission || null
}

export function normalizeName(value) {
    return (value || '')
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

export function buildLayerIndex() {
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

export function findLayerMatch(value, index = null) {
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

export function scoreSimilarity(queryNorm, candidateNorm) {
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

const AREA_PRESETS = {
    'beaufort sea': {
        label: 'Beaufort Sea',
        bbox: [-160, 70, -120, 76],
    },
    'chukchi sea': {
        label: 'Chukchi Sea',
        bbox: [-180, 66, -156, 75],
    },
    'arctic ocean': {
        label: 'Arctic Ocean',
        bbox: [-180, 75, 180, 90],
    },
    'greenland sea': {
        label: 'Greenland Sea', 
        bbox: [-20, 72, 10, 82],
    },
    'laptev sea': {
        label: 'Laptev Sea',
        bbox: [105, 72, 143, 81],
    },
    'gulf of mexico': {
        label: 'Gulf of Mexico',
        bbox: [-97.5, 18.0, -80.5, 30.5],
    },
    'great lakes': {
        label: 'Great Lakes',
        bbox: [-92.5, 41.0, -75.0, 49.0],
    },
}

export function resolveArea(name) {
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

function getAnalyticsBaseUrl() {
    const override =
        window?.mmgisglobal?.ANALYTICS_BASE_URL &&
        String(window.mmgisglobal.ANALYTICS_BASE_URL).trim()
    const root = (window?.mmgisglobal?.ROOT_PATH || '').replace(/\/+$/, '')
    const base =
        override && override.length ? override : `${root}/api/agent/analytics`
    return base.replace(/\/+$/, '')
}

function buildAnalyticsUrl(path) {
    const safePath = String(path || '').replace(/^\/+/, '')
    const url = `${getAnalyticsBaseUrl()}/${safePath}`
    const mission = getCurrentMission()
    if (!mission) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}mission=${encodeURIComponent(mission)}`
}

let analyticsLayerCatalogPromise = null

async function fetchAnalyticsLayerCatalog() {
    if (analyticsLayerCatalogPromise) return analyticsLayerCatalogPromise
    const url = buildAnalyticsUrl('layers')
    analyticsLayerCatalogPromise = fetch(url, {
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
            analyticsLayerCatalogPromise = null
            throw error
        })
    return analyticsLayerCatalogPromise
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

export async function resolveAnalyticsLayerKey(layerName, layerConfig) {
    try {
        const catalog = await fetchAnalyticsLayerCatalog()
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

export async function fetchAnalyticsStatistics(layerKey, bbox, timeRange, layerName) {
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
    const statsUrl = buildAnalyticsUrl('statistics')
    const url = `${statsUrl}${statsUrl.includes('?') ? '&' : '?'}${params.toString()}`
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
        throw new Error(`Analytics statistics failed (${res.status})`)
    }
    return res.json()
}

export async function fetchAnalyticsHistogram(
    layerKey,
    bbox,
    timeRange,
    bins = 60,
    layerName
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
    const histUrl = buildAnalyticsUrl('histogram/data')
    const url = `${histUrl}${histUrl.includes('?') ? '&' : '?'}${params.toString()}`
    const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    if (!res.ok) {
        throw new Error(`Analytics histogram failed (${res.status})`)
    }
    return res.json()
}

export function sanitizeHistogramResponse(raw) {
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

export function computeHistogramQuantiles(histogram, percentiles) {
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

export function drawAreaHighlight(area, key, options = {}) {
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

export function normalizeBoundingBox(raw) {
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

export function isValidBbox(bbox) {
    return (
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((value) => Number.isFinite(value)) &&
        bbox[0] < bbox[2] &&
        bbox[1] < bbox[3]
    )
}