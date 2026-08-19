// Advanced Statistical Analysis Functions for MMGIS Copilot
// Provides comprehensive statistical analysis beyond basic mean calculations

import {
    buildLayerIndex,
    findLayerMatch,
    resolveArea,
    createAreaUnresolvedError,
    drawAreaHighlight,
} from './rendererUtils.js'
import {
    calculateLocalBasicStats,
    sampleRaster,
    summarizeValues,
} from './localAnalytics.js'
import { getLayerTimeMetadata, detectCadence } from './timeUtils.js'
import {
    pairAlignedRasterValues,
    generateUtcTimePoints,
} from './rasterAlignment.js'
import { computeLinearTrend } from './temporalRegression.js'
import { resolveSpatialAnalysisType } from './spatialAnalysisPolicy.js'

/**
 * Calculate comprehensive statistics for multiple layers
 * by sampling real raster data from each layer's COG.
 */
export async function calculateMultiLayerStats(layerNames, options = {}) {
    const {
        area = 'current view',
        timeRange = null,
        includeCorrelation = true,
    } = options

    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw createAreaUnresolvedError(area)
    }

    // Resolve all layers and sample real raster data
    const layerStats = {}
    const layerRasters = {}
    const errors = []

    for (const layerName of layerNames) {
        const layerMatch = findLayerMatch(layerName)
        if (!layerMatch || !layerMatch.layer) {
            errors.push({
                layer: layerName,
                error: `Unable to locate layer "${layerName}"`,
            })
            continue
        }

        const resolvedName = layerMatch.displayName || layerName

        try {
            const rasterContext = await sampleRaster(layerMatch, resolvedArea, {
                maxPixels: 300000,
            })

            const stats = summarizeValues(rasterContext.values)

            // Compute skewness and kurtosis from the real values
            const n = stats.count
            const mean = stats.mean
            const std = stats.std

            let skewness = 0
            let kurtosis = 0
            if (n > 2 && std > 0) {
                let m3 = 0
                let m4 = 0
                for (let k = 0; k < rasterContext.values.length; k++) {
                    const d = rasterContext.values[k] - mean
                    m3 += d * d * d
                    m4 += d * d * d * d
                }
                m3 /= n
                m4 /= n
                const std3 = std * std * std
                const std4 = std3 * std
                skewness = std3 > 0 ? m3 / std3 : 0
                kurtosis = std4 > 0 ? m4 / std4 : 0 // excess kurtosis = kurtosis - 3
            }

            layerStats[resolvedName] = {
                mean: stats.mean,
                std: stats.std,
                min: stats.min,
                max: stats.max,
                median: stats.median,
                q25: stats.q25,
                q75: stats.q75,
                skewness,
                kurtosis,
                valid_count: stats.count,
                nodata_count: rasterContext.nodataCount,
                total_count: rasterContext.totalCount,
            }

            // Keep the full sampling context. Correlation is permitted only
            // after CRS/grid alignment and shared valid cells are proven.
            if (includeCorrelation) {
                layerRasters[resolvedName] = rasterContext
            }
        } catch (err) {
            errors.push({
                layer: resolvedName,
                error: err.message || String(err),
            })
        }
    }

    if (!Object.keys(layerStats).length) {
        throw new Error(
            `Failed to retrieve data for any of the ${layerNames.length} layers. ` +
                `First error: ${errors[0]?.error || 'unknown'}`
        )
    }

    // Calculate Pearson correlations only from proven co-located cells.
    let correlations = null
    let correlationStatus = null
    if (includeCorrelation) {
        const resolvedNames = Object.keys(layerRasters)
        if (resolvedNames.length > 1) {
            const alignedCorrelations = {}
            const limitations = []
            for (let i = 0; i < resolvedNames.length; i++) {
                for (let j = i + 1; j < resolvedNames.length; j++) {
                    const nameA = resolvedNames[i]
                    const nameB = resolvedNames[j]
                    const pairName = `${nameA} vs ${nameB}`
                    const paired = pairAlignedRasterValues(
                        layerRasters[nameA],
                        layerRasters[nameB]
                    )
                    if (!paired.ok || paired.valuesA.length < 3) {
                        limitations.push({
                            pair: pairName,
                            code: paired.code || 'INSUFFICIENT_ALIGNED_DATA',
                            reason: paired.ok
                                ? 'At least three co-located valid cells are required.'
                                : paired.reason,
                        })
                        continue
                    }
                    alignedCorrelations[pairName] = pearsonCorrelation(
                        paired.valuesA,
                        paired.valuesB
                    )
                }
            }
            if (Object.keys(alignedCorrelations).length) {
                correlations = alignedCorrelations
            }
            correlationStatus = {
                requested: true,
                supported: limitations.length === 0 && !!correlations,
                code: limitations.length ? 'RASTER_ALIGNMENT_REQUIRED' : null,
                message: limitations.length
                    ? 'Correlation was not calculated for unaligned layer grids. Matching CRS, bounds, affine transforms, and shared valid-cell masks are required.'
                    : 'Correlation used proven co-located valid raster cells.',
                limitations,
            }
        }
    }

    return {
        area: resolvedArea.label,
        bbox: resolvedArea.bbox,
        timeRange,
        layerStats,
        correlations,
        correlationStatus,
        layerCount: Object.keys(layerStats).length,
        failedLayers: errors.length,
        errors: errors.length ? errors : undefined,
        analysisType: 'multi-layer-statistics',
        source: 'local-cog',
    }
}

/**
 * Compute Pearson correlation coefficient between two value arrays.
 * Inputs must already be paired co-located values of equal length.
 */
function pearsonCorrelation(valuesA, valuesB) {
    if (valuesA.length !== valuesB.length || valuesA.length < 3) return null
    const n = valuesA.length

    let sumA = 0,
        sumB = 0
    for (let i = 0; i < n; i++) {
        sumA += valuesA[i]
        sumB += valuesB[i]
    }
    const meanA = sumA / n
    const meanB = sumB / n

    let covAB = 0,
        varA = 0,
        varB = 0
    for (let i = 0; i < n; i++) {
        const da = valuesA[i] - meanA
        const db = valuesB[i] - meanB
        covAB += da * db
        varA += da * da
        varB += db * db
    }

    const denom = Math.sqrt(varA * varB)
    if (denom === 0) return 0
    return covAB / denom
}

/**
 * Format a Date as a strftime-style string used for layer time tokens.
 * Supports the subset of specifiers used by MMGIS / d3.utcFormat.
 */
function strftime(date, fmt) {
    const pad2 = (n) => String(n).padStart(2, '0')
    const pad3 = (n) => String(n).padStart(3, '0')
    const pad4 = (n) => String(n).padStart(4, '0')
    const months = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
    ]
    const monthsShort = months.map((m) => m.slice(0, 3))
    const days = [
        'Sunday',
        'Monday',
        'Tuesday',
        'Wednesday',
        'Thursday',
        'Friday',
        'Saturday',
    ]
    const daysShort = days.map((d) => d.slice(0, 3))
    const dayOfYear = () => {
        const start = Date.UTC(date.getUTCFullYear(), 0, 1)
        return Math.floor((date.getTime() - start) / 86400000) + 1
    }

    return fmt.replace(/%([YmdHMSBebjAaIpZ%])/g, (_match, spec) => {
        switch (spec) {
            case 'Y':
                return pad4(date.getUTCFullYear())
            case 'm':
                return pad2(date.getUTCMonth() + 1)
            case 'd':
                return pad2(date.getUTCDate())
            case 'e':
                return String(date.getUTCDate())
            case 'H':
                return pad2(date.getUTCHours())
            case 'I':
                return pad2(date.getUTCHours() % 12 || 12)
            case 'M':
                return pad2(date.getUTCMinutes())
            case 'S':
                return pad2(date.getUTCSeconds())
            case 'B':
                return months[date.getUTCMonth()]
            case 'b':
                return monthsShort[date.getUTCMonth()]
            case 'A':
                return days[date.getUTCDay()]
            case 'a':
                return daysShort[date.getUTCDay()]
            case 'j':
                return pad3(dayOfYear())
            case 'p':
                return date.getUTCHours() < 12 ? 'AM' : 'PM'
            case 'Z':
                return 'Z'
            case '%':
                return '%'
            default:
                return `%${spec}`
        }
    })
}

/**
 * Calculate temporal statistics for a single layer across time
 * by sampling real raster data at each time step.
 */
export async function calculateTemporalTrends(layerName, options = {}) {
    const {
        area = 'current view',
        startTime = null,
        endTime = null,
        interval = 'monthly',
        layerMatch: providedLayerMatch = null,
    } = options

    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw createAreaUnresolvedError(area)
    }

    // Resolve the layer
    const layerMatch = providedLayerMatch || findLayerMatch(layerName)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(
            `Unable to locate configuration for layer "${layerName}".`
        )
    }

    const layerConfig = layerMatch.layer.config || layerMatch.layer
    const timeMeta = getLayerTimeMetadata(layerConfig)

    if (!timeMeta.enabled) {
        throw new Error(
            `Layer "${layerMatch.displayName || layerName}" is not time-enabled. ` +
                'Temporal trend analysis requires a layer with time configuration.'
        )
    }

    // Determine the time format for URL token substitution
    const timeFmt = timeMeta.format || '%Y-%m-%dT%H:%M:%SZ'

    // Determine the time range – prefer user-supplied, fall back to layer bounds
    const rangeStart = startTime
        ? new Date(startTime)
        : timeMeta.availableStart
          ? new Date(timeMeta.availableStart)
          : null
    const rangeEnd = endTime
        ? new Date(endTime)
        : timeMeta.availableEnd
          ? new Date(timeMeta.availableEnd)
          : null

    if (!rangeStart || !rangeEnd || isNaN(rangeStart) || isNaN(rangeEnd)) {
        throw new Error(
            'Unable to determine a valid time range for this layer. ' +
                'Provide time_start / time_end or ensure the layer has availableStart/End configured.'
        )
    }

    // Generate time points
    const timePoints = generateUtcTimePoints(
        rangeStart.toISOString().split('T')[0],
        rangeEnd.toISOString().split('T')[0],
        interval
    )

    if (!timePoints.length) {
        throw new Error(
            'No time steps generated for the requested range and interval.'
        )
    }

    // Cap to a reasonable number of steps to avoid excessive network requests
    const MAX_STEPS = 36
    const step =
        timePoints.length > MAX_STEPS
            ? Math.ceil(timePoints.length / MAX_STEPS)
            : 1
    const sampledTimePoints = timePoints.filter(
        (_, i) => i % step === 0 || i === timePoints.length - 1
    )

    // Sample real raster data at each time step
    const trendData = []
    const errors = []

    for (const timeStr of sampledTimePoints) {
        const dateObj = new Date(timeStr + 'T00:00:00Z')
        const formattedTime = strftime(dateObj, timeFmt)

        try {
            const stats = await calculateLocalBasicStats(
                layerMatch,
                resolvedArea,
                {
                    time: formattedTime,
                    startTime: formattedTime,
                    endTime: formattedTime,
                    maxPixels: 200000,
                }
            )

            trendData.push({
                time: timeStr,
                mean: stats.mean,
                std: stats.std,
                min: stats.min,
                max: stats.max,
                median: stats.median,
                valid_count: stats.valid_count,
                nodata_count: stats.nodata_count,
            })
        } catch (err) {
            errors.push({ time: timeStr, error: err.message || String(err) })
        }
    }

    if (!trendData.length) {
        throw new Error(
            `Failed to retrieve raster data for any of the ${sampledTimePoints.length} time steps. ` +
                `First error: ${errors[0]?.error || 'unknown'}`
        )
    }

    // Compute anomaly scores using z-score across the time series means
    const means = trendData.map((d) => d.mean)
    const globalMean = means.reduce((s, v) => s + v, 0) / means.length
    const globalStd = Math.sqrt(
        means.reduce((s, v) => s + (v - globalMean) ** 2, 0) / means.length
    )

    trendData.forEach((point) => {
        if (globalStd > 0) {
            const zScore = Math.abs(point.mean - globalMean) / globalStd
            point.anomaly_score =
                zScore > 2 ? 'high' : zScore > 1 ? 'moderate' : 'normal'
        } else {
            point.anomaly_score = 'normal'
        }
    })

    // Calculate overall trend using linear regression
    const overallTrend = computeLinearTrend(trendData)

    return {
        layer: layerMatch.displayName || layerName,
        area: resolvedArea.label,
        timeRange: {
            start: sampledTimePoints[0],
            end: sampledTimePoints[sampledTimePoints.length - 1],
        },
        interval,
        trendData,
        overallTrend,
        sampledSteps: trendData.length,
        failedSteps: errors.length,
        errors: errors.length ? errors : undefined,
        analysisType: 'temporal-trend',
        source: 'local-cog',
    }
}

/**
 * Calculate spatial autocorrelation and clustering statistics
 * by sampling real raster data and aggregating into a spatial grid.
 */
export async function calculateSpatialStatistics(layerName, options = {}) {
    const {
        area = 'current view',
        gridSize = 16,
        analysisType = 'moran',
        layerMatch: providedLayerMatch = null,
    } = options
    const resolvedAnalysisType = resolveSpatialAnalysisType(analysisType)
    if (!resolvedAnalysisType.ok) {
        const error = new Error(resolvedAnalysisType.message)
        error.code = resolvedAnalysisType.errorCode
        throw error
    }

    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw createAreaUnresolvedError(area)
    }

    const layerMatch = providedLayerMatch || findLayerMatch(layerName)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(
            `Unable to locate configuration for layer "${layerName}".`
        )
    }

    // Sample the raster. sourceIndices and values preserve the spatial grid
    // positions of only valid, geometry-masked, display-domain observations.
    const rasterContext = await sampleRaster(layerMatch, resolvedArea, {
        maxPixels: 400000,
    })
    const { width, height, bbox, toLatLon, pixelWidth, pixelHeight } =
        rasterContext
    const validValueByIndex = new Map(
        (rasterContext.sourceIndices || []).map((sourceIndex, position) => [
            sourceIndex,
            rasterContext.values[position],
        ])
    )

    // Aggregate raw pixels into a gridSize x gridSize grid of cell means
    const clampedGridRows = Math.min(gridSize, height)
    const clampedGridCols = Math.min(gridSize, width)
    const cellW = width / clampedGridCols
    const cellH = height / clampedGridRows

    // grid[row][col] = mean value of the cell, or NaN if all nodata
    const grid = []
    for (let gr = 0; gr < clampedGridRows; gr++) {
        const row = []
        for (let gc = 0; gc < clampedGridCols; gc++) {
            const rStart = Math.floor(gr * cellH)
            const rEnd = Math.min(Math.floor((gr + 1) * cellH), height)
            const cStart = Math.floor(gc * cellW)
            const cEnd = Math.min(Math.floor((gc + 1) * cellW), width)
            let sum = 0
            let count = 0
            for (let r = rStart; r < rEnd; r++) {
                for (let c = cStart; c < cEnd; c++) {
                    const sourceIndex = r * width + c
                    if (!validValueByIndex.has(sourceIndex)) continue
                    const val = validValueByIndex.get(sourceIndex)
                    if (val == null || !Number.isFinite(val)) continue
                    sum += val
                    count++
                }
            }
            row.push(count > 0 ? sum / count : NaN)
        }
        grid.push(row)
    }

    // Collect valid cells with their grid positions
    const validCells = []
    for (let r = 0; r < clampedGridRows; r++) {
        for (let c = 0; c < clampedGridCols; c++) {
            if (Number.isFinite(grid[r][c])) {
                validCells.push({ row: r, col: c, value: grid[r][c] })
            }
        }
    }

    if (validCells.length < 4) {
        throw new Error(
            `Only ${validCells.length} valid grid cell(s) found. ` +
                'Spatial statistics require at least 4 cells with data.'
        )
    }

    // Compute global mean and variance of cell values
    const n = validCells.length
    const globalMean = validCells.reduce((s, c) => s + c.value, 0) / n
    const globalVar =
        validCells.reduce((s, c) => s + (c.value - globalMean) ** 2, 0) / n

    // --- Moran's I with queen contiguity (8-neighbor) ---
    const cellIndex = new Map()
    validCells.forEach((cell, idx) => {
        cellIndex.set(`${cell.row},${cell.col}`, idx)
    })

    let numerator = 0
    let W = 0
    const neighborOffsets = [
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, -1],
        [0, 1],
        [1, -1],
        [1, 0],
        [1, 1],
    ]

    for (let i = 0; i < n; i++) {
        const ci = validCells[i]
        const zi = ci.value - globalMean
        for (const [dr, dc] of neighborOffsets) {
            const nKey = `${ci.row + dr},${ci.col + dc}`
            const j = cellIndex.get(nKey)
            if (j != null) {
                const zj = validCells[j].value - globalMean
                numerator += zi * zj
                W++
            }
        }
    }

    const denominator = validCells.reduce(
        (s, c) => s + (c.value - globalMean) ** 2,
        0
    )
    const moranI =
        denominator > 0 && W > 0 ? (n / W) * (numerator / denominator) : 0

    const expectedI = -1 / (n - 1)
    const interpretation =
        moranI > expectedI
            ? 'Positive spatial association relative to the randomization expectation (descriptive only).'
            : moranI < expectedI
              ? 'Negative spatial association relative to the randomization expectation (descriptive only).'
              : 'Spatial association is at the randomization expectation (descriptive only).'

    // --- Getis-Ord Gi* for hotspot / coldspot detection ---
    const hotspots = []
    const coldspots = []
    const clusters = { highHigh: 0, lowLow: 0, highLow: 0, lowHigh: 0 }
    const globalStd = Math.sqrt(globalVar)

    for (let i = 0; i < n; i++) {
        const ci = validCells[i]
        let localSum = ci.value
        let localW = 1 // include self for Gi*
        let localWSq = 1
        for (const [dr, dc] of neighborOffsets) {
            const nKey = `${ci.row + dr},${ci.col + dc}`
            const j = cellIndex.get(nKey)
            if (j != null) {
                localSum += validCells[j].value
                localW++
                localWSq++
            }
        }
        // Gi* = (localSum - globalMean * localW) / (globalStd * sqrt((n*localWSq - localW^2)/(n-1)))
        const giDenom =
            globalStd > 0
                ? globalStd *
                  Math.sqrt(
                      Math.max(
                          0,
                          (n * localWSq - localW * localW) / Math.max(1, n - 1)
                      )
                  )
                : 1
        const giStar =
            giDenom > 0 ? (localSum - globalMean * localW) / giDenom : 0

        // Convert grid cell to geographic center
        const pixX = bbox[0] + (ci.col + 0.5) * cellW * pixelWidth
        const pixY = bbox[3] - (ci.row + 0.5) * cellH * pixelHeight
        const [lon, lat] = toLatLon(pixX, pixY)

        if (giStar > 1.96) {
            hotspots.push({
                center: [lon, lat],
                giStar,
                intensity: giStar,
                inference: 'descriptive-candidate',
            })
        } else if (giStar < -1.96) {
            coldspots.push({
                center: [lon, lat],
                giStar,
                intensity: giStar,
                inference: 'descriptive-candidate',
            })
        }

        // LISA-style cluster classification
        const zi = ci.value - globalMean
        let neighborMean = 0
        let neighborCount = 0
        for (const [dr, dc] of neighborOffsets) {
            const nKey = `${ci.row + dr},${ci.col + dc}`
            const j = cellIndex.get(nKey)
            if (j != null) {
                neighborMean += validCells[j].value - globalMean
                neighborCount++
            }
        }
        if (neighborCount > 0) {
            neighborMean /= neighborCount
            if (zi > 0 && neighborMean > 0) clusters.highHigh++
            else if (zi < 0 && neighborMean < 0) clusters.lowLow++
            else if (zi > 0 && neighborMean < 0) clusters.highLow++
            else if (zi < 0 && neighborMean > 0) clusters.lowHigh++
        }
    }

    // Sort hotspots/coldspots by intensity
    hotspots.sort((a, b) => b.intensity - a.intensity)
    coldspots.sort((a, b) => a.intensity - b.intensity)

    const spatialStats = {
        moransI: {
            value: moranI,
            expected: expectedI,
            interpretation,
            inference:
                'No p-value or significance test was calculated; use a validated permutation model for inference.',
        },
        hotspots: hotspots.slice(0, 10),
        coldspots: coldspots.slice(0, 10),
        clusters,
    }

    return {
        layer: layerMatch.displayName || layerName,
        area: resolvedArea.label,
        gridSize: `${clampedGridCols}x${clampedGridRows}`,
        validCells: n,
        rasterPixels: rasterContext.values.length,
        polygonMaskApplied: rasterContext.requireMask === true,
        globalMean,
        globalStd,
        spatialStats,
        analysisType: resolvedAnalysisType.analysisType,
        source: 'local-cog',
    }
}

/**
 * Calculate change detection between two time periods
 * by sampling real raster data at each time and comparing statistics.
 */
export async function calculateChangeDetection(layerName, options = {}) {
    const {
        area = 'current view',
        beforeTime = null,
        afterTime = null,
        changeThreshold = 0.1,
        layerMatch: providedLayerMatch = null,
    } = options

    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw createAreaUnresolvedError(area)
    }

    const layerMatch = providedLayerMatch || findLayerMatch(layerName)
    if (!layerMatch || !layerMatch.layer) {
        throw new Error(
            `Unable to locate configuration for layer "${layerName}".`
        )
    }

    const layerConfig = layerMatch.layer.config || layerMatch.layer
    const timeMeta = getLayerTimeMetadata(layerConfig)

    if (!timeMeta.enabled) {
        throw new Error(
            `Layer "${layerMatch.displayName || layerName}" is not time-enabled. ` +
                'Change detection requires a layer with time configuration.'
        )
    }

    const timeFmt = timeMeta.format || '%Y-%m-%dT%H:%M:%SZ'

    // Determine before/after times
    const resolvedBefore = beforeTime
        ? new Date(beforeTime)
        : timeMeta.availableStart
          ? new Date(timeMeta.availableStart)
          : null
    const resolvedAfter = afterTime
        ? new Date(afterTime)
        : timeMeta.availableEnd
          ? new Date(timeMeta.availableEnd)
          : null

    if (
        !resolvedBefore ||
        !resolvedAfter ||
        isNaN(resolvedBefore) ||
        isNaN(resolvedAfter)
    ) {
        throw new Error(
            'Unable to determine valid before/after times. ' +
                'Provide before_time / after_time or ensure the layer has availableStart/End configured.'
        )
    }

    const beforeFormatted = strftime(resolvedBefore, timeFmt)
    const afterFormatted = strftime(resolvedAfter, timeFmt)

    // Sample raster at both time steps to get per-pixel data
    const [beforeRaster, afterRaster] = await Promise.all([
        sampleRaster(layerMatch, resolvedArea, {
            time: beforeFormatted,
            startTime: beforeFormatted,
            endTime: beforeFormatted,
            maxPixels: 300000,
        }),
        sampleRaster(layerMatch, resolvedArea, {
            time: afterFormatted,
            startTime: afterFormatted,
            endTime: afterFormatted,
            maxPixels: 300000,
        }),
    ])

    // Compute summary statistics for each period
    const beforeStats = summarizeValues(beforeRaster.values)
    const afterStats = summarizeValues(afterRaster.values)

    // Compute change metrics
    const changes = {
        meanChange: afterStats.mean - beforeStats.mean,
        meanPercentChange:
            beforeStats.mean !== 0
                ? ((afterStats.mean - beforeStats.mean) /
                      Math.abs(beforeStats.mean)) *
                  100
                : 0,
        stdChange: afterStats.std - beforeStats.std,
        variabilityChange: afterStats.std - beforeStats.std,
        rangeChange:
            afterStats.max -
            afterStats.min -
            (beforeStats.max - beforeStats.min),
        medianChange: afterStats.median - beforeStats.median,
    }

    // Pixel-level change analysis requires proven CRS/grid alignment and a
    // shared valid-cell intersection. Equal dimensions alone are insufficient.
    let spatialChangePattern
    const paired = pairAlignedRasterValues(beforeRaster, afterRaster)
    if (paired.ok) {
        let increasing = 0
        let decreasing = 0
        let stable = 0
        const totalValid = paired.valuesA.length

        for (let i = 0; i < totalValid; i++) {
            const vb = paired.valuesA[i]
            const va = paired.valuesB[i]
            const diff = va - vb
            if (Math.abs(diff) <= changeThreshold) {
                stable++
            } else if (diff > 0) {
                increasing++
            } else {
                decreasing++
            }
        }

        if (totalValid > 0) {
            spatialChangePattern = {
                increasingAreas: (increasing / totalValid) * 100,
                decreasingAreas: (decreasing / totalValid) * 100,
                stableAreas: (stable / totalValid) * 100,
                dominantPattern:
                    increasing > decreasing
                        ? 'increasing'
                        : decreasing > increasing
                          ? 'decreasing'
                          : 'stable',
                totalPixelsCompared: totalValid,
                threshold: changeThreshold,
            }
        }
    }

    if (!spatialChangePattern) {
        spatialChangePattern = {
            dominantPattern:
                changes.meanChange > 0 ? 'increasing' : 'decreasing',
            alignmentRequired: true,
            code: paired.code || 'RASTER_ALIGNMENT_REQUIRED',
            note: 'Pixel-level change distribution was not calculated because matching CRS, bounds, affine transforms, and shared valid-cell masks were not proven.',
        }
    }

    const absolutePercentChange = Math.abs(changes.meanPercentChange)
    const assessment = {
        kind: 'descriptive',
        overallAssessment:
            absolutePercentChange > 10
                ? 'Large descriptive mean change'
                : absolutePercentChange > 2
                  ? 'Moderate descriptive mean change'
                  : 'Small descriptive mean change',
        inference:
            'No t-test, p-value, or statistical significance is reported because raster pixels are spatially autocorrelated and an effective-sample or permutation model was not established.',
    }

    return {
        layer: layerMatch.displayName || layerName,
        area: resolvedArea.label,
        timeComparison: {
            before: resolvedBefore.toISOString().split('T')[0],
            after: resolvedAfter.toISOString().split('T')[0],
        },
        beforeStats: {
            mean: beforeStats.mean,
            std: beforeStats.std,
            min: beforeStats.min,
            max: beforeStats.max,
            median: beforeStats.median,
            valid_count: beforeStats.count,
        },
        afterStats: {
            mean: afterStats.mean,
            std: afterStats.std,
            min: afterStats.min,
            max: afterStats.max,
            median: afterStats.median,
            valid_count: afterStats.count,
        },
        changes,
        assessment,
        spatialChangePattern,
        analysisType: 'change-detection',
        source: 'local-cog',
    }
}

/**
 * Format multi-layer statistics results
 */
export function formatMultiLayerResults(results) {
    const lines = []
    lines.push(`Multi-Layer Statistical Analysis`)
    lines.push(`Area: ${results.area}`)
    if (results.source) {
        lines.push(`Source: ${results.source}`)
    }
    lines.push(
        `Layers: ${results.layerCount} analyzed` +
            (results.failedLayers ? `, ${results.failedLayers} failed` : '')
    )
    lines.push('')

    // Layer statistics
    Object.entries(results.layerStats).forEach(([layerName, stats]) => {
        lines.push(`Layer: ${layerName}`)
        lines.push(`  Mean: ${stats.mean.toFixed(4)} ± ${stats.std.toFixed(4)}`)
        lines.push(
            `  Median: ${stats.median.toFixed(4)} | Q25: ${stats.q25.toFixed(4)} | Q75: ${stats.q75.toFixed(4)}`
        )
        lines.push(
            `  Range: [${stats.min.toFixed(4)}, ${stats.max.toFixed(4)}]`
        )
        lines.push(
            `  Skewness: ${stats.skewness.toFixed(3)} (${Math.abs(stats.skewness) > 1 ? 'highly skewed' : Math.abs(stats.skewness) > 0.5 ? 'moderately skewed' : 'approximately symmetric'})`
        )
        lines.push(
            `  Kurtosis: ${stats.kurtosis.toFixed(3)} (${stats.kurtosis > 3 ? 'leptokurtic' : stats.kurtosis < 3 ? 'platykurtic' : 'mesokurtic'})`
        )
        lines.push(
            `  Valid pixels: ${stats.valid_count.toLocaleString()}` +
                (stats.nodata_count
                    ? ` (${stats.nodata_count.toLocaleString()} nodata)`
                    : '')
        )
        lines.push('')
    })

    // Correlations
    if (results.correlations) {
        lines.push('Layer Correlations (Pearson r):')
        Object.entries(results.correlations).forEach(([pair, correlation]) => {
            if (correlation == null) {
                lines.push(`  ${pair}: insufficient overlapping data`)
                return
            }
            const strength =
                Math.abs(correlation) > 0.7
                    ? 'Strong'
                    : Math.abs(correlation) > 0.3
                      ? 'Moderate'
                      : 'Weak'
            const direction = correlation > 0 ? 'positive' : 'negative'
            lines.push(
                `  ${pair}: r=${correlation.toFixed(4)} (${strength} ${direction})`
            )
        })
    }
    if (results.correlationStatus?.message) {
        lines.push('')
        lines.push(`Correlation: ${results.correlationStatus.message}`)
    }

    if (results.errors && results.errors.length) {
        lines.push('')
        lines.push('Errors:')
        results.errors.forEach((e) => {
            lines.push(`  ${e.layer}: ${e.error}`)
        })
    }

    return lines.join('\n')
}

/**
 * Format temporal trend results
 */
export function formatTemporalTrendResults(results) {
    const lines = []
    lines.push(`Temporal Trend Analysis: ${results.layer}`)
    lines.push(`Area: ${results.area}`)
    lines.push(
        `Time Period: ${results.timeRange.start} to ${results.timeRange.end}`
    )
    lines.push(`Interval: ${results.interval}`)
    if (results.source) {
        lines.push(`Source: ${results.source}`)
    }
    lines.push(
        `Data Points: ${results.sampledSteps || results.trendData.length} sampled` +
            (results.failedSteps ? `, ${results.failedSteps} failed` : '')
    )
    lines.push('')

    lines.push('Overall Trend:')
    lines.push(`  Direction: ${results.overallTrend.direction}`)
    lines.push(`  Magnitude: ${results.overallTrend.magnitude.toFixed(3)}`)
    lines.push(
        `  Percent Change: ${results.overallTrend.percentChange.toFixed(1)}%`
    )
    lines.push(
        `  Descriptive trend strength: ${results.overallTrend.trendStrength}`
    )
    if (results.overallTrend.rSquared != null) {
        lines.push(`  R²: ${results.overallTrend.rSquared.toFixed(3)}`)
    }
    if (results.overallTrend.slope != null) {
        lines.push(
            `  Slope: ${results.overallTrend.slope.toFixed(6)} ${
                results.overallTrend.slopeUnit || 'value per day'
            }`
        )
    }
    lines.push('')

    // Show recent data points
    lines.push('Recent Data Points:')
    const recent = results.trendData.slice(-3)
    recent.forEach((point) => {
        lines.push(
            `  ${point.time}: mean=${point.mean.toFixed(3)} std=${point.std.toFixed(3)} [${point.min.toFixed(3)}, ${point.max.toFixed(3)}] (${point.anomaly_score})`
        )
    })

    if (results.errors && results.errors.length) {
        lines.push('')
        lines.push(
            `Note: ${results.errors.length} time step(s) could not be sampled.`
        )
    }

    return lines.join('\n')
}

/**
 * Format spatial statistics results
 */
export function formatSpatialStatsResults(results) {
    const lines = []
    lines.push(`Spatial Autocorrelation Analysis: ${results.layer}`)
    lines.push(`Area: ${results.area}`)
    if (results.source) {
        lines.push(`Source: ${results.source}`)
    }
    lines.push(
        `Grid: ${results.gridSize} (${results.validCells} valid cells from ${results.rasterPixels?.toLocaleString()} pixels)`
    )
    lines.push(
        `Global Mean: ${results.globalMean?.toFixed(4)} | Std: ${results.globalStd?.toFixed(4)}`
    )
    lines.push('')

    const moran = results.spatialStats.moransI
    lines.push("Moran's I Analysis:")
    lines.push(`  Index: ${moran.value.toFixed(4)}`)
    lines.push(`  Expected: ${moran.expected.toFixed(4)}`)
    lines.push(`  Interpretation: ${moran.interpretation}`)
    lines.push(`  Inference: ${moran.inference}`)
    lines.push('')

    lines.push('LISA Cluster Classification:')
    const clusters = results.spatialStats.clusters
    lines.push(`  High-High clusters: ${clusters.highHigh}`)
    lines.push(`  Low-Low clusters: ${clusters.lowLow}`)
    lines.push(`  High-Low outliers: ${clusters.highLow}`)
    lines.push(`  Low-High outliers: ${clusters.lowHigh}`)
    lines.push('')

    lines.push(
        `High local-score candidates: ${results.spatialStats.hotspots.length}`
    )
    if (results.spatialStats.hotspots.length) {
        results.spatialStats.hotspots.slice(0, 3).forEach((h, i) => {
            lines.push(
                `  ${i + 1}. [${h.center[0].toFixed(3)}, ${h.center[1].toFixed(3)}] local standardized score=${h.giStar.toFixed(2)} (descriptive candidate)`
            )
        })
    }
    lines.push(
        `Low local-score candidates: ${results.spatialStats.coldspots.length}`
    )
    if (results.spatialStats.coldspots.length) {
        results.spatialStats.coldspots.slice(0, 3).forEach((c, i) => {
            lines.push(
                `  ${i + 1}. [${c.center[0].toFixed(3)}, ${c.center[1].toFixed(3)}] local standardized score=${c.giStar.toFixed(2)} (descriptive candidate)`
            )
        })
    }

    return lines.join('\n')
}

/**
 * Format change detection results
 */
export function formatChangeDetectionResults(results) {
    const lines = []
    lines.push(`Change Detection Analysis: ${results.layer}`)
    lines.push(`Area: ${results.area}`)
    lines.push(
        `Comparison: ${results.timeComparison.before} vs ${results.timeComparison.after}`
    )
    if (results.source) {
        lines.push(`Source: ${results.source}`)
    }
    lines.push('')

    lines.push('Before Period:')
    const bs = results.beforeStats
    lines.push(
        `  Mean: ${bs.mean.toFixed(4)} | Std: ${bs.std.toFixed(4)} | Range: [${bs.min.toFixed(4)}, ${bs.max.toFixed(4)}]`
    )
    lines.push(
        `  Median: ${bs.median.toFixed(4)} | Valid pixels: ${(bs.valid_count || 0).toLocaleString()}`
    )
    lines.push('')

    lines.push('After Period:')
    const as = results.afterStats
    lines.push(
        `  Mean: ${as.mean.toFixed(4)} | Std: ${as.std.toFixed(4)} | Range: [${as.min.toFixed(4)}, ${as.max.toFixed(4)}]`
    )
    lines.push(
        `  Median: ${as.median.toFixed(4)} | Valid pixels: ${(as.valid_count || 0).toLocaleString()}`
    )
    lines.push('')

    lines.push('Statistical Changes:')
    const sign = (v) => (v > 0 ? '+' : '')
    lines.push(
        `  Mean change: ${sign(results.changes.meanChange)}${results.changes.meanChange.toFixed(4)} (${sign(results.changes.meanPercentChange)}${results.changes.meanPercentChange.toFixed(1)}%)`
    )
    lines.push(
        `  Median change: ${sign(results.changes.medianChange)}${results.changes.medianChange.toFixed(4)}`
    )
    lines.push(
        `  Std change: ${sign(results.changes.stdChange)}${results.changes.stdChange.toFixed(4)}`
    )
    lines.push(
        `  Range change: ${sign(results.changes.rangeChange)}${results.changes.rangeChange.toFixed(4)}`
    )
    lines.push('')

    lines.push(`Overall Assessment: ${results.assessment.overallAssessment}`)
    lines.push(`Inference: ${results.assessment.inference}`)
    lines.push('')

    lines.push('Spatial Change Distribution:')
    const spatial = results.spatialChangePattern
    if (spatial.increasingAreas != null) {
        lines.push(`  Increasing areas: ${spatial.increasingAreas.toFixed(1)}%`)
        lines.push(`  Decreasing areas: ${spatial.decreasingAreas.toFixed(1)}%`)
        lines.push(
            `  Stable areas: ${spatial.stableAreas.toFixed(1)}% (threshold: ${spatial.threshold})`
        )
        lines.push(`  Dominant pattern: ${spatial.dominantPattern}`)
        if (spatial.totalPixelsCompared) {
            lines.push(
                `  Pixels compared: ${spatial.totalPixelsCompared.toLocaleString()}`
            )
        }
    } else {
        lines.push(`  Dominant pattern: ${spatial.dominantPattern}`)
        if (spatial.note) {
            lines.push(`  Note: ${spatial.note}`)
        }
    }

    return lines.join('\n')
}

export default {
    calculateMultiLayerStats,
    calculateTemporalTrends,
    calculateSpatialStatistics,
    calculateChangeDetection,
    formatMultiLayerResults,
    formatTemporalTrendResults,
    formatSpatialStatsResults,
    formatChangeDetectionResults,
}
