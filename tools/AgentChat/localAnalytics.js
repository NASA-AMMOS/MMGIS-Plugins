import { fromUrl } from 'geotiff'
import {
    bboxPolygon,
    booleanPointInPolygon,
    point as turfPoint,
} from '@turf/turf'
import L_ from '@basics/Layers_/Layers_'
import { collectThresholdMatches } from './thresholdSamples'
import { buildRasterTransformers } from './localAnalyticsCrs'
import {
    buildSampleGridMetadata,
    pairAlignedRasterValues,
} from './rasterAlignment'
import { resolveRasterSamplingBbox } from './rasterBbox'
import { buildConfiguredAgentEndpoint } from './agentEndpoints'
import {
    configuredNoDataValues,
    resolveScalarRasterTransform,
} from './scalarRasterTransform'
import { compareDifferenceUnits } from './rasterDifferenceUnits'

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

async function extractSourceUrl(layerMatch, timeTokens = {}) {
    const layerMeta = layerMatch?.layer || {}
    const layerConfig =
        (layerMeta.config && typeof layerMeta.config === 'object'
            ? layerMeta.config
            : layerMeta) || {}
    const candidates = [
        layerConfig.cogUrl,
        layerConfig.demtileurl,
        layerConfig.demurl,
        layerConfig.demUrl,
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

    const sourceType = String(
        layerConfig.sourceType || layerConfig.demSourceType || ''
    ).toLowerCase()
    const isStac =
        sourceType === 'stac-collection' || /^stac-collection:/i.test(raw)
    if (isStac) {
        const collection = raw
            .replace(/^stac-collection:/i, '')
            .split('?')[0]
            .trim()
        if (!collection) {
            const error = new Error(
                'The selected STAC layer does not identify a collection to analyze.'
            )
            error.code = 'LOCAL_ANALYTICS_SOURCE_UNAVAILABLE'
            throw error
        }
        const endpoint = buildConfiguredAgentEndpoint({
            path: '/analytics/resolve-cog',
            mission: L_?.mission || '',
            rootPath: window?.mmgisglobal?.ROOT_PATH || '',
            configuredUrl: window?.mmgisAgentChat?.getAgentApiUrl,
            params: {
                layer: collection,
                time:
                    timeTokens['{endtime}'] ||
                    timeTokens['{time}'] ||
                    undefined,
            },
            origin: window?.location?.origin || '',
        })
        try {
            const response = await fetch(endpoint, {
                headers: { Accept: 'application/json' },
            })
            const payload = await response.json().catch(() => null)
            if (response.ok && typeof payload?.url === 'string') {
                resolved = payload.url.trim()
            } else {
                throw new Error('STAC collection did not resolve to a raster.')
            }
        } catch (cause) {
            console.error(
                `[AgentChat] STAC collection "${collection}" could not be resolved for local analytics.`,
                cause
            )
            const error = new Error(
                'The selected STAC collection could not be resolved to an analyzable raster.'
            )
            error.code = 'LOCAL_ANALYTICS_SOURCE_UNAVAILABLE'
            throw error
        }
    }

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
    const root = `${window.location.origin}${(
        window.mmgisglobal?.ROOT_PATH || ''
    ).replace(/\/$/, '')}`
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

function convertBboxToImage(area, datasetBBox, transformer) {
    const projected = resolveRasterSamplingBbox(
        area,
        datasetBBox,
        transformer.toImage
    )
    if (!projected) {
        const error = new Error(
            'The selected geographic bounds could not be projected into the raster reference system.'
        )
        error.code = 'LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED'
        throw error
    }
    return projected
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
    const layerMeta = layerMatch?.layer || {}
    const layerConfig =
        (layerMeta.config && typeof layerMeta.config === 'object'
            ? layerMeta.config
            : layerMeta) || {}
    const timeTokens = {
        '{time}':
            options.time || layerMatch?.layer?.liveInstance?.options?.time,
        '{starttime}':
            options.startTime ||
            layerMatch?.layer?.liveInstance?.options?.starttime,
        '{endtime}':
            options.endTime ||
            layerMatch?.layer?.liveInstance?.options?.endtime,
    }
    const sourceUrl = await extractSourceUrl(layerMatch, timeTokens)
    if (!sourceUrl) {
        throw new Error(
            `Layer "${layerMatch?.displayName || 'unknown'}" is missing a COG URL for local analytics.`
        )
    }
    const tiff = await getGeoTiff(sourceUrl)
    const image = await tiff.getImage()
    const band = Number(options.band || 1)
    const sampleCount = Number(
        image.getSamplesPerPixel?.() ||
            image.fileDirectory?.SamplesPerPixel ||
            1
    )
    if (!Number.isInteger(band) || band < 1 || band > sampleCount) {
        const error = new Error(
            `Raster band ${options.band} is not available in the selected GeoTIFF.`
        )
        error.code = 'LOCAL_ANALYTICS_BAND_UNAVAILABLE'
        throw error
    }
    const scalarTransform = resolveScalarRasterTransform(layerConfig, band)
    if (!scalarTransform.ok) {
        const error = new Error(scalarTransform.message)
        error.code = scalarTransform.errorCode
        throw error
    }
    const transformer = buildRasterTransformers(image)
    const datasetBBox = image.getBoundingBox()
    const areaImageBBox = convertBboxToImage(area, datasetBBox, transformer)
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
        throw new Error(
            'Unable to derive raster window for the selected region.'
        )
    }
    const approxWidth = window[2] - window[0]
    const approxHeight = window[3] - window[1]
    const approxPixels = approxWidth * approxHeight
    const readOptions = { window, samples: [band - 1] }
    const maxPixels = options.maxPixels || DEFAULT_MAX_PIXELS
    if (approxPixels > maxPixels) {
        const scale = Math.sqrt(approxPixels / maxPixels)
        readOptions.width = Math.max(1, Math.floor(approxWidth / scale))
        readOptions.height = Math.max(1, Math.floor(approxHeight / scale))
    }
    const raster = await image.readRasters(readOptions)
    const width = readOptions.width || raster.width || approxWidth
    const height = readOptions.height || raster.height || approxHeight
    const sampledCellCount = width * height
    const isSampled = sampledCellCount < approxPixels
    const data = Array.isArray(raster) ? raster[0] : raster
    const grid = buildSampleGridMetadata({
        crs: transformer.crs,
        datasetBBox,
        imageWidth: image.getWidth(),
        imageHeight: image.getHeight(),
        window,
        width,
        height,
    })
    const { pixelWidth, pixelHeight } = grid
    const nodataSet = new Set()
    const nodataRaw = image.getGDALNoData?.()
    if (Array.isArray(nodataRaw)) {
        nodataRaw.forEach((v) => nodataSet.add(Number(v)))
    } else if (nodataRaw != null) {
        nodataSet.add(Number(nodataRaw))
    }
    configuredNoDataValues(layerConfig).forEach((value) => nodataSet.add(value))
    const geometry = normalizeGeometry(options.geometry, area.bbox)
    const requireMask = options.forceMask || !isGeometryDerived(geometry)
    const values = []
    // Keep the source raster index aligned with every compacted valid value.
    // `values` omits NoData and polygon-excluded pixels, so its array index is
    // not a raster cell index and must never be used to derive coordinates.
    const sourceIndices = []
    const samples = options.includeCoordinates ? [] : null
    let nodataCount = 0
    for (let idx = 0; idx < data.length; idx += 1) {
        const rawValue = data[idx]
        if ((nodataSet.size && nodataSet.has(rawValue)) || rawValue == null) {
            nodataCount += 1
            continue
        }
        if (!Number.isFinite(rawValue)) {
            nodataCount += 1
            continue
        }
        const value = scalarTransform.apply(rawValue)
        if (!Number.isFinite(value)) {
            // Values outside an explicitly configured display-domain range are
            // fill/invalid cells for this declared transform, not observations.
            nodataCount += 1
            continue
        }
        let lon = null
        let lat = null
        if (requireMask || samples) {
            const col = idx % width
            const row = Math.floor(idx / width)
            const x = grid.bbox[0] + (col + 0.5) * pixelWidth
            const y = grid.bbox[3] - (row + 0.5) * pixelHeight
            ;[lon, lat] = transformer.toLatLon(x, y)
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
                continue
            }
            if (
                requireMask &&
                !booleanPointInPolygon(turfPoint([lon, lat]), geometry)
            )
                continue
        }
        values.push(value)
        sourceIndices.push(idx)
        if (samples) samples.push({ lon, lat, value, sourceIndex: idx })
    }
    if (!values.length) {
        throw new Error('No valid pixels found inside the requested region.')
    }
    return {
        values,
        sourceIndices,
        samples,
        rawData: data,
        nodataSet,
        width,
        height,
        ...grid,
        totalCount: data.length,
        sampleCount: data.length,
        populationCount: approxPixels,
        populationCoverage:
            approxPixels > 0 ? Math.min(1, data.length / approxPixels) : null,
        isSampled,
        nodataCount,
        geometry,
        requireMask,
        toLatLon: transformer.toLatLon,
        scalarTransform: {
            expression: scalarTransform.expression,
            transformed: scalarTransform.transformed,
            validRange: scalarTransform.validRange,
            unit: scalarTransform.unit,
            band,
        },
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

export async function calculateLocalBasicStats(layerMatch, area, options = {}) {
    const context = await sampleRaster(layerMatch, area, options)
    const stats = summarizeValues(context.values)
    return {
        ...stats,
        total_count: context.totalCount,
        valid_count: stats.count,
        nodata_count: context.nodataCount,
        sample_count: context.sampleCount,
        population_count: context.populationCount,
        population_coverage: context.populationCoverage,
        is_sampled: context.isSampled,
        mean_is_approximate: context.isSampled,
        quantiles_approximate: context.isSampled,
        method: context.isSampled
            ? 'bounded resampled raster grid'
            : 'native-resolution raster window',
        source: 'local-cog',
        unit: context.scalarTransform?.unit || null,
        value_expression: context.scalarTransform?.expression || null,
        valid_range: context.scalarTransform?.validRange || null,
        sample_count: context.sampleCount,
        population_count: context.populationCount,
        population_coverage: context.populationCoverage,
        is_sampled: context.isSampled,
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
    {
        operator = '>',
        value = 0,
        valueMin = null,
        valueMax = null,
        band = 1,
        geometry = null,
        maxPoints,
        time = null,
        startTime = null,
        endTime = null,
    } = {}
) {
    const context = await sampleRaster(layerMatch, area, {
        band,
        geometry,
        includeCoordinates: true,
        time,
        startTime,
        endTime,
    })
    const compareValue =
        operator === 'between'
            ? { min: Number(valueMin), max: Number(valueMax) }
            : Number(value)
    const { matches, matchCount } = collectThresholdMatches(
        context.samples,
        operator,
        compareValue,
        maxPoints || DEFAULT_MAX_MASK_POINTS
    )
    return {
        matches,
        matchCount,
        totalCount: context.values.length,
        sampleCount: context.sampleCount,
        populationCount: context.populationCount,
        isSampled: context.isSampled,
        unit: context.scalarTransform?.unit || null,
        valueExpression: context.scalarTransform?.expression || null,
        coverage:
            context.values.length > 0 ? matchCount / context.values.length : 0,
        source: 'local-cog',
    }
}

/**
 * Compare two raster sources only after the shared sampler proves identical
 * CRS, affine grid, bounded window, resampling dimensions, and co-located
 * valid-cell masks. Values are the mission-declared display-domain values,
 * never independently compacted or untransformed source arrays.
 */
export async function calculateLocalAlignedDifference(
    layerA,
    layerB,
    area,
    options = {}
) {
    const [left, right] = await Promise.all([
        sampleRaster(layerA, area, {
            maxPixels: options.maxPixels || 300000,
            time: options.timeA || options.time,
            startTime: options.startTimeA || options.startTime,
            endTime: options.endTimeA || options.endTime,
        }),
        sampleRaster(layerB, area, {
            maxPixels: options.maxPixels || 300000,
            time: options.timeB || options.time,
            startTime: options.startTimeB || options.startTime,
            endTime: options.endTimeB || options.endTime,
        }),
    ])
    const unitA = String(left.scalarTransform?.unit || '').trim()
    const unitB = String(right.scalarTransform?.unit || '').trim()
    const unitCompatibility = compareDifferenceUnits(unitA, unitB)
    if (!unitCompatibility.ok) {
        const error = new Error(unitCompatibility.message)
        error.code = unitCompatibility.code
        throw error
    }
    const paired = pairAlignedRasterValues(left, right)
    if (!paired.ok || !paired.valuesA.length) {
        const error = new Error(
            paired.reason || 'No co-located valid raster cells were found.'
        )
        error.code = paired.code || 'DIFFERENCE_ALIGNMENT_REQUIRED'
        throw error
    }
    const differences = paired.valuesA.map(
        (value, index) => value - paired.valuesB[index]
    )
    const summary = summarizeValues(differences)
    const leftSummary = summarizeValues(paired.valuesA)
    const rightSummary = summarizeValues(paired.valuesB)
    const sampled = left.isSampled || right.isSampled
    return {
        ...summary,
        mean_a: leftSummary.mean,
        mean_b: rightSummary.mean,
        valid_count: summary.count,
        total_count: paired.valuesA.length,
        sample_count: paired.valuesA.length,
        population_count: Math.min(
            left.populationCount || paired.valuesA.length,
            right.populationCount || paired.valuesA.length
        ),
        population_coverage: Math.min(
            left.populationCoverage ?? 1,
            right.populationCoverage ?? 1
        ),
        is_sampled: sampled,
        mean_is_approximate: sampled,
        quantiles_approximate: sampled,
        method: sampled
            ? 'bounded aligned resampled raster grid'
            : 'aligned native-resolution raster window',
        unit: unitCompatibility.unit,
        source: 'local-aligned-cog',
        alignment: paired.reason,
        left_expression: left.scalarTransform?.expression || null,
        right_expression: right.scalarTransform?.expression || null,
    }
}

export function logLocalAnalyticsEvent(message, context) {
    logLocal(message, context)
}
