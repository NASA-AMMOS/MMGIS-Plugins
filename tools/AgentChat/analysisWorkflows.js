import { appendQueryParameters } from './agentEndpoints'

export function buildRelativeMeanThresholdAction(
    layerName,
    mean,
    direction = 'above',
    payload = {}
) {
    const numericMean = Number(mean)
    if (!Number.isFinite(numericMean)) return null
    const normalizedDirection = String(direction || 'above')
        .trim()
        .toLowerCase()
    const below = normalizedDirection === 'below'
    return {
        ...payload,
        layer_name: layerName,
        variable: payload.variable || layerName,
        operator: below ? '<' : '>',
        value: numericMean,
        unit: null,
    }
}

export function buildDifferenceRequestUrl({
    baseUrl = '',
    origin = '',
    rootPath = '',
    layerA,
    layerB,
    time = '',
    mission = '',
    bbox,
} = {}) {
    if (!layerA || !layerB)
        throw new Error('Both comparison layers are required.')
    if (
        !Array.isArray(bbox) ||
        bbox.length !== 4 ||
        !bbox.every((value) => Number.isFinite(Number(value)))
    ) {
        throw new Error('A valid comparison bounding box is required.')
    }
    const base =
        String(baseUrl || '').trim() ||
        `${String(origin || '').replace(/\/$/, '')}${String(
            rootPath || ''
        ).replace(/\/$/, '')}/api/agent/analytics/difference`
    const params = new URLSearchParams({
        layer_a: String(layerA),
        layer_b: String(layerB),
        lon_min: String(Number(bbox[0])),
        lat_min: String(Number(bbox[1])),
        lon_max: String(Number(bbox[2])),
        lat_max: String(Number(bbox[3])),
    })
    if (time) params.set('time', String(time))
    if (mission) params.set('mission', String(mission))
    return appendQueryParameters(base, params, origin)
}

function formatMetric(value, digits, unit) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 'unavailable'
    return `${numeric.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

export function formatDifferenceStatistics(
    data,
    { layerA, layerB, unit = '' } = {}
) {
    const nameA = layerA || 'Layer A'
    const nameB = layerB || 'Layer B'
    const lines = [
        `**Difference: ${nameA} - ${nameB}**`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ]
    if (data?.mean_a != null)
        lines.push(`**${nameA}** mean: ${formatMetric(data.mean_a, 4, unit)}`)
    if (data?.mean_b != null)
        lines.push(`**${nameB}** mean: ${formatMetric(data.mean_b, 4, unit)}`)
    lines.push('', '**Difference Statistics:**')
    lines.push(`Mean: ${formatMetric(data?.mean, 4, unit)}`)
    lines.push(`Std Dev: ${formatMetric(data?.std, 4, unit)}`)
    lines.push(
        `Min: ${formatMetric(data?.min, 4, unit)}, Max: ${formatMetric(
            data?.max,
            4,
            unit
        )}`
    )
    lines.push(`Median: ${formatMetric(data?.median, 4, unit)}`)
    lines.push(`25th percentile: ${formatMetric(data?.q25, 4, unit)}`)
    lines.push(`75th percentile: ${formatMetric(data?.q75, 4, unit)}`)
    if (data?.valid_count != null || data?.total_count != null) {
        const valid = Number(data.valid_count)
        const total = Number(data.total_count)
        lines.push(
            '',
            `Valid pixels: ${
                Number.isFinite(valid) ? valid.toLocaleString() : 'unavailable'
            } / ${
                Number.isFinite(total) ? total.toLocaleString() : 'unavailable'
            }`
        )
    }

    const mean = Number(data?.mean)
    if (Number.isFinite(mean)) {
        lines.push('')
        const magnitude = formatMetric(Math.abs(mean), 4, unit)
        if (mean > 0)
            lines.push(`${nameA} is ${magnitude} higher than ${nameB} on average.`)
        else if (mean < 0)
            lines.push(`${nameB} is ${magnitude} higher than ${nameA} on average.`)
        else lines.push(`${nameA} and ${nameB} have the same mean value.`)
    }
    return lines.join('\n')
}
