import { suggestionConfig } from './suggestions'

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\b(the|region|area)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

function finiteArray(value, length) {
    return (
        Array.isArray(value) &&
        value.length === length &&
        value.every((item) => Number.isFinite(Number(item)))
    )
}

export function findConfiguredRegion(regionName, config = suggestionConfig) {
    const requested = normalize(regionName)
    if (!requested) return null
    const regions = Array.isArray(config?.zoom?.regions)
        ? config.zoom.regions
        : []
    const exact = regions.find(
        (region) => normalize(region?.name) === requested
    )
    const partial = regions.find((region) => {
        const candidate = normalize(region?.name)
        return candidate.includes(requested) || requested.includes(candidate)
    })
    const match = exact || partial
    if (!match) return null
    return {
        name: match.name,
        center: finiteArray(match.center, 2) ? match.center.map(Number) : null,
        bbox: finiteArray(match.bbox, 4) ? match.bbox.map(Number) : null,
        zoom: Number.isFinite(Number(match.defaultZoom))
            ? Number(match.defaultZoom)
            : null,
        source: 'copilot-config',
    }
}

const CURRENT_VIEW_ALIASES = new Set([
    '',
    'current view',
    'current map view',
    'map view',
    'viewport',
    'visible extent',
    'current extent',
])

const FULL_LAYER_EXTENT_ALIASES = new Set([
    'full layer extent',
    'full extent',
    'entire layer',
    'entire layer extent',
    'full raster',
    'whole raster',
    'global',
])

function normalizedBbox(value) {
    if (finiteArray(value, 4)) {
        const bbox = value.map(Number)
        if (bbox[0] < bbox[2] && bbox[1] < bbox[3]) return bbox
    }
    if (value && typeof value === 'object') {
        const bbox = [value.west, value.south, value.east, value.north]
        if (finiteArray(bbox, 4)) {
            const normalized = bbox.map(Number)
            if (normalized[0] < normalized[2] && normalized[1] < normalized[3])
                return normalized
        }
    }
    return null
}

export function isFullLayerExtentArea(areaName) {
    const requested = normalize(areaName).replace(/^for\s+/, '')
    return FULL_LAYER_EXTENT_ALIASES.has(requested)
}

export function resolveFullLayerExtentArea(layerMatch) {
    const layer = layerMatch?.layer || layerMatch || {}
    const config = layer?.config || {}
    const candidates = [
        layerMatch?.bbox,
        layer?.bbox,
        layer?.bounds,
        layer?.extent,
        config?.bbox,
        config?.bounds,
        config?.extent,
    ]
    const declared = candidates.map(normalizedBbox).find(Boolean)
    return {
        label: 'full layer extent',
        // A global geographic envelope is safely projected, clamped to the
        // raster footprint, and bounded by the local sampler when no explicit
        // WGS84 layer extent is declared.
        bbox: declared || [-180, -90, 180, 90],
        source: declared ? 'layer-config-extent' : 'global-raster-envelope',
        fullLayerExtent: true,
    }
}

export function resolveConfiguredArea(
    areaName,
    { map = null, runtimePresets = null } = {}
) {
    const requested = normalize(areaName)
    if (CURRENT_VIEW_ALIASES.has(requested)) {
        if (!map?.getBounds) return null
        const bounds = map.getBounds()
        return {
            label: 'current map view',
            bbox: [
                bounds.getWest(),
                bounds.getSouth(),
                bounds.getEast(),
                bounds.getNorth(),
            ],
            source: 'current-map-view',
        }
    }
    const configured = findConfiguredRegion(areaName)
    if (configured?.bbox) {
        return {
            label: configured.name,
            bbox: configured.bbox.slice(),
            source: configured.source,
        }
    }
    if (runtimePresets && typeof runtimePresets === 'object') {
        const entry = Object.entries(runtimePresets).find(
            ([name]) => normalize(name) === requested
        )?.[1]
        if (finiteArray(entry?.bbox, 4)) {
            return {
                label: entry.label || areaName,
                bbox: entry.bbox.map(Number),
                source: 'runtime-preset',
            }
        }
    }
    return null
}

export function createAreaUnresolvedError(areaName) {
    const error = new Error(
        `The named area "${String(areaName || '')}" could not be resolved. Specify a configured region, bounding box, or "current view".`
    )
    error.code = 'AREA_UNRESOLVED'
    return error
}

export async function resolveNamedRegion(
    regionName,
    {
        fetchImpl = typeof window !== 'undefined' &&
        typeof window.fetch === 'function'
            ? window.fetch.bind(window)
            : null,
        apiUrl = '',
    } = {}
) {
    const configured = findConfiguredRegion(regionName)
    if (configured) return configured
    if (typeof fetchImpl !== 'function' || !apiUrl) return null
    const separator = apiUrl.includes('?') ? '&' : '?'
    const response = await fetchImpl(
        `${apiUrl}${separator}name=${encodeURIComponent(regionName)}`,
        { headers: { Accept: 'application/json' } }
    )
    if (!response.ok) return null
    const payload = await response.json()
    const value = payload?.region || payload?.result || payload
    const bbox = finiteArray(value?.bbox, 4) ? value.bbox.map(Number) : null
    const center = finiteArray(value?.center, 2)
        ? value.center.map(Number)
        : null
    if (!bbox && !center) return null
    return {
        name: value?.name || value?.label || regionName,
        bbox,
        center,
        zoom: Number.isFinite(Number(value?.zoom)) ? Number(value.zoom) : null,
        source: 'region-resolver',
    }
}
