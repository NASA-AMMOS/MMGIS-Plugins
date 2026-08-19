function normalizeBand(value) {
    const numeric = Number(String(value ?? 1).replace(/^b/i, ''))
    return Number.isInteger(numeric) && numeric > 0 ? numeric : 1
}

function tokenize(expression) {
    const source = String(expression || '')
        .replace(/asset_([bB]\d+)/g, '$1')
        .trim()
    const tokens = []
    let offset = 0
    while (offset < source.length) {
        const rest = source.slice(offset)
        const whitespace = rest.match(/^\s+/)
        if (whitespace) {
            offset += whitespace[0].length
            continue
        }
        const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
        if (number) {
            tokens.push({ type: 'number', value: Number(number[0]) })
            offset += number[0].length
            continue
        }
        const band = rest.match(/^b([1-9]\d*)/i)
        if (band) {
            tokens.push({ type: 'band', value: Number(band[1]) })
            offset += band[0].length
            continue
        }
        const operator = rest[0]
        if ('+-*/()'.includes(operator)) {
            tokens.push({ type: operator, value: operator })
            offset += 1
            continue
        }
        throw new Error(`Unsupported token at character ${offset + 1}.`)
    }
    return { source, tokens }
}

function parseExpression(tokens) {
    let offset = 0
    const peek = () => tokens[offset]
    const consume = (type) => {
        const token = tokens[offset]
        if (!token || token.type !== type) throw new Error(`Expected ${type}.`)
        offset += 1
        return token
    }
    const parsePrimary = () => {
        const token = peek()
        if (!token) throw new Error('Expression ended unexpectedly.')
        if (token.type === 'number' || token.type === 'band') {
            offset += 1
            return token
        }
        if (token.type === '(') {
            consume('(')
            const node = parseAdditive()
            consume(')')
            return node
        }
        if (token.type === '+' || token.type === '-') {
            offset += 1
            return {
                type: 'unary',
                operator: token.type,
                child: parsePrimary(),
            }
        }
        throw new Error(`Unexpected ${token.type}.`)
    }
    const parseMultiplicative = () => {
        let node = parsePrimary()
        while (peek()?.type === '*' || peek()?.type === '/') {
            const operator = tokens[offset++].type
            node = {
                type: 'binary',
                operator,
                left: node,
                right: parsePrimary(),
            }
        }
        return node
    }
    const parseAdditive = () => {
        let node = parseMultiplicative()
        while (peek()?.type === '+' || peek()?.type === '-') {
            const operator = tokens[offset++].type
            node = {
                type: 'binary',
                operator,
                left: node,
                right: parseMultiplicative(),
            }
        }
        return node
    }
    const root = parseAdditive()
    if (offset !== tokens.length)
        throw new Error('Unexpected trailing expression.')
    return root
}

function collectBands(node, output = new Set()) {
    if (!node) return output
    if (node.type === 'band') output.add(node.value)
    if (node.child) collectBands(node.child, output)
    if (node.left) collectBands(node.left, output)
    if (node.right) collectBands(node.right, output)
    return output
}

function evaluate(node, bandValue, requestedBand) {
    if (node.type === 'number') return node.value
    if (node.type === 'band')
        return node.value === requestedBand ? bandValue : NaN
    if (node.type === 'unary') {
        const value = evaluate(node.child, bandValue, requestedBand)
        return node.operator === '-' ? -value : value
    }
    const left = evaluate(node.left, bandValue, requestedBand)
    const right = evaluate(node.right, bandValue, requestedBand)
    switch (node.operator) {
        case '+':
            return left + right
        case '-':
            return left - right
        case '*':
            return left * right
        case '/':
            return right === 0 ? NaN : left / right
        default:
            return NaN
    }
}

function canonicalize(node) {
    if (node.type === 'number') return String(node.value)
    if (node.type === 'band') return `b${node.value}`
    if (node.type === 'unary')
        return `(${node.operator}${canonicalize(node.child)})`
    return `(${canonicalize(node.left)}${node.operator}${canonicalize(
        node.right
    )})`
}

function configuredRange(config) {
    if (config?.cogTransform !== true) return null
    const min = Number(config?.cogMin)
    const max = Number(config?.cogMax)
    return Number.isFinite(min) && Number.isFinite(max) && min <= max
        ? [min, max]
        : null
}

/**
 * Compile the mission-declared scalar display transform without eval/new Function.
 * Only arithmetic over one explicitly selected raster band is accepted. A
 * configured expression that cannot be proven safe is rejected instead of
 * silently reporting raw values with display units.
 */
export function resolveScalarRasterTransform(config = {}, requestedBand = 1) {
    const band = normalizeBand(requestedBand)
    const rawExpression =
        config.currentCogExpression || config.cogExpression || `b${band}`
    try {
        const { source, tokens } = tokenize(rawExpression)
        if (!tokens.length) throw new Error('Expression is empty.')
        const ast = parseExpression(tokens)
        const bands = Array.from(collectBands(ast))
        if (bands.length !== 1 || bands[0] !== band) {
            throw new Error(
                `Expression must reference only the selected band b${band}.`
            )
        }
        const validRange = configuredRange(config)
        return {
            ok: true,
            band,
            expression: source,
            canonicalExpression: canonicalize(ast),
            transformed: source.replace(/\s+/g, '') !== `b${band}`,
            validRange,
            unit:
                typeof config.cogUnits === 'string' && config.cogUnits.trim()
                    ? config.cogUnits.trim()
                    : null,
            apply(value) {
                const transformed = evaluate(ast, Number(value), band)
                if (!Number.isFinite(transformed)) return null
                if (
                    validRange &&
                    (transformed < validRange[0] || transformed > validRange[1])
                )
                    return null
                return transformed
            },
        }
    } catch (cause) {
        return {
            ok: false,
            band,
            expression: String(rawExpression || ''),
            errorCode: 'LOCAL_ANALYTICS_TRANSFORM_UNSUPPORTED',
            message:
                `The configured raster expression for band ${band} cannot be ` +
                'applied safely in local analytics.',
            cause,
        }
    }
}

function numericRange(value) {
    return Array.isArray(value) &&
        value.length === 2 &&
        value.every((item) => Number.isFinite(Number(item)))
        ? value.map(Number)
        : null
}

/** Require explicit provider proof before trusting finite values for a layer
 * whose mission config declares display transforms, units, ranges, or NoData.
 */
export function assessProviderScalarSemantics(
    config = {},
    semantics = {},
    requestedBand = 1
) {
    const expected = resolveScalarRasterTransform(config, requestedBand)
    if (!expected.ok) return expected
    const expectedNoData = configuredNoDataValues(config)
    const requiresProof =
        expected.transformed ||
        !!expected.validRange ||
        !!expected.unit ||
        expectedNoData.length > 0
    if (!requiresProof) return { ok: true, required: false }
    if (!semantics || typeof semantics !== 'object') {
        return {
            ok: false,
            required: true,
            errorCode: 'ANALYTICS_SEMANTICS_UNVERIFIED',
            message:
                'The analytics provider did not report how raster values were transformed or filtered.',
        }
    }
    if (expected.transformed) {
        const providerExpression =
            semantics.value_expression ||
            semantics.applied_expression ||
            semantics.expression
        const provider = resolveScalarRasterTransform(
            { cogExpression: providerExpression },
            requestedBand
        )
        if (
            !provider.ok ||
            provider.canonicalExpression !== expected.canonicalExpression
        ) {
            return {
                ok: false,
                required: true,
                errorCode: 'ANALYTICS_TRANSFORM_UNVERIFIED',
                message:
                    'The analytics provider did not prove that it applied the configured scalar display expression.',
            }
        }
    }
    if (expected.validRange) {
        const providerRange = numericRange(
            semantics.valid_range ||
                semantics.applied_valid_range ||
                semantics.value_range
        )
        if (
            !providerRange ||
            providerRange.some(
                (value, index) => value !== expected.validRange[index]
            )
        ) {
            return {
                ok: false,
                required: true,
                errorCode: 'ANALYTICS_VALID_RANGE_UNVERIFIED',
                message:
                    'The analytics provider did not prove that it enforced the configured valid-value range.',
            }
        }
        const reportedValues = ['min', 'max', 'mean', 'median', 'q25', 'q75']
            .map((key) => Number(semantics[key]))
            .filter(Number.isFinite)
        if (
            reportedValues.some(
                (value) =>
                    value < expected.validRange[0] ||
                    value > expected.validRange[1]
            )
        ) {
            return {
                ok: false,
                required: true,
                errorCode: 'ANALYTICS_RESULT_OUT_OF_RANGE',
                message:
                    "The analytics provider returned values outside the layer's configured valid-value range.",
            }
        }
    }
    if (expected.unit) {
        const providerUnit = String(
            semantics.unit || semantics.units || ''
        ).trim()
        if (providerUnit.toLowerCase() !== expected.unit.toLowerCase()) {
            return {
                ok: false,
                required: true,
                errorCode: 'ANALYTICS_UNIT_UNVERIFIED',
                message:
                    "The analytics provider did not report values in the layer's declared unit.",
            }
        }
    }
    if (expectedNoData.length) {
        const providerNoData = [
            ...(Array.isArray(semantics.nodata_values)
                ? semantics.nodata_values
                : []),
            semantics.nodata_value,
        ]
            .map(Number)
            .filter(Number.isFinite)
        if (expectedNoData.some((value) => !providerNoData.includes(value))) {
            return {
                ok: false,
                required: true,
                errorCode: 'ANALYTICS_NODATA_UNVERIFIED',
                message:
                    'The analytics provider did not prove that it excluded the configured NoData values.',
            }
        }
    }
    return { ok: true, required: true }
}

export function configuredNoDataValues(config = {}) {
    const candidates = [
        config.nodata,
        config.noData,
        config.noDataValue,
        config.nodataValue,
        config.cogNoData,
        config.cogNodata,
        config.metadata?.nodata,
        config.metadata?.noData,
        config.analysis?.nodata,
        config.analysis?.noData,
    ].flatMap((value) => (Array.isArray(value) ? value : [value]))
    return candidates.map(Number).filter((value) => Number.isFinite(value))
}
