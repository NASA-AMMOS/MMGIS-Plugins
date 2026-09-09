function normalizeText(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

export function normalizeThresholdOperator(operator) {
    const value = String(operator || '').trim()
    if (value === '=') return '=='
    return ['>', '>=', '<', '<=', '==', 'between'].includes(value)
        ? value
        : null
}

export function buildThresholdExpression({
    operator,
    value,
    valueMin,
    valueMax,
    band = 'b1',
    valueExpression = null,
} = {}) {
    const normalized = normalizeThresholdOperator(operator)
    if (!normalized) {
        return {
            ok: false,
            errorCode: 'UNSUPPORTED_THRESHOLD_OPERATOR',
            message: `Unsupported threshold operator "${operator}". Use >, >=, <, <=, =, ==, or between.`,
        }
    }
    if (!/^b[1-9]\d*$/.test(band)) {
        return {
            ok: false,
            errorCode: 'INVALID_RASTER_BAND',
            message: `Raster band "${band}" is invalid.`,
        }
    }
    const rasterValue =
        typeof valueExpression === 'string' && valueExpression.trim()
            ? valueExpression.trim()
            : band
    const referencedBands = Array.from(
        rasterValue.matchAll(/(?<![A-Za-z0-9_])b([1-9]\d*)/gi),
        (match) => `b${Number(match[1])}`
    )
    if (
        !/^[\dbeE+\-*/().\s]+$/.test(rasterValue) ||
        !referencedBands.length ||
        referencedBands.some((referenced) => referenced !== band)
    ) {
        return {
            ok: false,
            errorCode: 'UNSUPPORTED_RASTER_VALUE_EXPRESSION',
            message:
                'The configured raster value expression cannot be used safely for threshold highlighting.',
        }
    }
    const comparedValue = rasterValue
    if (normalized === 'between') {
        const lower = Number(valueMin)
        const upper = Number(valueMax)
        if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
            return {
                ok: false,
                errorCode: 'INVALID_THRESHOLD_BOUNDS',
                message:
                    'A between threshold requires numeric value_min and value_max bounds.',
            }
        }
        if (lower > upper) {
            return {
                ok: false,
                errorCode: 'INVALID_THRESHOLD_BOUNDS',
                message:
                    'Threshold value_min cannot be greater than value_max.',
            }
        }
        return {
            ok: true,
            operator: normalized,
            expression: `((${comparedValue}>=${lower})&(${comparedValue}<=${upper}))*1`,
            lower,
            upper,
        }
    }
    const threshold = Number(value)
    if (!Number.isFinite(threshold)) {
        return {
            ok: false,
            errorCode: 'INVALID_THRESHOLD',
            message: 'A numeric threshold value is required.',
        }
    }
    return {
        ok: true,
        operator: normalized,
        expression: `(${comparedValue}${normalized}${threshold})*1`,
        value: threshold,
    }
}

function declaredVariables(config) {
    const output = []
    const variables = config?.variables
    if (Array.isArray(variables)) {
        variables.forEach((item, index) => {
            if (typeof item === 'string')
                output.push({ name: item, band: index + 1 })
            else if (item && typeof item === 'object')
                output.push({
                    name: item.name || item.id || item.variable,
                    band:
                        item.band || item.bandIndex || item.index || index + 1,
                    unit: item.unit || item.units || null,
                })
        })
    } else if (variables && typeof variables === 'object') {
        Object.entries(variables).forEach(([name, item], index) => {
            const details = item && typeof item === 'object' ? item : {}
            output.push({
                name,
                band:
                    details.band ||
                    details.bandIndex ||
                    details.index ||
                    index + 1,
                unit: details.unit || details.units || null,
            })
        })
    }
    const names = config?.cogBandNames || config?.bandNames
    if (Array.isArray(names)) {
        names.forEach((name, index) => output.push({ name, band: index + 1 }))
    }
    return output
}

export function resolveThresholdUnit(config = {}, variable, band = null) {
    const requested = normalizeText(variable)
    const bandNumber = Number(String(band || '').replace(/^b/i, ''))
    const candidate = declaredVariables(config).find((item) => {
        if (requested && normalizeText(item.name) === requested) return true
        return Number.isInteger(bandNumber) && Number(item.band) === bandNumber
    })
    const declared =
        candidate?.unit ||
        config.cogUnits ||
        config.units ||
        config.unit ||
        config.metadata?.units ||
        config.analysis?.units ||
        config.variables?.shader?.units ||
        null
    return typeof declared === 'string' && declared.trim()
        ? declared.trim()
        : null
}

function unitDescriptor(raw) {
    const label = typeof raw === 'string' ? raw.trim() : ''
    const key = label.toLowerCase().replace(/\s+/g, ' ')
    const aliases = {
        m: { canonical: 'm', kind: 'length', factor: 1 },
        meter: { canonical: 'm', kind: 'length', factor: 1 },
        meters: { canonical: 'm', kind: 'length', factor: 1 },
        metre: { canonical: 'm', kind: 'length', factor: 1 },
        metres: { canonical: 'm', kind: 'length', factor: 1 },
        cm: { canonical: 'cm', kind: 'length', factor: 0.01 },
        centimeter: { canonical: 'cm', kind: 'length', factor: 0.01 },
        centimeters: { canonical: 'cm', kind: 'length', factor: 0.01 },
        centimetre: { canonical: 'cm', kind: 'length', factor: 0.01 },
        centimetres: { canonical: 'cm', kind: 'length', factor: 0.01 },
        mm: { canonical: 'mm', kind: 'length', factor: 0.001 },
        millimeter: { canonical: 'mm', kind: 'length', factor: 0.001 },
        millimeters: { canonical: 'mm', kind: 'length', factor: 0.001 },
        millimetre: { canonical: 'mm', kind: 'length', factor: 0.001 },
        millimetres: { canonical: 'mm', kind: 'length', factor: 0.001 },
        '%': { canonical: '%', kind: 'percent', factor: 1 },
        percent: { canonical: '%', kind: 'percent', factor: 1 },
        percentage: { canonical: '%', kind: 'percent', factor: 1 },
    }
    return label
        ? aliases[key] || {
              canonical: key,
              kind: `declared:${key}`,
              factor: 1,
          }
        : null
}

export function convertThresholdValuesToLayerUnit({
    operator,
    value,
    valueMin,
    valueMax,
    inputUnit,
    declaredUnit,
} = {}) {
    const input = unitDescriptor(inputUnit)
    const target = unitDescriptor(declaredUnit)
    if (input && !target) {
        return {
            ok: false,
            errorCode: 'THRESHOLD_UNIT_METADATA_REQUIRED',
            message: `Cannot apply an explicit ${inputUnit} threshold because the layer does not declare its source units.`,
        }
    }
    if (input && target && input.kind !== target.kind) {
        return {
            ok: false,
            errorCode: 'INCOMPATIBLE_THRESHOLD_UNIT',
            message: `Threshold unit "${inputUnit}" is incompatible with the layer's declared unit "${declaredUnit}".`,
        }
    }
    const convert = (raw) => {
        const numeric = Number(raw)
        if (!Number.isFinite(numeric)) return numeric
        if (!input || !target) return numeric
        return (numeric * input.factor) / target.factor
    }
    const normalizedOperator = normalizeThresholdOperator(operator)
    return {
        ok: true,
        value: normalizedOperator === 'between' ? undefined : convert(value),
        valueMin:
            normalizedOperator === 'between' ? convert(valueMin) : undefined,
        valueMax:
            normalizedOperator === 'between' ? convert(valueMax) : undefined,
        declaredUnit: target ? declaredUnit : null,
        converted: !!(input && target && input.canonical !== target.canonical),
    }
}

export function resolveThresholdBand(
    config,
    variable,
    layerName,
    explicitBand = null
) {
    if (explicitBand != null) {
        const band = Number(explicitBand)
        if (!Number.isInteger(band) || band < 1) {
            return {
                ok: false,
                errorCode: 'INVALID_RASTER_BAND',
                message: 'Raster band must be a positive one-based integer.',
            }
        }
        return { ok: true, band: `b${band}`, label: `band ${band}` }
    }
    const requested = normalizeText(variable)
    const layer = normalizeText(layerName)
    if (
        !requested ||
        requested === layer ||
        requested === 'b1' ||
        requested === 'band 1'
    ) {
        return { ok: true, band: 'b1', label: variable || 'band 1' }
    }
    const match = declaredVariables(config).find(
        (candidate) => normalizeText(candidate.name) === requested
    )
    const bandNumber = Number(match?.band)
    if (match && Number.isInteger(bandNumber) && bandNumber > 0) {
        return { ok: true, band: `b${bandNumber}`, label: match.name }
    }
    return {
        ok: false,
        errorCode: 'UNRESOLVED_RASTER_VARIABLE',
        message: `Variable "${variable}" is not mapped to a raster band for ${layerName}. Use an explicitly configured variable or band 1.`,
    }
}
