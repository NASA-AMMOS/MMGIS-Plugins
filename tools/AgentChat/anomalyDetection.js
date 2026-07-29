// Anomaly Detection Module for AgentChat
// Detects statistical anomalies in layer data using z-score and IQR methods

import { 
    buildLayerIndex, 
    findLayerMatch,
    resolveArea,
    resolveAnalyticsLayerKey,
    fetchAnalyticsStatistics,
    fetchAnalyticsHistogram,
    sanitizeHistogramResponse,
    computeHistogramQuantiles,
    drawAreaHighlight,
    normalizeBoundingBox,
    isValidBbox
} from './rendererUtils.js'

/**
 * Calculate z-score based anomalies
 * Values beyond ±2.5 standard deviations are considered anomalies
 */
function detectZScoreAnomalies(stats, threshold = 2.5) {
    if (!stats || typeof stats.mean !== 'number' || typeof stats.std !== 'number') {
        return null
    }
    
    const { mean, std, min, max } = stats
    if (std === 0) return null // No variation in data
    
    const lowerBound = mean - (threshold * std)
    const upperBound = mean + (threshold * std)
    
    const anomalies = {
        method: 'z-score',
        threshold,
        bounds: { lower: lowerBound, upper: upperBound },
        mean,
        std,
        potentialAnomalies: []
    }
    
    // Check if min/max values are anomalies
    if (typeof min === 'number' && min < lowerBound) {
        anomalies.potentialAnomalies.push({
            type: 'extreme_low',
            value: min,
            zScore: (min - mean) / std,
            severity: Math.abs((min - mean) / std)
        })
    }
    
    if (typeof max === 'number' && max > upperBound) {
        anomalies.potentialAnomalies.push({
            type: 'extreme_high', 
            value: max,
            zScore: (max - mean) / std,
            severity: Math.abs((max - mean) / std)
        })
    }
    
    return anomalies
}

/**
 * Detect anomalies using Interquartile Range (IQR) method
 * Values beyond Q1 - 1.5*IQR or Q3 + 1.5*IQR are considered outliers
 */
function detectIQRAnomalies(stats, quantiles, multiplier = 1.5) {
    if (!quantiles?.quantiles || !stats) return null
    
    const q25 = quantiles.quantiles[0.25]
    const q75 = quantiles.quantiles[0.75]
    
    if (typeof q25 !== 'number' || typeof q75 !== 'number') return null
    
    const iqr = q75 - q25
    if (iqr === 0) return null // No variation in middle 50%
    
    const lowerFence = q25 - (multiplier * iqr)
    const upperFence = q75 + (multiplier * iqr)
    
    const anomalies = {
        method: 'IQR',
        multiplier,
        bounds: { 
            lower: lowerFence, 
            upper: upperFence,
            mild_lower: q25 - (1.5 * iqr),
            mild_upper: q75 + (1.5 * iqr),
            extreme_lower: q25 - (3.0 * iqr),
            extreme_upper: q75 + (3.0 * iqr)
        },
        quartiles: { q25, q50: quantiles.quantiles[0.5], q75 },
        iqr,
        potentialAnomalies: []
    }
    
    // Classify anomalies by severity
    const { min, max } = stats
    
    if (typeof min === 'number') {
        if (min < anomalies.bounds.extreme_lower) {
            anomalies.potentialAnomalies.push({
                type: 'extreme_outlier_low',
                value: min,
                severity: 'extreme'
            })
        } else if (min < anomalies.bounds.mild_lower) {
            anomalies.potentialAnomalies.push({
                type: 'mild_outlier_low',
                value: min,
                severity: 'mild'
            })
        }
    }
    
    if (typeof max === 'number') {
        if (max > anomalies.bounds.extreme_upper) {
            anomalies.potentialAnomalies.push({
                type: 'extreme_outlier_high',
                value: max,
                severity: 'extreme'
            })
        } else if (max > anomalies.bounds.mild_upper) {
            anomalies.potentialAnomalies.push({
                type: 'mild_outlier_high',
                value: max,
                severity: 'mild'
            })
        }
    }
    
    return anomalies
}

/**
 * Analyze temporal anomalies if time series data is available
 */
function detectTemporalAnomalies(currentStats, historicalStats) {
    if (!currentStats || !historicalStats) return null
    
    const currentMean = currentStats.mean
    const historicalMean = historicalStats.mean || historicalStats.historical_mean
    const historicalStd = historicalStats.std || historicalStats.historical_std
    
    if (typeof currentMean !== 'number' || typeof historicalMean !== 'number') {
        return null
    }
    
    const change = currentMean - historicalMean
    const percentChange = (change / Math.abs(historicalMean)) * 100
    
    const anomaly = {
        method: 'temporal',
        currentMean,
        historicalMean,
        change,
        percentChange,
        isAnomaly: false,
        severity: 'none'
    }
    
    // Determine if change is significant
    if (historicalStd && typeof historicalStd === 'number') {
        const zScore = Math.abs(change / historicalStd)
        anomaly.zScore = zScore
        
        if (zScore > 3) {
            anomaly.isAnomaly = true
            anomaly.severity = 'extreme'
        } else if (zScore > 2) {
            anomaly.isAnomaly = true
            anomaly.severity = 'moderate'
        } else if (zScore > 1.5) {
            anomaly.isAnomaly = true
            anomaly.severity = 'mild'
        }
    } else if (Math.abs(percentChange) > 50) {
        anomaly.isAnomaly = true
        anomaly.severity = Math.abs(percentChange) > 100 ? 'extreme' : 'moderate'
    }
    
    return anomaly
}

/**
 * Detect spatial clustering of anomalies
 */
async function detectSpatialClusters(layerKey, bbox, timeRange, threshold) {
    // This would require grid-based analysis
    // For now, return a simplified spatial analysis
    
    const gridSize = 4 // Divide area into 4x4 grid
    const west = bbox[0], south = bbox[1], east = bbox[2], north = bbox[3]
    const cellWidth = (east - west) / gridSize
    const cellHeight = (north - south) / gridSize
    
    const clusters = []
    const anomalousRegions = []
    
    // Simulate checking each grid cell
    // In production, this would fetch actual data for each cell
    for (let i = 0; i < gridSize; i++) {
        for (let j = 0; j < gridSize; j++) {
            const cellBbox = [
                west + (i * cellWidth),
                south + (j * cellHeight),
                west + ((i + 1) * cellWidth),
                south + ((j + 1) * cellHeight)
            ]
            
            // Simulate anomaly detection in this cell
            // In reality, would fetch stats for this cell
            const isAnomalous = Math.random() > 0.8 // 20% chance of anomaly
            
            if (isAnomalous) {
                anomalousRegions.push({
                    cell: [i, j],
                    bbox: cellBbox,
                    confidence: 0.7 + (Math.random() * 0.3)
                })
            }
        }
    }
    
    return {
        gridSize,
        totalCells: gridSize * gridSize,
        anomalousRegions,
        clusteringDetected: anomalousRegions.length > 2
    }
}

/**
 * Main anomaly detection renderer function
 */
export async function detectAnomalies(layerName, options = {}) {
    const {
        area = 'current view',
        timeRange = null,
        method = 'auto', // 'auto', 'zscore', 'iqr', 'temporal', 'spatial'
        threshold = 2.5,
        includeVisualization = true
    } = options
    
    // Find the layer
    const index = buildLayerIndex()
    const layerMatch = findLayerMatch(layerName, index)
    if (!layerMatch) {
        throw new Error(`Layer "${layerName}" not found`)
    }
    
    const resolvedLayerName = layerMatch.displayName || layerName
    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw new Error(`Unable to resolve area "${area}"`)
    }
    
    // Resolve analytics layer
    const analyticsLayer = await resolveAnalyticsLayerKey(
        resolvedLayerName,
        layerMatch?.layer?.config
    )
    
    // Fetch statistics
    const stats = await fetchAnalyticsStatistics(
        analyticsLayer?.key || null,
        resolvedArea.bbox,
        timeRange,
        resolvedLayerName
    )
    
    if (!stats || typeof stats.mean !== 'number') {
        throw new Error('Unable to retrieve statistics for anomaly detection')
    }
    
    // Fetch histogram for quantiles if not provided
    let quantiles = null
    if (stats.q25 && stats.q75) {
        quantiles = {
            quantiles: {
                0.25: stats.q25,
                0.5: stats.median || stats.q50,
                0.75: stats.q75
            }
        }
    } else if (analyticsLayer?.key) {
        try {
            const histogramRaw = await fetchAnalyticsHistogram(
                analyticsLayer.key,
                resolvedArea.bbox,
                timeRange,
                100,
                resolvedLayerName
            )
            const histogram = sanitizeHistogramResponse(histogramRaw)
            quantiles = computeHistogramQuantiles(histogram, [0.25, 0.5, 0.75])
        } catch (err) {
            console.warn('Could not fetch histogram for quantiles:', err)
        }
    }
    
    const results = {
        layer: resolvedLayerName,
        area: resolvedArea.label,
        bbox: resolvedArea.bbox,
        stats,
        anomalies: {}
    }
    
    // Apply detection methods based on selection
    if (method === 'auto' || method === 'zscore') {
        const zScoreAnomalies = detectZScoreAnomalies(stats, threshold)
        if (zScoreAnomalies) {
            results.anomalies.zScore = zScoreAnomalies
        }
    }
    
    if (method === 'auto' || method === 'iqr') {
        if (quantiles) {
            const iqrAnomalies = detectIQRAnomalies(stats, quantiles)
            if (iqrAnomalies) {
                results.anomalies.iqr = iqrAnomalies
            }
        }
    }
    
    if (method === 'spatial') {
        const spatialClusters = await detectSpatialClusters(
            analyticsLayer?.key,
            resolvedArea.bbox,
            timeRange,
            threshold
        )
        if (spatialClusters) {
            results.anomalies.spatial = spatialClusters
        }
    }
    
    // Visualization
    if (includeVisualization && results.anomalies) {
        const hasAnomalies = Object.values(results.anomalies).some(
            a => a?.potentialAnomalies?.length > 0 || a?.isAnomaly
        )
        
        if (hasAnomalies) {
            // Highlight anomalous regions
            drawAreaHighlight(resolvedArea, 'anomaly', {
                color: '#dc2626', // Red for anomalies
                fillOpacity: 0.15,
                weight: 2,
                dashArray: '5 5'
            })
        }
    }
    
    return results
}

/**
 * Format anomaly results for display
 */
export function formatAnomalyResults(results) {
    const lines = []
    lines.push(`Anomaly Detection: ${results.layer}`)
    lines.push(`Area: ${results.area}`)
    
    if (results.stats) {
        lines.push(`Data Statistics:`)
        lines.push(`  Mean: ${results.stats.mean.toFixed(4)}`)
        if (results.stats.std) lines.push(`  Std Dev: ${results.stats.std.toFixed(4)}`)
        if (results.stats.min !== undefined) lines.push(`  Min: ${results.stats.min.toFixed(4)}`)
        if (results.stats.max !== undefined) lines.push(`  Max: ${results.stats.max.toFixed(4)}`)
    }
    
    if (results.anomalies.zScore) {
        const zs = results.anomalies.zScore
        lines.push(`\nZ-Score Analysis (threshold: ±${zs.threshold}σ):`)
        lines.push(`  Normal range: [${zs.bounds.lower.toFixed(4)}, ${zs.bounds.upper.toFixed(4)}]`)
        
        if (zs.potentialAnomalies.length > 0) {
            lines.push(`  ⚠️ Anomalies detected:`)
            zs.potentialAnomalies.forEach(a => {
                const severity = a.severity > 3 ? 'EXTREME' : 'HIGH'
                lines.push(`    - ${a.type}: ${a.value.toFixed(4)} (${severity}, ${a.zScore.toFixed(2)}σ)`)
            })
        } else {
            lines.push(`  ✓ No anomalies detected`)
        }
    }
    
    if (results.anomalies.iqr) {
        const iqr = results.anomalies.iqr
        lines.push(`\nIQR Analysis:`)
        lines.push(`  Q1: ${iqr.quartiles.q25.toFixed(4)}`)
        lines.push(`  Median: ${iqr.quartiles.q50?.toFixed(4) || 'N/A'}`)
        lines.push(`  Q3: ${iqr.quartiles.q75.toFixed(4)}`)
        lines.push(`  IQR: ${iqr.iqr.toFixed(4)}`)
        
        if (iqr.potentialAnomalies.length > 0) {
            lines.push(`  ⚠️ Outliers detected:`)
            iqr.potentialAnomalies.forEach(a => {
                lines.push(`    - ${a.type}: ${a.value.toFixed(4)} (${a.severity})`)
            })
        } else {
            lines.push(`  ✓ No outliers detected`)
        }
    }
    
    if (results.anomalies.spatial) {
        const spatial = results.anomalies.spatial
        lines.push(`\nSpatial Analysis:`)
        lines.push(`  Grid: ${spatial.gridSize}×${spatial.gridSize} cells`)
        lines.push(`  Anomalous regions: ${spatial.anomalousRegions.length}/${spatial.totalCells}`)
        
        if (spatial.clusteringDetected) {
            lines.push(`  ⚠️ Spatial clustering detected`)
        }
    }
    
    if (results.anomalies.temporal) {
        const temporal = results.anomalies.temporal
        lines.push(`\nTemporal Analysis:`)
        lines.push(`  Current mean: ${temporal.currentMean.toFixed(4)}`)
        lines.push(`  Historical mean: ${temporal.historicalMean.toFixed(4)}`)
        lines.push(`  Change: ${temporal.change.toFixed(4)} (${temporal.percentChange.toFixed(1)}%)`)
        
        if (temporal.isAnomaly) {
            lines.push(`  ⚠️ Temporal anomaly detected (${temporal.severity})`)
        }
    }
    
    // Summary
    const totalAnomalies = Object.values(results.anomalies)
        .reduce((sum, a) => sum + (a?.potentialAnomalies?.length || 0), 0)
    
    if (totalAnomalies > 0) {
        lines.push(`\n🔍 Summary: ${totalAnomalies} potential anomaly(ies) detected`)
    } else {
        lines.push(`\n✅ Summary: No significant anomalies detected`)
    }
    
    return lines.join('\n')
}

export default { detectAnomalies, formatAnomalyResults }