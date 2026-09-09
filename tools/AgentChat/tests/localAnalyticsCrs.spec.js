import { test, expect } from '@playwright/test'
import {
    buildRasterTransformers,
    LocalAnalyticsCrsError,
    resolveRasterCrs,
} from '../localAnalyticsCrs.js'
import { resolveRasterSamplingBbox } from '../rasterBbox.js'

function imageWithGeoKeys(geoKeys) {
    return { getGeoKeys: () => geoKeys }
}

function captureError(callback) {
    try {
        callback()
        return null
    } catch (error) {
        return error
    }
}

test.describe('@unit AgentChat local analytics CRS safety', () => {
    test('identity-maps only an explicitly declared WGS84-compatible geographic CRS', () => {
        const epsg4326 = buildRasterTransformers(
            imageWithGeoKeys({
                GTModelTypeGeoKey: 2,
                GeographicTypeGeoKey: 4326,
            })
        )
        expect(epsg4326.crs).toBe('EPSG:4326')
        expect(epsg4326.toImage(-150, 72)).toEqual([-150, 72])
        expect(epsg4326.toLatLon(-150, 72)).toEqual([-150, 72])

        expect(
            resolveRasterCrs({
                GTModelTypeGeoKey: 2,
                GeogCitationGeoKey: 'WGS_1984|',
            })
        ).toEqual({
            code: 'OGC:CRS84',
            kind: 'geographic',
            identity: true,
        })
    })

    test('transforms projected raster coordinates in both directions', () => {
        const calls = []
        const projection = (from, to, coordinates) => {
            calls.push({ from, to, coordinates })
            return from === 'EPSG:4326'
                ? [coordinates[0] + 1000, coordinates[1] + 2000]
                : [coordinates[0] - 1000, coordinates[1] - 2000]
        }
        const transformers = buildRasterTransformers(
            imageWithGeoKeys({
                GTModelTypeGeoKey: 1,
                ProjectedCSTypeGeoKey: 3413,
                GeographicTypeGeoKey: 4326,
            }),
            projection
        )

        expect(transformers.crs).toBe('EPSG:3413')
        expect(transformers.toImage(-45, 75)).toEqual([955, 2075])
        expect(transformers.toLatLon(955, 2075)).toEqual([-45, 75])
        expect(calls).toEqual([
            {
                from: 'EPSG:4326',
                to: 'EPSG:3413',
                coordinates: [-45, 75],
            },
            {
                from: 'EPSG:3413',
                to: 'EPSG:4326',
                coordinates: [955, 2075],
            },
        ])
    })

    test('rejects missing and unknown CRS metadata instead of assuming longitude/latitude', () => {
        const missing = captureError(() =>
            buildRasterTransformers(imageWithGeoKeys({}), null)
        )
        expect(missing).toBeInstanceOf(LocalAnalyticsCrsError)
        expect(missing.code).toBe('LOCAL_ANALYTICS_CRS_MISSING')
        expect(missing.message).toContain('does not declare')

        const unknown = captureError(() =>
            buildRasterTransformers(
                imageWithGeoKeys({
                    GTModelTypeGeoKey: 1,
                    ProjectedCSTypeGeoKey: 32767,
                    GeographicTypeGeoKey: 4326,
                }),
                () => [0, 0]
            )
        )
        expect(unknown).toBeInstanceOf(LocalAnalyticsCrsError)
        expect(unknown.code).toBe('LOCAL_ANALYTICS_CRS_UNSUPPORTED')
        expect(unknown.message).toContain('user-defined projected')
    })

    test('rejects a projected CRS when proj4 is unavailable', () => {
        const error = captureError(() =>
            buildRasterTransformers(
                imageWithGeoKeys({
                    GTModelTypeGeoKey: 1,
                    ProjectedCSTypeGeoKey: 3413,
                }),
                null
            )
        )
        expect(error).toBeInstanceOf(LocalAnalyticsCrsError)
        expect(error).toMatchObject({
            code: 'LOCAL_ANALYTICS_PROJECTION_UNAVAILABLE',
            crs: 'EPSG:3413',
        })
        expect(error.message).toContain('projection library is unavailable')

        const nonWgs84 = captureError(() =>
            buildRasterTransformers(
                imageWithGeoKeys({
                    GTModelTypeGeoKey: 2,
                    GeographicTypeGeoKey: 4269,
                }),
                null
            )
        )
        expect(nonWgs84).toMatchObject({
            code: 'LOCAL_ANALYTICS_PROJECTION_UNAVAILABLE',
            crs: 'EPSG:4269',
        })
    })

    test('surfaces transform exceptions and invalid output without identity fallback', () => {
        const throwing = buildRasterTransformers(
            imageWithGeoKeys({ ProjectedCSTypeGeoKey: 3413 }),
            () => {
                throw new Error('EPSG definition unavailable')
            }
        )
        const thrown = captureError(() => throwing.toImage(-45, 75))
        expect(thrown).toBeInstanceOf(LocalAnalyticsCrsError)
        expect(thrown).toMatchObject({
            code: 'LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED',
            crs: 'EPSG:3413',
        })
        expect(thrown.message).toContain('stopped to avoid sampling')
        expect(thrown.cause?.message).toBe('EPSG definition unavailable')

        const invalid = buildRasterTransformers(
            imageWithGeoKeys({ ProjectedCSTypeGeoKey: 3413 }),
            () => [Number.NaN, 75]
        )
        const invalidOutput = captureError(() => invalid.toImage(-45, 75))
        expect(invalidOutput).toMatchObject({
            code: 'LOCAL_ANALYTICS_CRS_TRANSFORM_FAILED',
            crs: 'EPSG:3413',
        })
        expect(invalidOutput.message).toContain('returned invalid coordinates')
    })

    test('uses the native raster footprint for a full-layer request without projecting a synthetic world envelope', () => {
        const datasetBbox = [-4194304, -4194304, 4194304, 4194304]
        let projectionCalls = 0
        const resolved = resolveRasterSamplingBbox(
            {
                bbox: [-180, -90, 180, 90],
                fullLayerExtent: true,
            },
            datasetBbox,
            () => {
                projectionCalls += 1
                throw new Error('full extent must not be projected')
            }
        )

        expect(resolved).toEqual(datasetBbox)
        expect(resolved).not.toBe(datasetBbox)
        expect(projectionCalls).toBe(0)
    })
})
