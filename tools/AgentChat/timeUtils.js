const MONTH_LOOKUP = {
    january: 0,
    jan: 0,
    february: 1,
    feb: 1,
    march: 2,
    mar: 2,
    april: 3,
    apr: 3,
    may: 4,
    june: 5,
    jun: 5,
    july: 6,
    jul: 6,
    august: 7,
    aug: 7,
    september: 8,
    sept: 8,
    sep: 8,
    october: 9,
    oct: 9,
    november: 10,
    nov: 10,
    december: 11,
    dec: 11,
}

const UNIQUE_MONTH_KEYS = [
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
]

const PRECISION_ORDER = {
    year: 0,
    month: 1,
    day: 2,
    hour: 3,
    minute: 4,
    second: 5,
}

function levenshtein(a, b) {
    const m = a.length
    const n = b.length
    if (m === 0) return n
    if (n === 0) return m
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
    for (let i = 0; i <= m; i += 1) dp[i][0] = i
    for (let j = 0; j <= n; j += 1) dp[0][j] = j
    for (let i = 1; i <= m; i += 1) {
        for (let j = 1; j <= n; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            )
        }
    }
    return dp[m][n]
}

function scoreSimilarity(query, candidate) {
    if (!query || !candidate) return 0
    if (query === candidate) return 1
    if (candidate.includes(query))
        return Math.max(0.8, query.length / Math.max(candidate.length, 1))
    if (query.includes(candidate))
        return Math.max(0.7, candidate.length / Math.max(query.length, 1))
    const dist = levenshtein(query, candidate)
    const maxLen = Math.max(query.length, candidate.length, 1)
    return Math.max(0, 1 - dist / maxLen)
}

function toIsoString(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
    return date.toISOString().split('.')[0] + 'Z'
}

function fuzzyMatchMonth(token) {
    let bestKey = null
    let bestScore = 0
    // Restrict candidates to the same leading character. Typos (transpositions,
    // dropped/swapped letters) almost always preserve the first letter, and
    // this prevents cross-month confusion between otherwise-similar-looking
    // names (e.g. "september" vs "december" score ~0.67 on edit distance
    // alone, well above what a real single-word typo like "jnaury" needs).
    UNIQUE_MONTH_KEYS.forEach((canonical) => {
        if (!token || canonical[0] !== token[0]) return
        const score = scoreSimilarity(token, canonical)
        if (score > bestScore) {
            bestScore = score
            bestKey = canonical
        }
    })
    return { bestKey, score: bestScore }
}

function parseMonthWord(value) {
    if (typeof value !== 'string') return null
    const key = value
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .trim()
    if (!key) return null
    if (MONTH_LOOKUP.hasOwnProperty(key)) return MONTH_LOOKUP[key]
    const { bestKey, score } = fuzzyMatchMonth(key)
    // 0.55 sits between the worst same-letter false positive among real month
    // names (june/july ~0.5) and a single-word typo like "jnaury"->"january"
    // (~0.571), combined with the leading-letter restriction in fuzzyMatchMonth.
    if (bestKey && score >= 0.55 && MONTH_LOOKUP.hasOwnProperty(bestKey))
        return MONTH_LOOKUP[bestKey]
    return null
}

function extractTimeParts(str) {
    const trimmed = str.trim()
    let match = trimmed.match(/^(\d{4})$/)
    if (match) {
        return {
            precision: 'year',
            parts: {
                year: Number(match[1]),
                month: 0,
                day: 1,
                hour: 0,
                minute: 0,
                second: 0,
            },
        }
    }
    match = trimmed.match(/^(\d{4})[-/](\d{1,2})$/)
    if (match) {
        return {
            precision: 'month',
            parts: {
                year: Number(match[1]),
                month: Number(match[2]) - 1,
                day: 1,
                hour: 0,
                minute: 0,
                second: 0,
            },
        }
    }
    match = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
    if (match) {
        return {
            precision: 'day',
            parts: {
                year: Number(match[1]),
                month: Number(match[2]) - 1,
                day: Number(match[3]),
                hour: 0,
                minute: 0,
                second: 0,
            },
        }
    }
    match = trimmed.match(/^([a-zA-Z]+)\s+(\d{4})$/)
    if (match) {
        const monthIdx = parseMonthWord(match[1])
        if (monthIdx != null)
            return {
                precision: 'month',
                parts: {
                    year: Number(match[2]),
                    month: monthIdx,
                    day: 1,
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            }
    }
    match = trimmed.match(/^(\d{4})\s+([a-zA-Z]+)$/)
    if (match) {
        const monthIdx = parseMonthWord(match[2])
        if (monthIdx != null)
            return {
                precision: 'month',
                parts: {
                    year: Number(match[1]),
                    month: monthIdx,
                    day: 1,
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            }
    }
    match = trimmed.match(
        /^([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})$/
    )
    if (match) {
        const monthIdx = parseMonthWord(match[1])
        if (monthIdx != null)
            return {
                precision: 'day',
                parts: {
                    year: Number(match[3]),
                    month: monthIdx,
                    day: Number(match[2]),
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            }
    }
    match = trimmed.match(
        /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]+)\s+(\d{4})$/
    )
    if (match) {
        const monthIdx = parseMonthWord(match[2])
        if (monthIdx != null)
            return {
                precision: 'day',
                parts: {
                    year: Number(match[3]),
                    month: monthIdx,
                    day: Number(match[1]),
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            }
    }
    match = trimmed.match(
        /^(\d{4})\s+([a-zA-Z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/
    )
    if (match) {
        const monthIdx = parseMonthWord(match[2])
        if (monthIdx != null)
            return {
                precision: 'day',
                parts: {
                    year: Number(match[1]),
                    month: monthIdx,
                    day: Number(match[3]),
                    hour: 0,
                    minute: 0,
                    second: 0,
                },
            }
    }
    // M/D/YYYY or MM/DD/YYYY (US date format)
    match = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)
    if (match) {
        return {
            precision: 'day',
            parts: {
                year: Number(match[3]),
                month: Number(match[1]) - 1,
                day: Number(match[2]),
                hour: 0,
                minute: 0,
                second: 0,
            },
        }
    }
    match = trimmed.match(
        /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/
    )
    if (match) {
        const hasTime = match[4] != null
        return {
            precision: hasTime ? 'second' : 'day',
            parts: {
                year: Number(match[1]),
                month: Number(match[2]) - 1,
                day: Number(match[3]),
                hour: hasTime ? Number(match[4]) : 0,
                minute: hasTime ? Number(match[5]) : 0,
                second: hasTime ? Number(match[6]) : 0,
            },
        }
    }
    return null
}

export function parseTimeQuery(rawInput) {
    if (rawInput == null) return null
    const text = String(rawInput).trim()
    if (!text) return null
    const direct = extractTimeParts(text)
    if (direct) {
        return finalizeDetectedTime(direct, text)
    }
    const snippet = extractDateSnippet(text)
    if (!snippet) return null
    const detected = extractTimeParts(snippet)
    if (detected) {
        return finalizeDetectedTime(detected, text)
    }
    const parsed = new Date(snippet)
    if (Number.isNaN(parsed.getTime())) return null
    let precision = 'day'
    if (/[T\s]\d{2}:\d{2}:\d{2}/.test(snippet)) precision = 'second'
    else if (/[T\s]\d{2}:\d{2}/.test(snippet)) precision = 'minute'
    // (?!\d) guards against matching just the leading two digits of a bare
    // 4-digit year (e.g. " 2023"), which isn't a time-of-day component at all.
    else if (/[T\s]\d{2}(?!\d)/.test(snippet)) precision = 'hour'
    else if (/^\d{4}-\d{2}$/.test(snippet)) precision = 'month'
    else if (/^\d{4}$/.test(snippet)) precision = 'year'
    const normalized = new Date(
        Date.UTC(
            parsed.getUTCFullYear(),
            parsed.getUTCMonth(),
            parsed.getUTCDate(),
            parsed.getUTCHours(),
            parsed.getUTCMinutes(),
            parsed.getUTCSeconds()
        )
    )
    return {
        original: text,
        date: normalized,
        iso: toIsoString(normalized),
        precision,
    }
}

function finalizeDetectedTime(detected, original) {
    const parts = detected.parts
    const date = new Date(
        Date.UTC(
            parts.year,
            parts.month,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second
        )
    )
    if (Number.isNaN(date.getTime())) return null
    return {
        original,
        date,
        iso: toIsoString(date),
        precision: detected.precision,
    }
}

function extractDateSnippet(text) {
    const candidates = []
    const iso = text.match(
        /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:Z)?)?/
    )
    if (iso && iso[0]) candidates.push(iso[0])
    const yearMonthDash = text.match(/\d{4}-\d{2}(?!\d)/)
    if (yearMonthDash && yearMonthDash[0]) candidates.push(yearMonthDash[0])
    // "2024 March 15th" (year-month-day, year first) — checked ahead of the
    // shorter word+year / year+word patterns below so the more complete
    // match wins when both are present in the text.
    const yearMonthDayWord = text.match(
        /\d{4}\s+[a-zA-Z\.]+\s+\d{1,2}(?:st|nd|rd|th)?\b/
    )
    if (yearMonthDayWord && yearMonthDayWord[0]) candidates.push(yearMonthDayWord[0])
    const monthYear = text.match(
        /([a-zA-Z\.]+)\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4}/
    )
    if (monthYear && monthYear[0]) candidates.push(monthYear[0])
    const monthOnly = text.match(/([a-zA-Z\.]+)\s+\d{4}/)
    if (monthOnly && monthOnly[0]) candidates.push(monthOnly[0])
    const yearMonthWord = text.match(/\d{4}\s+([a-zA-Z\.]+)/)
    if (yearMonthWord && yearMonthWord[0]) candidates.push(yearMonthWord[0])
    // M/D/YYYY or MM/DD/YYYY (US date format)
    const usDate = text.match(/\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/)
    if (usDate && usDate[1]) candidates.push(usDate[1])
    const bareYear = text.match(/\b\d{4}\b/)
    if (bareYear && bareYear[0]) candidates.push(bareYear[0])
    if (candidates.length) return candidates[0].replace(/[,]/g, '').trim()
    return text
}

function toMs(value) {
    if (value == null) return NaN
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.length) {
        const parsed = Date.parse(value)
        if (!Number.isNaN(parsed)) return parsed
        const compact = value.match(/^(\d{4})(\d{2})(\d{2})?$/)
        if (compact) {
            const year = Number(compact[1])
            const month = Number(compact[2])
            const day = compact[3] ? Number(compact[3]) : 1
            if (
                Number.isFinite(year) &&
                Number.isFinite(month) &&
                month >= 1 &&
                month <= 12
            ) {
                return Date.UTC(year, month - 1, day)
            }
        }
    }
    return NaN
}

function computeBounds(timeConfig) {
    if (!timeConfig) return { min: null, max: null, minIso: null, maxIso: null }
    const candidatesMin = [
        timeConfig.availableStart,
        timeConfig.minAvailable,
        timeConfig.min,
        timeConfig.minTime,
        timeConfig.minTimestamp,
    ]
    const candidatesMax = [
        timeConfig.availableEnd,
        timeConfig.maxAvailable,
        timeConfig.max,
        timeConfig.maxTime,
        timeConfig.maxTimestamp,
    ]
    let min = null
    for (const c of candidatesMin) {
        const ms = toMs(c)
        if (Number.isFinite(ms)) {
            min = ms
            break
        }
    }
    let max = null
    for (const c of candidatesMax) {
        const ms = toMs(c)
        if (Number.isFinite(ms)) {
            max = ms
            break
        }
    }
    if (min != null && max != null && min > max) {
        const tmp = min
        min = max
        max = tmp
    }
    return {
        min,
        max,
        minIso: Number.isFinite(min) ? toIsoString(new Date(min)) : null,
        maxIso: Number.isFinite(max) ? toIsoString(new Date(max)) : null,
    }
}

function normalizeTimestamp(value) {
    const ms = toMs(value)
    if (!Number.isFinite(ms)) return null
    return toIsoString(new Date(ms))
}

export function detectCadence(format) {
    if (typeof format !== 'string' || !format.length) return 'day'
    if (/%S/.test(format)) return 'second'
    if (/%M/.test(format)) return 'minute'
    if (/%H|%I/.test(format)) return 'hour'
    if (/%d|%e/.test(format)) return 'day'
    if (/%m|%b|%B/.test(format)) return 'month'
    if (/%Y/.test(format)) return 'year'
    return 'day'
}

export function describeCadence(cadence) {
    switch (cadence) {
        case 'second':
            return 'per-second'
        case 'minute':
            return 'per-minute'
        case 'hour':
            return 'hourly'
        case 'day':
            return 'daily'
        case 'month':
            return 'monthly'
        case 'year':
            return 'yearly'
        default:
            return 'time-enabled'
    }
}

export function getLayerTimeMetadata(layerConfig) {
    const time = layerConfig?.time
    
    // If no time config or not enabled, provide default time metadata for certain layer types
    if (!time || time.enabled !== true) {
        // Check if this might be a time-capable layer based on its properties
        const layerName = (layerConfig?.name || '').toLowerCase()
        const layerType = layerConfig?.type || ''
        
        // For WMS/WMTS/GIBS layers, provide default time support
        if (layerType === 'wms' || layerType === 'wmts' || 
            layerName.includes('gibs') || layerName.includes('gfs') || 
            layerName.includes('modis')) {
            // Provide reasonable defaults for time-capable services
            const now = new Date()
            const yearAgo = new Date(now)
            yearAgo.setFullYear(yearAgo.getFullYear() - 1)
            
            return {
                enabled: true,
                format: '%Y-%m-%dT%H:%M:%SZ',
                cadence: 'day',
                type: layerType || 'dynamic',
                availableStart: toIsoString(yearAgo),
                availableEnd: toIsoString(now),
                bounds: {
                    min: yearAgo.getTime(),
                    max: now.getTime(),
                    minIso: toIsoString(yearAgo),
                    maxIso: toIsoString(now)
                },
                currentStart: toIsoString(now),
                currentEnd: toIsoString(now),
                isDefault: true // Flag to indicate this is a default configuration
            }
        }
        return { enabled: false }
    }
    
    const format =
        typeof time.format === 'string' && time.format.trim().length
            ? time.format.trim()
            : '%Y-%m-%dT%H:%M:%SZ'
    const cadence = detectCadence(format)
    const bounds = computeBounds(time)
    return {
        enabled: true,
        format,
        cadence,
        type: time.type || null,
        availableStart: bounds.minIso,
        availableEnd: bounds.maxIso,
        bounds,
        currentStart: normalizeTimestamp(time.start),
        currentEnd: normalizeTimestamp(time.end),
    }
}

export function formatLayerTimeAnnouncement(displayName, meta) {
    if (!meta || meta.enabled !== true)
        return `${displayName}: not a time-enabled layer.`
    const cadenceLabel = describeCadence(meta.cadence)
    const cadenceText = cadenceLabel
        ? cadenceLabel.charAt(0).toUpperCase() + cadenceLabel.slice(1)
        : 'Time-enabled'
    const rangeText =
        meta.availableStart || meta.availableEnd
            ? `${meta.availableStart || 'unknown start'} – ${
                  meta.availableEnd || 'unknown end'
              }`
            : 'unknown range'
    const current =
        meta.currentEnd ||
        meta.currentStart ||
        meta.availableStart ||
        meta.availableEnd ||
        'no active timestamp'
    return `${displayName}: ${cadenceText} layer available ${rangeText}. Displaying data for ${current}.`
}

function snapToCadence(date, cadence) {
    const snapped = new Date(date.getTime())
    if (cadence === 'year') {
        snapped.setUTCMonth(0, 1)
        snapped.setUTCHours(0, 0, 0, 0)
    } else if (cadence === 'month') {
        snapped.setUTCDate(1)
        snapped.setUTCHours(0, 0, 0, 0)
    } else if (cadence === 'day') {
        snapped.setUTCHours(0, 0, 0, 0)
    } else if (cadence === 'hour') {
        snapped.setUTCMinutes(0, 0, 0)
    } else if (cadence === 'minute') {
        snapped.setUTCSeconds(0, 0)
    } else if (cadence === 'second') {
        snapped.setUTCMilliseconds(0)
    }
    return snapped
}

function clampDate(date, bounds) {
    const ms = date.getTime()
    if (Number.isFinite(bounds.min) && ms < bounds.min) {
        return { date: new Date(bounds.min), direction: 'before' }
    }
    if (Number.isFinite(bounds.max) && ms > bounds.max) {
        return { date: new Date(bounds.max), direction: 'after' }
    }
    return { date, direction: null }
}

export function computeLayerTargetTime(meta, request) {
    if (!meta?.enabled) {
        return { ok: false, reason: 'not_time_enabled' }
    }
    const notes = []
    const cadenceOrder = PRECISION_ORDER[meta.cadence] ?? PRECISION_ORDER.day
    const requestOrder = request?.special
        ? PRECISION_ORDER.day
        : PRECISION_ORDER[request?.precision] ?? PRECISION_ORDER.day
    let target = null
    if (request?.special === 'latest') {
        if (!Number.isFinite(meta.bounds?.max)) {
            // If no max bound, try to use current time as fallback for "latest"
            const now = new Date()
            target = now
            notes.push('Layer has no defined time range. Using current date.')
        } else {
            target = new Date(meta.bounds.max)
            notes.push('Showing the latest available timestamp.')
        }
    } else if (request?.special === 'earliest') {
        if (!Number.isFinite(meta.bounds?.min)) {
            // If no min bound, use a reasonable past date
            const pastDate = new Date()
            pastDate.setFullYear(pastDate.getFullYear() - 1)
            target = pastDate
            notes.push('Layer has no defined time range. Using one year ago.')
        } else {
            target = new Date(meta.bounds.min)
            notes.push('Showing the earliest available timestamp.')
        }
    } else if (request?.date instanceof Date) {
        target = new Date(request.date.getTime())
    } else {
        return { ok: false, reason: 'invalid_request' }
    }

    if (!request?.special && requestOrder < cadenceOrder) {
        // Request is broader (e.g., month for daily data)
        const cadenceLabel = describeCadence(meta.cadence)
        if (request.precision === 'month' && cadenceOrder >= PRECISION_ORDER.day)
            notes.push(
                `${cadenceLabel} data; showing the first day of ${
                    target.toISOString().split('T')[0].slice(0, 7)
                }.`
            )
        else if (request.precision === 'year' && cadenceOrder >= PRECISION_ORDER.day)
            notes.push(
                `${cadenceLabel} data; defaulting to the start of ${target.getUTCFullYear()}.`
        )
    } else if (!request?.special && requestOrder > cadenceOrder) {
        // Request more precise than dataset
        notes.push(
            `Requested time is finer than this ${describeCadence(
                meta.cadence
            )} layer; using the closest available timestep.`
        )
    }
    target = snapToCadence(target, meta.cadence)
    const clamped = clampDate(target, meta.bounds || {})
    const iso = toIsoString(clamped.date)
    return {
        ok: !!iso,
        iso,
        date: clamped.date,
        cadence: meta.cadence,
        availableStart: meta.availableStart,
        availableEnd: meta.availableEnd,
        notes,
        outOfRange: clamped.direction,
    }
}

/**
 * Given a date and a precision level, return the ISO string for the end of
 * that precision period.
 * e.g. precision 'month' for 2024-01-01 → 2024-01-31T23:59:59Z
 *      precision 'day'   for 2024-01-15 → 2024-01-15T23:59:59Z
 *      precision 'year'  for 2024-01-01 → 2024-12-31T23:59:59Z
 */
export function computePrecisionEndIso(date, precision) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
    let end
    switch (precision) {
        case 'year':
            end = new Date(Date.UTC(date.getUTCFullYear(), 11, 31, 23, 59, 59))
            break
        case 'month': {
            // Day 0 of next month = last day of current month
            const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
            end = new Date(Date.UTC(
                date.getUTCFullYear(), date.getUTCMonth(),
                lastDay.getUTCDate(), 23, 59, 59
            ))
            break
        }
        case 'day':
            end = new Date(Date.UTC(
                date.getUTCFullYear(), date.getUTCMonth(),
                date.getUTCDate(), 23, 59, 59
            ))
            break
        default:
            // For hour/minute/second precision, return the same date
            return toIsoString(date)
    }
    return toIsoString(end)
}

export { toIsoString as formatIsoTimestamp }
