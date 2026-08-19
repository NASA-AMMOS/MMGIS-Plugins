const USER_DEFINED_CRS_CODE = 32767
const WGS84_IDENTITY_CODES = new Set(['EPSG:4326', 'EPSG:4979'])
const WGS84_CITATION_ALIASES = new Set([
    'CRS84',
    'GCS WGS 1984',
    'GCS WGS84',
    'OGC CRS84',
    'OGC:CRS84',
    'WGS 84',
    'WGS 1984',
    'WGS84',
])

export class LocalAnalyticsCrsError extends Error {
    constructor(code, message, { crs = null, cause = null } = {}) {
        super(message)
        this.name = 'LocalAnalyticsCrsError'
        this.code = code
        this.crs = crs
        if (cause) this.cause = cause
    }
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key)
}

function numericGeoKey(value) {
    const numeric = Number(value)
    if (!Number.isInteger(numeric) || numeric <= 0) return null
    return numeric
}

function epsgFromGeoKey(value) {
    const numeric = numericGeoKey(value)
    if (numeric == null || numeric === USER_DEFINED_CRS_CODE) return null
    return `EPSG:${numeric}`
}

function epsgFromCitation(citation) {
    if (typeof citation !== 'string') return null
    const match = citation.match(/\bEPSG\s*:\s*(\d+)\b/i)
    if (!match) return null
    return epsgFromGeoKey(match[1])
}

function normalizedCitation(citation) {
    if (typeof citation !== 'string') return ''
    return citation
        .replace(/\0/g, '')
        .replace(/[|_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase()
}

function isExplicitWgs84Citation(citation) {
    return WGS84_CITATION_ALIASES.has(normalizedCitation(citation))
}

function missingCrsError() {
    return new LocalAnalyticsCrsError(
        'LOCAL_ANALYTICS_CRS_MISSING',
        'Local raster analytics cannot safely use this layer because the GeoTIFF does not declare a coordinate reference system.'
    )
}

function unknownCrsError(kind = 'coordinate') {
    return new LocalAnalyticsCrsError(
        'LOCAL_ANALYTICS_CRS_UNSUPPORTED',
        `Local raster analytics cannot safely use the GeoTIFF's unknown or user-defined ${kind} reference system. Configure a recognized EPSG CRS for the raster.`
    )
}

/**
 * Resolve only CRS metadata that is explicit enough to transform safely.
 * A projected GeoTIFF may also declare its base geographic CRS, so projected
 * metadata always takes precedence over GeographicTypeGeoKey.
 */
export function resolveRasterCrs(geoKeys) {
    if (!geoKeys || typeof geoKeys !== 'object') throw missingCrsError()

    const modelType = numericGeoKey(geoKeys.GTModelTypeGeoKey)
    const hasProjectedMetadata =
        modelType === 1 ||
        hasOwn(geoKeys, 'ProjectedCSTypeGeoKey') ||
        hasOwn(geoKeys, 'PCSCitationGeoKey') ||
        hasOwn(geoKeys, 'ProjectedCitationGeoKey')

    if (hasProjectedMetadata) {
        const citation =
            geoKeys.PCSCitationGeoKey ||
            geoKeys.ProjectedCitationGeoKey ||
            ''
        const code =
            epsgFromGeoKey(geoKeys.ProjectedCSTypeGeoKey) ||
            epsgFromCitation(citation)
        if (!code) throw unknownCrsError('projected coordinate')
        return { code, kind: 'projected', identity: false }
    }

    const hasGeographicMetadata =
        modelType === 2 ||
        hasOwn(geoKeys, 'GeographicTypeGeoKey') ||
        hasOwn(geoKeys, 'GeogCitationGeoKey')

    if (hasGeographicMetadata) {
        const citation = geoKeys.GeogCitationGeoKey || ''
        const code =
            epsgFromGeoKey(geoKeys.GeographicTypeGeoKey) ||
            epsgFromCitation(citation)
        if (code) {
            return {
                code,
                kind: 'geographic',
                identity: WGS84_IDENTITY_CODES.has(code),
            }
        }
        if (isExplicitWgs84Citation(citation)) {
            return { code: 'OGC:CRS84', kind: 'geographic', identity: true }
        }
        throw unknownCrsError('geographic coordinate')
    }

    if (modelType != null || Object.keys(geoKeys).length > 0) {
        throw unknownCrsError()
    }
    throw missingCrsError()
}

function validatedCoordinatePair(coordinates, crs) {
    if (
        !Array.isArray(coordinates) ||
        coordinates.length < 2 ||
        !Number.isFinite(Number(coordinates[0])) ||
        !Number.isFinite(Number(coordinates[1]))
    ) {
        throw new LocalAnalyticsCrsError(
            'LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED',
            `The coordinate transformation for ${crs} returned invalid coordinates, so local analytics was stopped to avoid sampling the wrong pixels.`,
            { crs }
        )
    }
    return [Number(coordinates[0]), Number(coordinates[1])]
}

function transformCoordinate(projection, from, to, coordinates, crs) {
    try {
        return validatedCoordinatePair(
            projection(from, to, coordinates),
            crs
        )
    } catch (error) {
        if (error instanceof LocalAnalyticsCrsError) throw error
        throw new LocalAnalyticsCrsError(
            'LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED',
            `Coordinates could not be transformed between WGS 84 and ${crs}, so local analytics was stopped to avoid sampling the wrong pixels.`,
            { crs, cause: error }
        )
    }
}

export function buildRasterTransformers(
    image,
    projection = typeof window !== 'undefined' ? window.proj4 : null
) {
    const geoKeys =
        (typeof image?.getGeoKeys === 'function' && image.getGeoKeys()) ||
        image?.geoKeys ||
        null
    const crs = resolveRasterCrs(geoKeys)

    if (crs.identity) {
        return {
            crs: crs.code,
            toImage: (lon, lat) =>
                validatedCoordinatePair([lon, lat], crs.code),
            toLatLon: (x, y) => validatedCoordinatePair([x, y], crs.code),
        }
    }

    if (typeof projection !== 'function') {
        throw new LocalAnalyticsCrsError(
            'LOCAL_ANALYTICS_PROJECTION_UNAVAILABLE',
            `Local raster analytics requires coordinate transformation support for ${crs.code}, but the projection library is unavailable.`,
            { crs: crs.code }
        )
    }

    return {
        crs: crs.code,
        toImage: (lon, lat) =>
            transformCoordinate(
                projection,
                'EPSG:4326',
                crs.code,
                [lon, lat],
                crs.code
            ),
        toLatLon: (x, y) =>
            transformCoordinate(
                projection,
                crs.code,
                'EPSG:4326',
                [x, y],
                crs.code
            ),
    }
}
