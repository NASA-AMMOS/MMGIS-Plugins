import { fromUrl } from 'geotiff'
import {
    bboxPolygon,
    booleanPointInPolygon,
    point as turfPoint,
} from '@turf/turf'
import L_ from '@basics/Layers_/Layers_'

const DEFAULT_MAX_PIXELS = 600000
const DEFAULT_MAX_MASK_POINTS = 2000

const rasterCache = new Map()

function logLocal(message, context = null) {
    const payload = context ? `${message} (${context})` : message
    if (window?.mmgisAgentChat?.logLocalAnalytics) {
        try {
            window.mmgisAgentChat.logLocalAnalytics(payload)
            return
        } catch (_) {}
    }
    console.info('[AgentChat][LocalAnalytics]', payload)
}

function deriveEpsgCode(geoKeys) {
    if (!geoKeys || typeof geoKeys !== 'object') return null
    const numericCode =
        geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || null
    if (
        typeof numericCode === 'number' &&
        Number.isFinite(numericCode) &&
        numericCode > 0
    ) {
        return `EPSG:${numericCode}`
    }
    const citation =
        geoKeys.ProjectedCitationGeoKey || geoKeys.GeogCitationGeoKey || ''
    if (typeof citation === 'string') {
        const match = citation.match(/EPSG\s*:(\d+)/i)
        if (match && match[1]) return `EPSG:${match[1]}`
    }
    return null
}

function buildTransformers(image) {
    const geoKeys =
        (typeof image.getGeoKeys === 'function' && image.getGeoKeys()) ||
        image.geoKeys ||
        {}
    const epsgCode = deriveEpsgCode(geoKeys) || 'EPSG:4326'
    const hasProj = typeof window?.proj4 === 'function'
    const forward = (lon, lat) => {
        if (!hasProj || epsgCode === 'EPSG:4326') return [lon, lat]
        try {
            return window.proj4('EPSG:4326', epsgCode, [lon, lat])
        } catch (error) {
            console.warn('Failed to project coordinates:', error)
            return [lon, lat]
        }
    }
    const inverse = (x, y) => {
        if (!hasProj || epsgCode === 'EPSG:4326') return [x, y]
        try {
            return window.proj4(epsgCode, 'EPSG:4326', [x, y])
        } catch (error) {
            console.warn('Failed to unproject coordinates:', error)
            return [x, y]
        }
    }
    return { toImage: forward, toLatLon: inverse }
}

function normalizeGeometry(rawGeometry, bbox) {
    if (!rawGeometry) {
        const polygon = bboxPolygon(bbox)
        polygon.__derived = true
        return polygon
    }
    let geometry = rawGeometry
    if (typeof geometry === 'string') {
        try {
            geometry = JSON.parse(geometry)
        } catch (error) {
            console.warn('Failed to parse geometry payload:', error)
            geometry = null
        }
    }
    if (geometry && geometry.type === 'Feature') {
        geometry = geometry.geometry
    }
    if (!geometry || typeof geometry !== 'object') {
        const polygon = bboxPolygon(bbox)
        polygon.__derived = true
        return polygon
    }
    const accepted = new Set(['Polygon', 'MultiPolygon'])
    if (!accepted.has(geometry.type)) {
        const polygon = bboxPolygon(bbox)
        polygon.__derived = true
        return polygon
    }
    return geometry
}

function isGeometryDerived(geometry) {
    if (!geometry) return true
    if (geometry.__derived) return true
    if (geometry.type !== 'Polygon') return false
    const coords = geometry.coordinates?.[0]
    if (!Array.isArray(coords) || coords.length < 4) return false
    const unique = coords
        .slice(0, -1)
        .map((pt) => pt.map((v) => Number(v.toFixed(6))).join(','))
    return new Set(unique).size <= 4
}

function extractSourceUrl(layerMatch, timeTokens = {}) {
    const layerMeta = layerMatch?.layer || {}
    const layerConfig =
        (layerMeta.config && typeof layerMeta.config === 'object'
            ? layerMeta.config
            : layerMeta) || {}
    const candidates = [
        layerConfig.cogUrl,
        layerConfig.url,
        layerConfig.source,
        layerConfig.path,
        layerConfig.href,
        layerMeta.cogUrl,
        layerMeta.url,
        layerMeta.source,
        layerMeta.path,
        layerMeta.href,
        layerMeta.liveInstance?.options?.url,
        layerMeta.liveInstance?.options?.source,
        layerMeta.liveInstance?.cogUrl,
        layerMeta.liveInstance?.url,
    ]
    let raw = null
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            raw = candidate.trim()
            break
        }
    }
    if (!raw) return null
    // Strip sourceType prefixes (e.g. "COG:", "stac-collection:") that MMGIS
    // prepends to URLs at parse time — they are not part of the actual path.
    let resolved = raw.replace(/^[A-Za-z][\w-]*:(?!\/\/)/, '')

    Object.keys(timeTokens).forEach((token) => {
        if (!token || typeof timeTokens[token] !== 'string') return
        resolved = resolved.replace(new RegExp(token, 'g'), timeTokens[token])
    })
    if (resolved.includes('?') && resolved.includes('url=')) {
        try {
            const query = resolved.split('?')[1]
            const params = new URLSearchParams(query)
            const urlParam = params.get('url')
            if (urlParam) resolved = urlParam
        } catch (_) {}
    }
    const root = `${window.location.origin}${
        (window.mmgisglobal?.ROOT_PATH || '').replace(/\/$/, '')
    }`
    if (/^https?:\/\//i.test(resolved)) return resolved
    const missionPath = (L_.missionPath || '').replace(/^\/+/, '')
    const relative = /^\/?Missions\//i.test(resolved)
        ? resolved.replace(/^\/+/, '')
        : missionPath
        ? `${missionPath.replace(/\/$/, '')}/${resolved.replace(/^\/+/, '')}`
        : resolved.replace(/^\/+/, '')
    try {
        const base = new URL(root.endsWith('/') ? root : `${root}/`)
        return new URL(relative, base).toString()
    } catch (_) {
        return `${root}/${relative}`
    }
}

async function getGeoTiff(url) {
    if (!rasterCache.has(url)) {
        rasterCache.set(url, fromUrl(url, { cache: true }))
    }
    return rasterCache.get(url)
}

function clampBBox(bbox, datasetBBox) {
    const minX = Math.max(datasetBBox[0], Math.min(bbox[0], bbox[2]))
    const maxX = Math.min(datasetBBox[2], Math.max(bbox[0], bbox[2]))
    const minY = Math.max(datasetBBox[1], Math.min(bbox[1], bbox[3]))
    const maxY = Math.min(datasetBBox[3], Math.max(bbox[1], bbox[3]))
    if (maxX <= minX || maxY <= minY) return null
    return [minX, minY, maxX, maxY]
}

function convertBboxToImage(bbox, transformer) {
    const corners = [
        transformer.toImage(bbox[0], bbox[1]),
        transformer.toImage(bbox[0], bbox[3]),
        transformer.toImage(bbox[2], bbox[1]),
        transformer.toImage(bbox[2], bbox[3]),
    ]
    const xs = corners.map((c) => c[0])
    const ys = corners.map((c) => c[1])
    return [
        Math.min(...xs),
        Math.min(...ys),
        Math.max(...xs),
        Math.max(...ys),
    ]
}

function createWindow(imageBBox, datasetBBox, width, height) {
    const pixelWidth = (datasetBBox[2] - datasetBBox[0]) / width
    const pixelHeight = (datasetBBox[3] - datasetBBox[1]) / height
    const left = Math.max(
        0,
        Math.floor((imageBBox[0] - datasetBBox[0]) / pixelWidth)
    )
    const right = Math.min(
        width,
        Math.ceil((imageBBox[2] - datasetBBox[0]) / pixelWidth)
    )
    const top = Math.max(
        0,
        Math.floor((datasetBBox[3] - imageBBox[3]) / pixelHeight)
    )
    const bottom = Math.min(
        height,
        Math.ceil((datasetBBox[3] - imageBBox[1]) / pixelHeight)
    )
    if (right <= left || bottom <= top) return null
    return [left, top, right, bottom]
}

export async function sampleRaster(layerMatch, area, options = {}) {
    const timeTokens = {
        '{time}': options.time || layerMatch?.layer?.liveInstance?.options?.time,
        '{starttime}':
            options.startTime || layerMatch?.layer?.liveInstance?.options?.starttime,
        '{endtime}':
            options.endTime || layerMatch?.layer?.liveInstance?.options?.endtime,
    }
    const sourceUrl = extractSourceUrl(layerMatch, timeTokens)
    if (!sourceUrl) {
        throw new Error(
            `Layer "${layerMatch?.displayName || 'unknown'}" is missing a COG URL for local analytics.`
        )
    }
    const tiff = await getGeoTiff(sourceUrl)
    const image = await tiff.getImage()
    const transformer = buildTransformers(image)
    const datasetBBox = image.getBoundingBox()
    const areaImageBBox = convertBboxToImage(area.bbox, transformer)
    const clamped = clampBBox(areaImageBBox, datasetBBox)
    if (!clamped) {
        throw new Error('Selected area falls outside the raster footprint.')
    }
    const window = createWindow(
        clamped,
        datasetBBox,
        image.getWidth(),
        image.getHeight()
    )
    if (!window) {
        throw new Error('Unable to derive raster window for the selected region.')
    }
    const approxWidth = window[2] - window[0]
    const approxHeight = window[3] - window[1]
    const approxPixels = approxWidth * approxHeight
    const readOptions = { window, samples: [0] }
    const maxPixels = options.maxPixels || DEFAULT_MAX_PIXELS
    if (approxPixels > maxPixels) {
        const scale = Math.sqrt(approxPixels / maxPixels)
        readOptions.width = Math.max(1, Math.floor(approxWidth / scale))
        readOptions.height = Math.max(1, Math.floor(approxHeight / scale))
    }
    const raster = await image.readRasters(readOptions)
    const width = readOptions.width || raster.width || approxWidth
    const height = readOptions.height || raster.height || approxHeight
    const data = Array.isArray(raster) ? raster[0] : raster
    const pixelWidth = Math.abs(clamped[2] - clamped[0]) / width
    const pixelHeight = Math.abs(clamped[3] - clamped[1]) / height
    const nodataSet = new Set()
    const nodataRaw = image.getGDALNoData?.()
    if (Array.isArray(nodataRaw)) {
        nodataRaw.forEach((v) => nodataSet.add(Number(v)))
    } else if (nodataRaw != null) {
        nodataSet.add(Number(nodataRaw))
    }
    const geometry = normalizeGeometry(options.geometry, area.bbox)
    const requireMask = options.forceMask || !isGeometryDerived(geometry)
    const values = []
    let nodataCount = 0
    for (let idx = 0; idx < data.length; idx += 1) {
        const value = data[idx]
        if ((nodataSet.size && nodataSet.has(value)) || value == null) {
            nodataCount += 1
            continue
        }
        if (!Number.isFinite(value)) {
            nodataCount += 1
            continue
        }
        if (requireMask) {
            const col = idx % width
            const row = Math.floor(idx / width)
            const x = clamped[0] + (col + 0.5) * pixelWidth
            const y = clamped[3] - (row + 0.5) * pixelHeight
            const [lon, lat] = transformer.toLatLon(x, y)
            if (
                !Number.isFinite(lon) ||
                !Number.isFinite(lat) ||
                !booleanPointInPolygon(turfPoint([lon, lat]), geometry)
            ) {
                continue
            }
        }
        values.push(value)
    }
    if (!values.length) {
        throw new Error('No valid pixels found inside the requested region.')
    }
    return {
        values,
        rawData: data,
        nodataSet,
        width,
        height,
        pixelWidth,
        pixelHeight,
        bbox: clamped,
        totalCount: data.length,
        nodataCount,
        geometry,
        requireMask,
        toLatLon: transformer.toLatLon,
        url: sourceUrl,
    }
}

export function summarizeValues(values) {
    let sum = 0
    let sumSq = 0
    let min = Infinity
    let max = -Infinity
    values.forEach((value) => {
        sum += value
        sumSq += value * value
        if (value < min) min = value
        if (value > max) max = value
    })
    const count = values.length
    const mean = sum / count
    const variance = Math.max(0, sumSq / count - mean * mean)
    const std = Math.sqrt(variance)
    const sorted = values.slice().sort((a, b) => a - b)
    const percentile = (p) => {
        if (sorted.length === 1) return sorted[0]
        const idx = (sorted.length - 1) * p
        const lower = Math.floor(idx)
        const upper = Math.min(sorted.length - 1, lower + 1)
        const weight = idx - lower
        return sorted[lower] * (1 - weight) + sorted[upper] * weight
    }
    return {
        count,
        mean,
        std,
        min,
        max,
        median: percentile(0.5),
        q25: percentile(0.25),
        q75: percentile(0.75),
    }
}

function buildHistogram(values, bins, min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
        return { counts: [values.length], edges: [min, max] }
    }
    const bucketCount = Math.max(1, Math.min(512, Math.floor(bins)))
    const width = (max - min) / bucketCount
    const counts = new Array(bucketCount).fill(0)
    values.forEach((value) => {
        if (!Number.isFinite(value)) return
        let idx = Math.floor((value - min) / width)
        if (idx < 0) idx = 0
        if (idx >= bucketCount) idx = bucketCount - 1
        counts[idx] += 1
    })
    const edges = []
    for (let i = 0; i <= bucketCount; i += 1) {
        edges.push(min + i * width)
    }
    return { counts, edges }
}

function passesThreshold(value, operator, compareValue) {
    switch (operator) {
        case '>':
            return value > compareValue
        case '>=':
            return value >= compareValue
        case '<':
            return value < compareValue
        case '<=':
            return value <= compareValue
        case '==':
            return value === compareValue
        case '!=':
            return value !== compareValue
        default:
            return value > compareValue
    }
}

export async function calculateLocalBasicStats(layerMatch, area, options = {}) {
    const context = await sampleRaster(layerMatch, area, options)
    const stats = summarizeValues(context.values)
    return {
        ...stats,
        total_count: context.totalCount,
        valid_count: stats.count,
        nodata_count: context.nodataCount,
        source: 'local-cog',
        geometry: context.geometry,
        requireMask: context.requireMask,
    }
}

export async function calculateLocalHistogram(
    layerMatch,
    area,
    { bins = 60, ...options } = {}
) {
    const context = await sampleRaster(layerMatch, area, options)
    const stats = summarizeValues(context.values)
    const histogram = buildHistogram(context.values, bins, stats.min, stats.max)
    return {
        stats,
        histogram,
        total_count: context.totalCount,
        valid_count: stats.count,
        nodata_count: context.nodataCount,
        source: 'local-cog',
    }
}

export async function calculateLocalThresholdMask(
    layerMatch,
    area,
    { operator = '>', value = 0, geometry = null, maxPoints } = {}
) {
    const context = await sampleRaster(layerMatch, area, { geometry })
    const matches = []
    let matchCount = 0
    for (let idx = 0; idx < context.values.length; idx += 1) {
        const current = context.values[idx]
        if (!passesThreshold(current, operator, value)) continue
        matchCount += 1
        const limit = maxPoints || DEFAULT_MAX_MASK_POINTS
        if (matches.length >= limit) continue
        const col = idx % context.width
        const row = Math.floor(idx / context.width)
        const x = context.bbox[0] + (col + 0.5) * context.pixelWidth
        const y = context.bbox[3] - (row + 0.5) * context.pixelHeight
        const [lon, lat] = context.toLatLon(x, y)
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        matches.push({ lon, lat, value: current })
    }
    return {
        matches,
        matchCount,
        totalCount: context.values.length,
        coverage:
            context.values.length > 0
                ? matchCount / context.values.length
                : 0,
        source: 'local-cog',
    }
}

export function logLocalAnalyticsEvent(message, context) {
    logLocal(message, context)
}

