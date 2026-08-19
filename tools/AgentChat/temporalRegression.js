/**
 * Ordinary least-squares trend over real UTC elapsed days. The returned
 * strength is a descriptive fit heuristic, not statistical significance.
 */
export function computeLinearTrend(trendData) {
    const observations = (Array.isArray(trendData) ? trendData : [])
        .map((point) => ({
            timestamp: Date.parse(point?.time),
            mean: Number(point?.mean),
        }))
        .filter(
            (entry) =>
                Number.isFinite(entry.timestamp) && Number.isFinite(entry.mean)
        )
        .sort((a, b) => a.timestamp - b.timestamp)
    if (!observations.length) {
        return {
            direction: 'unknown',
            magnitude: 0,
            percentChange: 0,
            trendStrength: 'unknown',
        }
    }
    if (observations.length === 1) {
        return {
            direction: 'stable',
            magnitude: 0,
            percentChange: 0,
            trendStrength: 'insufficient data',
            slope: 0,
            slopeUnit: 'value per day',
            rSquared: 0,
        }
    }

    const n = observations.length
    const firstTimestamp = observations[0].timestamp
    const elapsedDays = observations.map(
        (entry) => (entry.timestamp - firstTimestamp) / 86400000
    )
    let sumX = 0
    let sumY = 0
    let sumXY = 0
    let sumX2 = 0
    for (let index = 0; index < n; index += 1) {
        const x = elapsedDays[index]
        const y = observations[index].mean
        sumX += x
        sumY += y
        sumXY += x * y
        sumX2 += x * x
    }
    const meanX = sumX / n
    const meanY = sumY / n
    const denominator = sumX2 - n * meanX * meanX
    const slope =
        denominator !== 0
            ? (sumXY - n * meanX * meanY) / denominator
            : 0
    const intercept = meanY - slope * meanX
    const ssRes = observations.reduce((sum, entry, index) => {
        const predicted = intercept + slope * elapsedDays[index]
        return sum + (entry.mean - predicted) ** 2
    }, 0)
    const ssTot = observations.reduce(
        (sum, entry) => sum + (entry.mean - meanY) ** 2,
        0
    )
    const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0
    const firstPredicted = intercept
    const lastPredicted = intercept + slope * elapsedDays[n - 1]
    const magnitude = Math.abs(lastPredicted - firstPredicted)
    const percentChange =
        firstPredicted !== 0
            ? ((lastPredicted - firstPredicted) /
                  Math.abs(firstPredicted)) *
              100
            : 0
    const trendStrength =
        n < 4
            ? 'insufficient data'
            : rSquared > 0.7 && Math.abs(percentChange) > 5
              ? 'strong'
              : rSquared > 0.3 && Math.abs(percentChange) > 2
                ? 'moderate'
                : 'weak'
    return {
        direction:
            slope > 0.0001
                ? 'increasing'
                : slope < -0.0001
                  ? 'decreasing'
                  : 'stable',
        magnitude,
        percentChange,
        trendStrength,
        slope,
        slopeUnit: 'value per day',
        rSquared,
    }
}
