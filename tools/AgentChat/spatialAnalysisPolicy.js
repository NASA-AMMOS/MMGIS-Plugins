const MORAN_ALIASES = new Set([
    'moran',
    'morans i',
    'spatial autocorrelation',
    'spatial-autocorrelation',
])

export function resolveSpatialAnalysisType(value = 'moran') {
    const normalized = String(value || 'moran')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, ' ')
        .trim()
    if (MORAN_ALIASES.has(normalized)) {
        return { ok: true, analysisType: 'moran' }
    }
    return {
        ok: false,
        analysisType: null,
        errorCode: 'UNSUPPORTED_SPATIAL_ANALYSIS_TYPE',
        message: `Spatial analysis type "${String(value)}" is unsupported. Currently available: Moran's I descriptive spatial autocorrelation.`,
    }
}
