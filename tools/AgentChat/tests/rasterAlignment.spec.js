import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
    assessRasterAlignment,
    buildSampleGridMetadata,
    generateUtcTimePoints,
    pairAlignedRasterValues,
} from '../rasterAlignment'
import { computeLinearTrend } from '../temporalRegression'
import { resolveSpatialAnalysisType } from '../spatialAnalysisPolicy'
import { projectGeographicBbox } from '../rasterBbox'
import { buildRasterTransformers } from '../localAnalyticsCrs'
import {
    describeStatisticsProvenance,
    isStatisticsSampled,
} from '../statisticsProvenance'
import { compareDifferenceUnits } from '../rasterDifferenceUnits'

const ADVANCED_SOURCE = readFileSync(
    resolve(
        process.cwd(),
        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/advancedStatistics.js'
    ),
    'utf8'
)

function raster(overrides = {}) {
    return {
        width: 2,
        height: 2,
        crs: 'EPSG:4326',
        bbox: [0, 0, 2, 2],
        transform: [1, 0, 0, 0, -1, 2],
        rawData: [1, 2, 3, 4],
        sourceIndices: [0, 1, 2, 3],
        values: [1, 2, 3, 4],
        ...overrides,
    }
}

test.describe('@unit AgentChat raster alignment and statistical validity', () => {
    test('requires both difference layers to declare compatible display units', () => {
        expect(compareDifferenceUnits('%', 'percent')).toEqual({
            ok: true,
            code: null,
            message: null,
            unit: '%',
        })
        expect(compareDifferenceUnits('%', '')).toMatchObject({
            ok: false,
            code: 'DIFFERENCE_UNITS_UNVERIFIED',
        })
        expect(compareDifferenceUnits('m', 'cm')).toMatchObject({
            ok: false,
            code: 'DIFFERENCE_UNIT_MISMATCH',
        })
    })

    test('rejects equal-sized grids with shifted transforms', () => {
        const result = assessRasterAlignment(
            raster(),
            raster({ transform: [1, 0, 0.5, 0, -1, 2] })
        )
        expect(result).toMatchObject({
            aligned: false,
            code: 'RASTER_ALIGNMENT_REQUIRED',
        })
    })

    test('pairs only co-located cells surviving asymmetric NoData/masks', () => {
        const result = pairAlignedRasterValues(
            raster({
                rawData: [0.1, 0.2, -9999, 0.4],
                sourceIndices: [0, 1, 3],
                values: [10, 20, 40],
            }),
            raster({
                rawData: [0.11, -9999, 0.33, 0.44],
                sourceIndices: [0, 2, 3],
                values: [11, 33, 44],
            })
        )
        expect(result).toMatchObject({
            ok: true,
            indices: [0, 3],
            valuesA: [10, 40],
            valuesB: [11, 44],
        })
    })

    test('pairs production-shaped sample-grid metadata with asymmetric valid cells', () => {
        const grid = buildSampleGridMetadata({
            crs: 'EPSG:3413',
            datasetBBox: [-1000, -1000, 1000, 1000],
            imageWidth: 4,
            imageHeight: 4,
            window: [1, 1, 3, 3],
            width: 2,
            height: 2,
        })
        expect(grid).toMatchObject({
            crs: 'EPSG:3413',
            bbox: [-500, -500, 500, 500],
            gridTransform: [500, 0, -500, 0, -500, 500],
        })
        const paired = pairAlignedRasterValues(
            {
                ...raster(),
                ...grid,
                sourceIndices: [0, 1, 3],
                values: [1, 2, 4],
            },
            {
                ...raster({ rawData: [5, 6, 7, 8] }),
                ...grid,
                sourceIndices: [0, 2, 3],
                values: [5, 7, 8],
            }
        )
        expect(paired).toMatchObject({ ok: true, indices: [0, 3] })
    })

    test('generates UTC-stable dates across DST and month ends', () => {
        expect(
            generateUtcTimePoints(
                '2024-03-09T00:00:00Z',
                '2024-03-12T00:00:00Z',
                'daily'
            )
        ).toEqual(['2024-03-09', '2024-03-10', '2024-03-11', '2024-03-12'])
        expect(
            generateUtcTimePoints(
                '2024-01-31T00:00:00Z',
                '2024-04-30T00:00:00Z',
                'monthly'
            )
        ).toEqual(['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30'])
    })

    test('densifies a full-longitude Arctic bbox before polar projection', () => {
        const projection = (from, _to, [longitude, latitude]) => {
            if (from !== 'EPSG:4326') return [longitude, latitude]
            const radians = (longitude * Math.PI) / 180
            const radius = 90 - latitude
            return [radius * Math.cos(radians), radius * Math.sin(radians)]
        }
        const transformer = buildRasterTransformers(
            {
                getGeoKeys: () => ({
                    GTModelTypeGeoKey: 1,
                    ProjectedCSTypeGeoKey: 3413,
                }),
            },
            projection
        )
        expect(transformer.crs).toBe('EPSG:3413')
        const projected = projectGeographicBbox(
            [-180, 70, 180, 90],
            transformer.toImage
        )
        expect(projected[0]).toBeCloseTo(-20, 4)
        expect(projected[1]).toBeCloseTo(-20, 4)
        expect(projected[2]).toBeCloseTo(20, 4)
        expect(projected[3]).toBeCloseTo(20, 4)
    })

    test('describes bounded raster statistics as sampled, never exhaustive', () => {
        const stats = {
            is_sampled: true,
            sample_count: 600000,
            valid_count: 450000,
            population_count: 2400000,
            population_coverage: 0.25,
            method: 'bounded resampled raster grid',
        }
        expect(isStatisticsSampled(stats)).toBe(true)
        const message = describeStatisticsProvenance(stats).join(' ')
        expect(message).toContain('approximate')
        expect(message).toContain('450,000 valid sampled raster cells')
        expect(message).toContain('within 600,000 cells read')
        expect(message).not.toMatch(/all valid|exhaustive population coverage/i)
    })

    test('regresses temporal trends on actual UTC elapsed days', () => {
        const trend = computeLinearTrend([
            { time: '2024-01-01', mean: 0 },
            { time: '2024-01-03', mean: 2 },
            { time: '2024-01-10', mean: 9 },
        ])
        expect(trend.slope).toBeCloseTo(1, 8)
        expect(trend.slopeUnit).toBe('value per day')
        expect(trend.rSquared).toBeCloseTo(1, 8)
    })

    test('rejects unsupported spatial analysis types instead of silently running Moran', () => {
        expect(resolveSpatialAnalysisType('moran')).toEqual({
            ok: true,
            analysisType: 'moran',
        })
        expect(resolveSpatialAnalysisType('Ripley K')).toMatchObject({
            ok: false,
            errorCode: 'UNSUPPORTED_SPATIAL_ANALYSIS_TYPE',
        })
    })

    test('formatters contain no unsupported inferential statistics claims', () => {
        expect(ADVANCED_SOURCE).not.toContain('t-statistic:')
        expect(ADVANCED_SOURCE).not.toMatch(/\(p\s*</i)
        expect(ADVANCED_SOURCE).not.toContain('Significance:')
        expect(ADVANCED_SOURCE).toContain('Descriptive trend strength:')
        expect(ADVANCED_SOURCE).toContain(
            'No p-value or significance test was calculated'
        )
        expect(ADVANCED_SOURCE).toContain('validValueByIndex')
        expect(ADVANCED_SOURCE).not.toContain('rawData[sourceIndex]')
    })
})
