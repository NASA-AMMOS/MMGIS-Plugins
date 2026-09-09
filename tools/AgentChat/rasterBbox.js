function finiteBbox(value) {
    return (
        Array.isArray(value) &&
        value.length === 4 &&
        value.every((item) => Number.isFinite(Number(item)))
    )
}

function normalizeLongitude(value) {
    let longitude = Number(value)
    while (longitude > 180) longitude -= 360
    while (longitude < -180) longitude += 360
    return longitude
}

// Project a geographic envelope by densifying every edge. Projecting only its
// four corners is invalid for nonlinear/polar CRSs (and collapses a full-world
// -180..180 envelope because those meridians are coincident).
export function projectGeographicBbox(bbox, toImage, { segments = 72 } = {}) {
    if (!finiteBbox(bbox) || typeof toImage !== 'function') return null
    const west = Number(bbox[0])
    const south = Number(bbox[1])
    let east = Number(bbox[2])
    const north = Number(bbox[3])
    const fullLongitude = Math.abs(east - west) >= 359.999
    if (!fullLongitude && east < west) east += 360
    if (fullLongitude) east = west + 360
    const steps = Math.max(8, Math.min(360, Math.floor(segments)))
    const geographicPoints = []
    for (let index = 0; index <= steps; index += 1) {
        const ratio = index / steps
        const longitude = west + (east - west) * ratio
        const latitude = south + (north - south) * ratio
        geographicPoints.push(
            [normalizeLongitude(longitude), south],
            [normalizeLongitude(longitude), north],
            [normalizeLongitude(west), latitude],
            [normalizeLongitude(east), latitude]
        )
    }
    const projected = geographicPoints
        .map(([longitude, latitude]) => toImage(longitude, latitude))
        .filter(
            (point) =>
                Array.isArray(point) &&
                point.length >= 2 &&
                Number.isFinite(Number(point[0])) &&
                Number.isFinite(Number(point[1]))
        )
        .map((point) => [Number(point[0]), Number(point[1])])
    if (!projected.length) return null
    const xs = projected.map((point) => point[0])
    const ys = projected.map((point) => point[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

// A full-layer request already has an authoritative footprint once the raster
// image is open. Re-projecting a synthetic world envelope is unnecessary and
// can produce singular coordinates in polar CRSs. It can also make a browser
// COG reader request a pathological window before it is clamped. Use the
// native dataset extent directly; ordinary named/current-view areas still go
// through the densified WGS84-to-raster projection above.
export function resolveRasterSamplingBbox(area, datasetBbox, toImage) {
    if (!finiteBbox(datasetBbox)) return null
    const normalizedDatasetBbox = datasetBbox.map(Number)
    if (area?.fullLayerExtent === true) {
        return normalizedDatasetBbox.slice()
    }
    return projectGeographicBbox(area?.bbox, toImage)
}
