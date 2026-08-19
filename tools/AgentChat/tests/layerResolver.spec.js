import { test, expect } from '@playwright/test'
import { resolveLayerSelection } from '../layerResolver'

const FIXTURE_LAYERS = [
    {
        id: 'c44a81f4-0b76-427b-8636-5e9786d8666a',
        displayName: 'SWOT binned Freeboard',
        canonical: 'SWOT binned Freeboard',
        aliases: [
            'SWOT binned Freeboard',
            'SWOT freeboard',
            'SWOT binned Freeboard layer',
        ],
        groupPath: 'Script 1 - Research',
        tags: ['swot', 'freeboard'],
        datasetId: 'swot_bin_freeboard',
        visible: false,
    },
    {
        id: 'efaca54b-6861-48ee-8a03-cbc0a4d8591b',
        displayName: 'Sea Ice Concentration',
        canonical: 'Sea Ice Concentration',
        aliases: ['sea ice concentration', 'seaice'],
        groupPath: 'Script 1 - Research',
        tags: ['sea ice', 'concentration'],
        datasetId: 'amsru2_seaice_12km',
        visible: false,
    },
    {
        id: 'f579e8bf-1b24-4bc2-a805-b55913daf0f6',
        displayName: 'ICESAT-2 binned Freeboard',
        canonical: 'ICESAT-2 binned Freeboard',
        aliases: ['ICESAT-2 freeboard', 'ICESat freeboard'],
        groupPath: 'Script 1 - Research',
        tags: ['freeboard'],
        datasetId: 'icesat2_freeboard',
        visible: false,
    },
]

const ROLE_LAYERS = [
    {
        id: 'prediction-layer',
        displayName: 'SFNO Prediction Daily 10 km 2022-2024',
        canonical: 'SFNO Prediction Daily 10 km 2022-2024',
        visible: true,
    },
    {
        id: 'ground-truth-layer',
        displayName: 'SFNO Ground Truth Daily 10 km 2022-2024',
        canonical: 'SFNO Ground Truth Daily 10 km 2022-2024',
        visible: false,
    },
]

test.describe('@unit AgentChat layerResolver', () => {
    test('resolves SWOT binned Freeboard to SWOT UUID', () => {
        const result = resolveLayerSelection({
            requestedName: 'SWOT binned Freeboard',
            userQuery: 'Turn on SWOT binned Freeboard',
            layers: FIXTURE_LAYERS,
        })

        expect(result.ambiguous).not.toBe(true)
        expect(result.match?.uuid).toBe('c44a81f4-0b76-427b-8636-5e9786d8666a')
    })

    test('resolves SWOT sea ice freeboard phrasing to SWOT UUID', () => {
        const result = resolveLayerSelection({
            requestedName: 'SWOT sea ice freeboard',
            userQuery: 'Turn on SWOT sea ice freeboard',
            layers: FIXTURE_LAYERS,
        })

        expect(result.ambiguous).not.toBe(true)
        expect(result.match?.uuid).toBe('c44a81f4-0b76-427b-8636-5e9786d8666a')
    })

    test('resolves seaice to sea ice UUID', () => {
        const result = resolveLayerSelection({
            requestedName: 'seaice',
            userQuery: 'Turn on seaice',
            layers: FIXTURE_LAYERS,
        })

        expect(result.ambiguous).not.toBe(true)
        expect(result.match?.uuid).toBe('efaca54b-6861-48ee-8a03-cbc0a4d8591b')
    })

    test('grounds prediction and ground-truth roles without exact display names', () => {
        const liveShapeLayers = [
            ...ROLE_LAYERS,
            {
                id: 'forecast-header',
                displayName: 'Ice Forecast',
                canonical: 'Ice Forecast',
                config: { type: 'header' },
            },
            {
                id: 'reference-imagery',
                displayName: 'GIBS MODIS True Color',
                canonical: 'GIBS MODIS True Color',
                groupPath: 'Ice Forecast',
                description: 'Reference backdrop for prediction products',
            },
        ]
        const prediction = resolveLayerSelection({
            requestedName: 'predicted',
            userQuery:
                'Show the difference between predicted and ground truth ice',
            layers: liveShapeLayers,
        })
        const truth = resolveLayerSelection({
            requestedName: 'ground truth ice',
            userQuery:
                'Show the difference between predicted and ground truth ice',
            layers: liveShapeLayers,
        })

        expect(prediction.ambiguous).not.toBe(true)
        expect(prediction.match?.uuid).toBe('prediction-layer')
        expect(truth.ambiguous).not.toBe(true)
        expect(truth.match?.uuid).toBe('ground-truth-layer')
    })

    test('asks for clarification when multiple layers share a broad semantic role', () => {
        const result = resolveLayerSelection({
            requestedName: 'prediction',
            userQuery: 'Compare the prediction with ground truth',
            layers: [
                ...ROLE_LAYERS,
                {
                    id: 'second-prediction-layer',
                    displayName: 'Regional Prediction Daily',
                    canonical: 'Regional Prediction Daily',
                    visible: false,
                },
            ],
        })

        expect(result.match).toBeNull()
        expect(result.ambiguous).toBe(true)
        expect(result.candidates).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: 'prediction-layer' }),
                expect.objectContaining({ id: 'second-prediction-layer' }),
            ])
        )
    })
})
