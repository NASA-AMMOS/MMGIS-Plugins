const DEFAULT_RASTER_OPERATIONS = [
    'statistics',
    'mean',
    'min',
    'max',
    'standard_deviation',
    'histogram',
    'threshold',
    'highlight',
    'comparison',
    'anomaly_detection',
]

const DEFAULT_ANALYTICS_SERVICE_OPERATIONS = [
    'statistics',
    'mean',
    'min',
    'max',
    'standard_deviation',
]

const TOOL_ANALYSIS_OPERATIONS = {
    calculate_layer_mean: [
        'statistics',
        'mean',
        'min',
        'max',
        'standard_deviation',
    ],
    statistics_first_visible: [
        'statistics',
        'mean',
        'min',
        'max',
        'standard_deviation',
    ],
    threshold_highlight: ['threshold', 'highlight'],
    highlight_relative_to_mean: ['mean', 'threshold', 'highlight'],
    calculate_layer_difference: ['comparison'],
    detect_anomalies: ['anomaly_detection'],
    multilayer_statistics: ['statistics', 'comparison'],
    spatial_statistics: ['statistics'],
    change_detection: ['change_detection', 'comparison'],
    temporal_trends: ['temporal_trend'],
    time_series_animation: ['animation'],
}

function asText(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function normalize(value) {
    return asText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

function getConfig(layer) {
    return layer?.config || layer?.layer?.config || layer?.layer || layer || {}
}

function uniqueStrings(values) {
    return Array.from(
        new Set(
            (Array.isArray(values) ? values : [])
                .map((value) => asText(value))
                .filter(Boolean)
        )
    )
}

function normalizedSet(values) {
    return new Set(uniqueStrings(values).map((value) => normalize(value)))
}

export function deriveAvailableAnalysisOperations(
    tools,
    { scalar = true, source = '', type = '' } = {}
) {
    const operations = []
    const dataKinds = normalizedSet([
        source,
        ...String(source || '').split(/[-_\s]+/),
        type,
        scalar ? 'scalar' : '',
        scalar ? 'raster' : '',
    ])
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!tool || tool.enabled === false) continue
        operations.push(...(TOOL_ANALYSIS_OPERATIONS[tool.name] || []))
        const metadata = tool.analytics
        if (!metadata || typeof metadata !== 'object') continue
        if (metadata.requiresScalar === true && !scalar) continue
        const requiredKinds = normalizedSet(metadata.dataKinds)
        if (
            requiredKinds.size &&
            !Array.from(requiredKinds).some((kind) => dataKinds.has(kind))
        )
            continue
        operations.push(...uniqueStrings(metadata.operations))
    }
    return uniqueStrings(operations)
}

function deriveProviderDeclaredOperations(
    tools,
    { scalar = true, source = '', type = '' } = {}
) {
    const operations = []
    const dataKinds = normalizedSet([
        source,
        ...String(source || '').split(/[-_\s]+/),
        type,
        scalar ? 'scalar' : '',
        scalar ? 'raster' : '',
    ])
    for (const tool of Array.isArray(tools) ? tools : []) {
        if (!tool || tool.enabled === false) continue
        const metadata = tool.analytics
        if (!metadata || typeof metadata !== 'object') continue
        if (metadata.requiresScalar === true && !scalar) continue
        const requiredKinds = normalizedSet(metadata.dataKinds)
        if (
            requiredKinds.size &&
            !Array.from(requiredKinds).some((kind) => dataKinds.has(kind))
        )
            continue
        operations.push(...uniqueStrings(metadata.operations))
    }
    return uniqueStrings(operations)
}

function declaredAnalysis(config) {
    const candidates = [
        config?.copilot?.analysis,
        config?.copilot?.analytics,
        config?.analysisCapabilities,
        config?.analyticsCapabilities,
        config?.analytics,
    ]
    return candidates.find(
        (candidate) =>
            candidate === false ||
            candidate === true ||
            Array.isArray(candidate) ||
            (candidate && typeof candidate === 'object')
    )
}

function declaredOperations(declaration) {
    if (Array.isArray(declaration)) return uniqueStrings(declaration)
    if (!declaration || typeof declaration !== 'object') return []
    return uniqueStrings(
        declaration.operations || declaration.actions || declaration.capabilities
    )
}

function extensionOf(url) {
    const clean = asText(url).split(/[?#]/)[0].toLowerCase()
    const match = clean.match(/\.([a-z0-9]+)$/)
    return match ? match[1] : ''
}

function isRgbLike(config, name, source) {
    const bands = config.cogBands || config.bands || config.bandIndexes
    if (Array.isArray(bands) && bands.length >= 3) return true
    if (Number(config.bandCount) >= 3 || Number(config.rasterBands) >= 3)
        return true
    const parser = normalize(config.demparser || config.parser)
    const label = normalize(name)
    if (/\b(true color|rgb imagery|natural color|basemap)\b/.test(label))
        return true
    if (
        (source === 'external-imagery' || source === 'image-tiles') &&
        parser === 'rgba'
    )
        return true
    return false
}

export function isLayerVisible(layer, onState = null) {
    const config = getConfig(layer)
    const id = String(
        layer?.id || layer?.uuid || config.uuid || config.name || ''
    )
    if (onState && typeof onState === 'object') {
        if (Object.prototype.hasOwnProperty.call(onState, id))
            return !!onState[id]
        if (
            config.name &&
            Object.prototype.hasOwnProperty.call(onState, config.name)
        )
            return !!onState[config.name]
    }
    return !!(
        layer?.visible ||
        layer?.isVisible ||
        config.visible ||
        config.visibility
    )
}

export function isUserFacingLayer(layer) {
    const config = getConfig(layer)
    const type = normalize(config.type || layer?.type)
    if (type === 'header') return false
    if (config.copilot?.hidden === true || config.copilot?.selectable === false)
        return false
    if (config.structural === true) return false
    return true
}

export function assessLayerAnalysisCompatibility(layer, options = {}) {
    const config = getConfig(layer)
    const name =
        asText(layer?.displayName) ||
        asText(layer?.display_name) ||
        asText(config.display_name) ||
        asText(config.displayName) ||
        asText(config.name) ||
        'Unnamed layer'
    const type = normalize(config.type || layer?.type)
    const sourceType = normalize(config.sourceType || config.demSourceType)
    const url = asText(
        config.analyticsSource ||
            config.cogUrl ||
            config.demurl ||
            config.demUrl ||
            config.dem ||
            config.demfile ||
            config.demFile ||
            config.demtileurl ||
            config.url ||
            config.source ||
            config.path ||
            config.href
    )
    const lowerUrl = url.toLowerCase()
    const declaration = declaredAnalysis(config)
    const explicitOperations = declaredOperations(declaration)
    const explicitlyDisabled =
        declaration === false ||
        declaration?.enabled === false ||
        config.analyticsEndpoint === false
    const explicitlyEnabled =
        declaration === true ||
        declaration?.enabled === true ||
        explicitOperations.length > 0 ||
        !!asText(config.analyticsEndpoint) ||
        !!asText(config.analyticsLayerKey || config.analyticsKey)
    const visible = isLayerVisible(layer, options.onState)
    const base = {
        supported: false,
        reason: '',
        operations: [],
        source: 'unknown',
        scalar: false,
        visible,
        layerName: name,
    }

    if (!isUserFacingLayer(layer)) {
        return {
            ...base,
            source: 'structural',
            reason: 'This entry is an organizational layer group, not data.',
        }
    }
    if (explicitlyDisabled) {
        return {
            ...base,
            source: 'disabled',
            reason:
                declaration?.reason ||
                'Analysis is disabled for this layer by its configuration.',
        }
    }

    const isStac =
        sourceType === 'stac collection' ||
        sourceType === 'stac-collection' ||
        lowerUrl.startsWith('stac-collection:')
    const isCog =
        sourceType === 'cog' ||
        normalize(config.demSourceType) === 'cog' ||
        lowerUrl.startsWith('cog:') ||
        /\.tiff?(?:$|[?#])/i.test(url)
    const isDataRaster = type === 'data'
    const hasScalarMetadata =
        config.cogUnits != null ||
        (config.cogMin != null && config.cogMax != null) ||
        config.variables?.shader?.units != null ||
        config.variables?.shader?.type === 'colorize' ||
        (Array.isArray(config.cogBands) && config.cogBands.length === 1) ||
        Number(config.bandCount) === 1 ||
        Number(config.rasterBands) === 1
    const externalHttp = /^https?:\/\//i.test(url)
    const templatedImage =
        /\{(?:x|y|z|time)\}/i.test(url) &&
        /\.(?:png|jpe?g|webp)(?:$|[?#])/i.test(url)
    let source = 'unknown'
    if (asText(config.analyticsEndpoint) || asText(config.analyticsLayerKey))
        source = 'analytics-service'
    else if (isStac) source = 'stac-cog'
    else if (isCog) source = 'cog-geotiff'
    else if (externalHttp && templatedImage) source = 'external-imagery'
    else if (templatedImage) source = 'image-tiles'
    else if (isDataRaster) source = 'numeric-data-layer'
    else if (type === 'image') source = 'image'
    else if (type) source = type

    if (isRgbLike(config, name, source) && !explicitlyEnabled) {
        return {
            ...base,
            source,
            reason:
                'This is visualization-only RGB imagery and does not expose a meaningful scalar value for statistics.',
        }
    }

    const scalar =
        explicitlyEnabled ||
        (isStac && hasScalarMetadata) ||
        (isCog && hasScalarMetadata)
    if (!scalar) {
        const ext = extensionOf(url)
        const reason =
            source === 'external-imagery' || source === 'image-tiles'
                ? 'This layer exposes rendered image tiles rather than scalar source values.'
                : ext === 'jpg' || ext === 'jpeg' || ext === 'png'
                  ? 'This image source does not declare a scalar band for analysis.'
                  : 'No scalar analytics source or plugin-provided analysis capability is registered for this layer.'
        return { ...base, source, reason }
    }

    const operations = explicitOperations.length
        ? explicitOperations
        : isStac || isCog
          ? DEFAULT_RASTER_OPERATIONS.slice()
          : source === 'analytics-service'
            ? DEFAULT_ANALYTICS_SERVICE_OPERATIONS.slice()
            : []
    if (config.time?.enabled === true && !operations.includes('temporal_trend'))
        operations.push('temporal_trend')
    if (config.time?.enabled === true && !operations.includes('animation'))
        operations.push('animation')

    let executableOperations = uniqueStrings(operations)
    if (Array.isArray(options.tools)) {
        const registeredOperations = deriveAvailableAnalysisOperations(
            options.tools,
            { scalar, source, type }
        )
        const providerOperations = deriveProviderDeclaredOperations(
            options.tools,
            { scalar, source, type }
        )
        if (!explicitOperations.length)
            executableOperations = uniqueStrings([
                ...executableOperations,
                ...providerOperations,
            ])
        const available = normalizedSet(registeredOperations)
        executableOperations = executableOperations.filter((operation) =>
            available.has(normalize(operation))
        )
        if (!executableOperations.length) {
            return {
                ...base,
                scalar: true,
                source,
                reason:
                    'Scalar source values are available, but no currently registered analytic action supports this layer.',
            }
        }
    }

    return {
        ...base,
        supported: true,
        scalar: true,
        source,
        operations: executableOperations,
        reason:
            declaration?.reason ||
            `Scalar values are available from the ${source.replace(/-/g, ' ')} source.`,
    }
}

export function buildAnalysisCatalog(layers, options = {}) {
    return (Array.isArray(layers) ? layers : [])
        .filter(isUserFacingLayer)
        .map((layer) => ({
            layer,
            ...assessLayerAnalysisCompatibility(layer, options),
        }))
}

export function selectFirstVisibleAnalyzableLayer(layers, options = {}) {
    return (
        buildAnalysisCatalog(layers, options).find(
            (entry) => entry.visible && entry.supported
        ) || null
    )
}

export function formatAnalyzableLayerCatalog(layers, options = {}) {
    const catalog = buildAnalysisCatalog(layers, options)
    const supported = catalog.filter((entry) => entry.supported)
    const unsupported = catalog.filter((entry) => !entry.supported)
    const visible = supported.filter((entry) => entry.visible)
    const lines = []
    if (visible.length) {
        lines.push(
            `Currently visible and analyzable: ${visible
                .map((entry) => `**${entry.layerName}**`)
                .join(', ')}.`
        )
        lines.push('')
    }
    if (supported.length) {
        lines.push(`**Analyzable layers (${supported.length})**`)
        supported.forEach((entry, index) => {
            lines.push(
                `${index + 1}. **${entry.layerName}** — ${
                    entry.visible ? 'visible' : 'hidden'
                }; ${entry.operations.join(', ')} (${entry.source}).`
            )
        })
    } else {
        lines.push(
            'No layers in the current mission expose a supported scalar analytics source.'
        )
    }
    if (unsupported.length) {
        lines.push('')
        lines.push('**Visualization-only or unsupported layers**')
        unsupported.forEach((entry, index) => {
            lines.push(`${index + 1}. ${entry.layerName} — ${entry.reason}`)
        })
    }
    return lines.join('\n')
}

export { DEFAULT_RASTER_OPERATIONS, TOOL_ANALYSIS_OPERATIONS }
