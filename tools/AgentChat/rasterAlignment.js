const EPSILON = 1e-9

function finiteArray(value, minLength = 1) {
    return (
        Array.isArray(value) &&
        value.length >= minLength &&
        value.every((item) => Number.isFinite(Number(item)))
    )
}

function arraysEqual(a, b, epsilon = EPSILON) {
    return (
        finiteArray(a) &&
        finiteArray(b) &&
        a.length === b.length &&
        a.every(
            (value, index) =>
                Math.abs(Number(value) - Number(b[index])) <= epsilon
        )
    )
}

function normalizedCrs(context) {
    const value = context?.crs || context?.projection || context?.epsg
    return typeof value === 'string' && value.trim()
        ? value.trim().toUpperCase()
        : null
}

function gridTransform(context) {
    const value =
        context?.gridTransform || context?.transform || context?.affine
    return finiteArray(value, 4) ? value.map(Number) : null
}

/**
 * Return true only when two raster samples carry enough metadata to prove
 * cell-for-cell co-location. Matching dimensions alone are never sufficient.
 */
export function assessRasterAlignment(left, right) {
    if (!left || !right) {
        return {
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
            reason: 'Both raster samples are required.',
        }
    }
    if (left.width !== right.width || left.height !== right.height) {
        return {
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
            reason: 'Raster grid dimensions differ.',
        }
    }
    const leftCrs = normalizedCrs(left)
    const rightCrs = normalizedCrs(right)
    if (!leftCrs || !rightCrs || leftCrs !== rightCrs) {
        return {
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
            reason: 'A matching declared coordinate reference system is required.',
        }
    }
    if (!arraysEqual(left.bbox, right.bbox)) {
        return {
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
            reason: 'Raster bounds differ.',
        }
    }
    const leftTransform = gridTransform(left)
    const rightTransform = gridTransform(right)
    if (
        !leftTransform ||
        !rightTransform ||
        !arraysEqual(leftTransform, rightTransform)
    ) {
        return {
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
            reason: 'Matching affine/grid-transform metadata is required.',
        }
    }
    return {
        aligned: true,
        code: null,
        reason: 'Raster CRS, bounds, dimensions, and grid transforms match.',
    }
}

/**
 * Build cell-for-cell value pairs from the intersection of each sample's
 * valid source indices. This preserves asymmetric NoData and polygon masks.
 */
export function pairAlignedRasterValues(left, right) {
    const alignment = assessRasterAlignment(left, right)
    if (!alignment.aligned) {
        return {
            ok: false,
            ...alignment,
            valuesA: [],
            valuesB: [],
            indices: [],
        }
    }
    if (
        !Array.isArray(left.sourceIndices) ||
        !Array.isArray(right.sourceIndices) ||
        !Array.isArray(left.values) ||
        !Array.isArray(right.values) ||
        left.sourceIndices.length !== left.values.length ||
        right.sourceIndices.length !== right.values.length
    ) {
        return {
            ok: false,
            aligned: false,
            code: 'RASTER_VALID_MASK_REQUIRED',
            reason: 'Shared valid-cell masks are required for a co-located comparison.',
            valuesA: [],
            valuesB: [],
            indices: [],
        }
    }
    const leftValues = new Map(
        left.sourceIndices.map((index, position) => [
            index,
            left.values[position],
        ])
    )
    const rightValues = new Map(
        right.sourceIndices.map((index, position) => [
            index,
            right.values[position],
        ])
    )
    const indices = left.sourceIndices.filter((index) => rightValues.has(index))
    const valuesA = []
    const valuesB = []
    const pairedIndices = []
    for (const index of indices) {
        const valueA = Number(leftValues.get(index))
        const valueB = Number(rightValues.get(index))
        if (!Number.isFinite(valueA) || !Number.isFinite(valueB)) continue
        valuesA.push(valueA)
        valuesB.push(valueB)
        pairedIndices.push(index)
    }
    return {
        ok: true,
        aligned: true,
        code: null,
        reason: alignment.reason,
        valuesA,
        valuesB,
        indices: pairedIndices,
    }
}

/** Describe the exact pixel-aligned grid returned by readRasters(). */
export function buildSampleGridMetadata({
    crs,
    datasetBBox,
    imageWidth,
    imageHeight,
    window,
    width,
    height,
} = {}) {
    if (
        typeof crs !== 'string' ||
        !crs.trim() ||
        !finiteArray(datasetBBox, 4) ||
        !finiteArray(window, 4) ||
        !Number.isFinite(Number(imageWidth)) ||
        !Number.isFinite(Number(imageHeight)) ||
        !Number.isFinite(Number(width)) ||
        !Number.isFinite(Number(height)) ||
        Number(imageWidth) <= 0 ||
        Number(imageHeight) <= 0 ||
        Number(width) <= 0 ||
        Number(height) <= 0
    )
        throw new TypeError('Complete finite raster grid metadata is required.')
    const [datasetMinX, datasetMinY, datasetMaxX, datasetMaxY] =
        datasetBBox.map(Number)
    const [left, top, right, bottom] = window.map(Number)
    const sourcePixelWidth = (datasetMaxX - datasetMinX) / Number(imageWidth)
    const sourcePixelHeight = (datasetMaxY - datasetMinY) / Number(imageHeight)
    const bbox = [
        datasetMinX + left * sourcePixelWidth,
        datasetMaxY - bottom * sourcePixelHeight,
        datasetMinX + right * sourcePixelWidth,
        datasetMaxY - top * sourcePixelHeight,
    ]
    const pixelWidth = (bbox[2] - bbox[0]) / Number(width)
    const pixelHeight = (bbox[3] - bbox[1]) / Number(height)
    return {
        crs: crs.trim(),
        bbox,
        pixelWidth,
        pixelHeight,
        gridTransform: [pixelWidth, 0, bbox[0], 0, -pixelHeight, bbox[3]],
    }
}

function daysInUtcMonth(year, month) {
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function pointAt(start, interval, step) {
    const year = start.getUTCFullYear()
    const month = start.getUTCMonth()
    const day = start.getUTCDate()
    if (interval === 'daily') {
        return new Date(Date.UTC(year, month, day + step, start.getUTCHours()))
    }
    if (interval === 'weekly') {
        return new Date(
            Date.UTC(year, month, day + step * 7, start.getUTCHours())
        )
    }
    const monthStride =
        interval === 'quarterly' ? 3 : interval === 'yearly' ? 12 : 1
    const absoluteMonth = month + step * monthStride
    const targetYear = year + Math.floor(absoluteMonth / 12)
    const targetMonth = ((absoluteMonth % 12) + 12) % 12
    const targetDay = Math.min(day, daysInUtcMonth(targetYear, targetMonth))
    return new Date(
        Date.UTC(targetYear, targetMonth, targetDay, start.getUTCHours())
    )
}

export function generateUtcTimePoints(startTime, endTime, interval) {
    const start = new Date(startTime)
    const end = new Date(endTime)
    if (
        Number.isNaN(start.getTime()) ||
        Number.isNaN(end.getTime()) ||
        start > end
    )
        return []
    const normalizedInterval = [
        'daily',
        'weekly',
        'monthly',
        'quarterly',
        'yearly',
    ].includes(interval)
        ? interval
        : 'monthly'
    const points = []
    // The limit is a safety bound; callers independently cap expensive reads.
    for (let step = 0; step < 100000; step += 1) {
        const current = pointAt(start, normalizedInterval, step)
        if (current > end) break
        points.push(current.toISOString().split('T')[0])
    }
    return points
}
