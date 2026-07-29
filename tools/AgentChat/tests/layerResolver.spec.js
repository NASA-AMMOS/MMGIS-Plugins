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

test.describe('AgentChat layerResolver', () => {
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
})
