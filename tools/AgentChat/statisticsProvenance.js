function finiteCount(value) {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number : null
}

function formatCount(value) {
    return finiteCount(value)?.toLocaleString() || null
}

export function isStatisticsSampled(stats = {}) {
    const method = String(stats?.method || '').toLowerCase()
    const coverage = stats?.population_coverage
    return (
        stats?.is_sampled === true ||
        stats?.mean_is_approximate === true ||
        stats?.quantiles_approximate === true ||
        /sample|resampl|approx/.test(method) ||
        (Number.isFinite(Number(coverage)) && Number(coverage) < 1) ||
        (typeof coverage === 'string' &&
            !/^(full|complete|exhaustive|all)$/i.test(coverage.trim()))
    )
}

export function describeStatisticsProvenance(stats = {}) {
    const sampled = isStatisticsSampled(stats)
    const validCount =
        formatCount(stats.valid_count) || formatCount(stats.count)
    const sampledReadCount = formatCount(stats.sample_count)
    const observationCount = validCount || sampledReadCount
    const populationCount =
        formatCount(stats.population_count) ||
        formatCount(stats.source_population_count)
    const method = String(stats.method || '').trim()
    const lines = []
    if (sampled) {
        lines.push(
            `These statistics are approximate and were computed from ${
                observationCount || 'a bounded set of'
            } valid sampled raster cells${
                validCount &&
                sampledReadCount &&
                validCount !== sampledReadCount
                    ? ` within ${sampledReadCount} cells read from the bounded raster window`
                    : ''
            }${
                populationCount
                    ? ` representing an estimated ${populationCount} source cells`
                    : ''
            }.`
        )
    } else if (
        stats.population_coverage === 1 ||
        /^(full|complete|exhaustive|all)$/i.test(
            String(stats.population_coverage || '')
        )
    ) {
        lines.push(
            `The analytics provider reports complete population coverage${
                observationCount ? ` (${observationCount} valid cells)` : ''
            }.`
        )
    } else {
        lines.push(
            `The analytics provider returned descriptive statistics${
                observationCount
                    ? ` for ${observationCount} valid observations`
                    : ''
            }; it did not report exhaustive population coverage.`
        )
    }
    if (method) lines.push(`Provider method: ${method}.`)
    if (stats.quantiles_approximate === true) {
        lines.push('Reported quantiles are approximate.')
    }
    return lines
}
