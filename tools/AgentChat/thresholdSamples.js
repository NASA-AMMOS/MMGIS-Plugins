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
        case 'between': {
            const min = Number(compareValue?.min)
            const max = Number(compareValue?.max)
            return (
                Number.isFinite(min) &&
                Number.isFinite(max) &&
                value >= min &&
                value <= max
            )
        }
        default:
            return false
    }
}

export function collectThresholdMatches(
    samples,
    operator,
    compareValue,
    maxPoints = 2000
) {
    const matches = []
    let matchCount = 0
    for (const sample of samples || []) {
        if (!passesThreshold(sample?.value, operator, compareValue)) continue
        matchCount += 1
        if (matches.length >= maxPoints) continue
        if (!Number.isFinite(sample?.lon) || !Number.isFinite(sample?.lat))
            continue
        matches.push({
            lon: sample.lon,
            lat: sample.lat,
            value: sample.value,
        })
    }
    return { matches, matchCount }
}
