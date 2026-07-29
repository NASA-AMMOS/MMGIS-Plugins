/**
 * Real Raster Difference Calculation Module
 * Computes actual pixel-by-pixel differences between two raster layers
 */

import * as GeoTIFF from 'geotiff';

// Configuration
const TILE_SIZE = 256;
const MAX_PIXELS_TO_PROCESS = 1000000; // Limit for browser performance
const DIFFERENCE_COLOR_RAMP = {
    negative: { high: [139, 0, 0], low: [255, 200, 200] },     // Red for negative
    positive: { low: [200, 200, 255], high: [0, 0, 139] },     // Blue for positive
    zero: [255, 255, 255]                                       // White for zero
};

/**
 * Main entry point for layer difference calculation
 */
export async function calculateRealLayerDifference(layerA, layerB, options = {}) {
    const {
        area = getCurrentViewportBounds(),
        resolution = 'auto',
        includeStats = true,
        includeVisualization = true
    } = options;
    
    try {
        // Step 1: Load raster data for both layers
        const [dataA, dataB] = await Promise.all([
            loadRasterData(layerA, area, resolution),
            loadRasterData(layerB, area, resolution)
        ]);

        // Step 2: Align and resample data to common grid
        const [alignedA, alignedB] = alignRasterData(dataA, dataB);

        // Step 3: Calculate pixel-by-pixel difference
        const differenceData = computeDifference(alignedA, alignedB);

        // Step 4: Calculate statistics
        let stats = null;
        if (includeStats) {
            stats = calculateDifferenceStats(differenceData);
        }

        // Step 5: Generate visualization
        let visualization = null;
        if (includeVisualization) {
            visualization = generateDifferenceVisualization(differenceData, stats);
        }
        
        return {
            difference: differenceData,
            statistics: stats,
            visualization: visualization,
            metadata: {
                layerA: layerA.displayName,
                layerB: layerB.displayName,
                pixelCount: differenceData.validPixels,
                bounds: area,
                timestamp: new Date().toISOString()
            }
        };
        
    } catch (error) {
        console.error('Failed to calculate layer difference:', error);
        throw new Error(`Layer difference calculation failed: ${error.message}`);
    }
}

/**
 * Load raster data from a layer's COG source
 */
async function loadRasterData(layer, bounds, resolution) {
    // Extract COG URL from layer configuration
    const cogUrl = getCOGUrl(layer);
    if (!cogUrl) {
        throw new Error(`No COG source found for layer ${layer.displayName}`);
    }
    
    // Determine appropriate resolution
    const targetResolution = resolution === 'auto' 
        ? calculateOptimalResolution(bounds)
        : resolution;
    
    try {
        // Fetch COG metadata
        const tiff = await GeoTIFF.fromUrl(cogUrl);
        const image = await tiff.getImage();
        
        // Get image metadata
        const bbox = image.getBoundingBox();
        const width = image.getWidth();
        const height = image.getHeight();
        
        // Calculate window to read based on bounds
        const window = calculateReadWindow(bbox, bounds, width, height);
        
        // Read raster data for the window
        const rasters = await image.readRasters({
            window: window,
            samples: [0], // First band
            interleave: false
        });
        
        return {
            data: rasters[0],
            width: window[2] - window[0],
            height: window[3] - window[1],
            bounds: bounds,
            noDataValue: image.getGDALNoData(),
            geoTransform: calculateGeoTransform(bbox, width, height)
        };
        
    } catch (error) {
        console.error(`Failed to load raster data from ${cogUrl}:`, error);
        throw error;
    }
}

/**
 * Extract COG URL from layer configuration
 */
function getCOGUrl(layer) {
    const config = layer.config || layer;
    return config.cogUrl || 
           config.url || 
           config.source || 
           config.path || 
           config.href ||
           layer.liveInstance?.cogUrl ||
           layer.liveInstance?.options?.url;
}

/**
 * Calculate optimal resolution based on viewport
 */
function calculateOptimalResolution(bounds) {
    const [west, south, east, north] = bounds;
    const width = east - west;
    const height = north - south;
    
    // Aim for ~500x500 pixels for performance
    const targetPixels = 500;
    const resolution = Math.max(width / targetPixels, height / targetPixels);
    
    return resolution;
}

/**
 * Calculate window to read from raster
 */
function calculateReadWindow(imageBbox, targetBounds, imageWidth, imageHeight) {
    const [imgWest, imgSouth, imgEast, imgNorth] = imageBbox;
    const [tgtWest, tgtSouth, tgtEast, tgtNorth] = targetBounds;
    
    // Calculate pixel coordinates
    const pixelWidth = (imgEast - imgWest) / imageWidth;
    const pixelHeight = (imgNorth - imgSouth) / imageHeight;
    
    const minX = Math.max(0, Math.floor((tgtWest - imgWest) / pixelWidth));
    const maxX = Math.min(imageWidth, Math.ceil((tgtEast - imgWest) / pixelWidth));
    const minY = Math.max(0, Math.floor((imgNorth - tgtNorth) / pixelHeight));
    const maxY = Math.min(imageHeight, Math.ceil((imgNorth - tgtSouth) / pixelHeight));
    
    return [minX, minY, maxX, maxY];
}

/**
 * Calculate geotransform for georeferencing
 */
function calculateGeoTransform(bbox, width, height) {
    const [west, south, east, north] = bbox;
    return {
        xOrigin: west,
        yOrigin: north,
        pixelWidth: (east - west) / width,
        pixelHeight: -(north - south) / height,
        rotation: 0
    };
}

/**
 * Align two raster datasets to common grid
 */
function alignRasterData(dataA, dataB) {
    // If dimensions match, no alignment needed
    if (dataA.width === dataB.width && dataA.height === dataB.height &&
        JSON.stringify(dataA.bounds) === JSON.stringify(dataB.bounds)) {
        return [dataA, dataB];
    }
    
    // Determine common grid
    const commonBounds = [
        Math.max(dataA.bounds[0], dataB.bounds[0]), // west
        Math.max(dataA.bounds[1], dataB.bounds[1]), // south
        Math.min(dataA.bounds[2], dataB.bounds[2]), // east
        Math.min(dataA.bounds[3], dataB.bounds[3])  // north
    ];
    
    // Use finer resolution
    const commonWidth = Math.max(dataA.width, dataB.width);
    const commonHeight = Math.max(dataA.height, dataB.height);
    
    // Resample both datasets to common grid
    const alignedA = resampleRaster(dataA, commonBounds, commonWidth, commonHeight);
    const alignedB = resampleRaster(dataB, commonBounds, commonWidth, commonHeight);
    
    return [alignedA, alignedB];
}

/**
 * Resample raster to new dimensions using bilinear interpolation
 */
function resampleRaster(rasterData, newBounds, newWidth, newHeight) {
    const resampled = new Float32Array(newWidth * newHeight);
    const noData = rasterData.noDataValue || -9999;
    
    for (let y = 0; y < newHeight; y++) {
        for (let x = 0; x < newWidth; x++) {
            // Calculate geographic position
            const lon = newBounds[0] + (x / newWidth) * (newBounds[2] - newBounds[0]);
            const lat = newBounds[3] - (y / newHeight) * (newBounds[3] - newBounds[1]);
            
            // Find corresponding pixel in original raster
            const srcX = ((lon - rasterData.bounds[0]) / 
                         (rasterData.bounds[2] - rasterData.bounds[0])) * rasterData.width;
            const srcY = ((rasterData.bounds[3] - lat) / 
                         (rasterData.bounds[3] - rasterData.bounds[1])) * rasterData.height;
            
            // Bilinear interpolation
            const value = bilinearInterpolate(rasterData.data, 
                                             srcX, srcY, 
                                             rasterData.width, 
                                             rasterData.height,
                                             noData);
            
            resampled[y * newWidth + x] = value;
        }
    }
    
    return {
        ...rasterData,
        data: resampled,
        width: newWidth,
        height: newHeight,
        bounds: newBounds
    };
}

/**
 * Bilinear interpolation for resampling
 */
function bilinearInterpolate(data, x, y, width, height, noData) {
    const x0 = Math.floor(x);
    const x1 = Math.min(x0 + 1, width - 1);
    const y0 = Math.floor(y);
    const y1 = Math.min(y0 + 1, height - 1);
    
    const fx = x - x0;
    const fy = y - y0;
    
    const v00 = data[y0 * width + x0];
    const v10 = data[y0 * width + x1];
    const v01 = data[y1 * width + x0];
    const v11 = data[y1 * width + x1];
    
    // Handle NoData
    if (v00 === noData || v10 === noData || v01 === noData || v11 === noData) {
        return noData;
    }
    
    const v0 = v00 * (1 - fx) + v10 * fx;
    const v1 = v01 * (1 - fx) + v11 * fx;
    
    return v0 * (1 - fy) + v1 * fy;
}

/**
 * Compute pixel-by-pixel difference
 */
function computeDifference(alignedA, alignedB) {
    const width = alignedA.width;
    const height = alignedA.height;
    const difference = new Float32Array(width * height);
    const noDataA = alignedA.noDataValue || -9999;
    const noDataB = alignedB.noDataValue || -9999;
    const noDataDiff = -9999;
    
    let validPixels = 0;
    
    for (let i = 0; i < difference.length; i++) {
        const a = alignedA.data[i];
        const b = alignedB.data[i];
        
        if (a === noDataA || b === noDataB || !isFinite(a) || !isFinite(b)) {
            difference[i] = noDataDiff;
        } else {
            difference[i] = a - b;
            validPixels++;
        }
    }
    
    return {
        data: difference,
        width: width,
        height: height,
        bounds: alignedA.bounds,
        noDataValue: noDataDiff,
        validPixels: validPixels
    };
}

/**
 * Calculate statistics for difference data
 */
function calculateDifferenceStats(differenceData) {
    const data = differenceData.data;
    const noData = differenceData.noDataValue;
    
    let sum = 0;
    let sumSquares = 0;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    const values = [];
    
    for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (value !== noData && isFinite(value)) {
            sum += value;
            sumSquares += value * value;
            min = Math.min(min, value);
            max = Math.max(max, value);
            count++;
            values.push(value);
        }
    }
    
    if (count === 0) {
        return {
            mean: null,
            std: null,
            min: null,
            max: null,
            median: null,
            validCount: 0,
            percentiles: {}
        };
    }
    
    const mean = sum / count;
    const variance = (sumSquares / count) - (mean * mean);
    const std = Math.sqrt(Math.max(0, variance));
    
    // Calculate percentiles
    values.sort((a, b) => a - b);
    const percentiles = {
        5: values[Math.floor(count * 0.05)],
        25: values[Math.floor(count * 0.25)],
        50: values[Math.floor(count * 0.50)], // median
        75: values[Math.floor(count * 0.75)],
        95: values[Math.floor(count * 0.95)]
    };
    
    return {
        mean: mean,
        std: std,
        min: min,
        max: max,
        median: percentiles[50],
        validCount: count,
        totalCount: data.length,
        coveragePercent: (count / data.length) * 100,
        percentiles: percentiles,
        histogram: calculateHistogram(values, 20)
    };
}

/**
 * Calculate histogram for values
 */
function calculateHistogram(values, numBins) {
    if (values.length === 0) return null;
    
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binWidth = (max - min) / numBins;
    
    const histogram = {
        bins: new Array(numBins).fill(0),
        edges: [],
        binWidth: binWidth
    };
    
    // Calculate bin edges
    for (let i = 0; i <= numBins; i++) {
        histogram.edges.push(min + i * binWidth);
    }
    
    // Count values in each bin
    for (const value of values) {
        const binIndex = Math.min(
            Math.floor((value - min) / binWidth),
            numBins - 1
        );
        histogram.bins[binIndex]++;
    }
    
    return histogram;
}

/**
 * Generate visualization overlay for difference
 */
function generateDifferenceVisualization(differenceData, stats) {
    const width = differenceData.width;
    const height = differenceData.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    const pixels = imageData.data;
    
    const noData = differenceData.noDataValue;
    const data = differenceData.data;
    
    // Use 2 std deviations for color scaling
    const scale = stats ? 2 * stats.std : 1;
    const center = stats ? stats.mean : 0;
    
    for (let i = 0; i < data.length; i++) {
        const value = data[i];
        const pixelIndex = i * 4;
        
        if (value === noData || !isFinite(value)) {
            // Transparent for NoData
            pixels[pixelIndex] = 0;
            pixels[pixelIndex + 1] = 0;
            pixels[pixelIndex + 2] = 0;
            pixels[pixelIndex + 3] = 0;
        } else {
            // Calculate normalized value (-1 to 1)
            const normalized = Math.max(-1, Math.min(1, (value - center) / scale));
            
            // Apply color ramp
            const color = getColorForValue(normalized);
            pixels[pixelIndex] = color[0];
            pixels[pixelIndex + 1] = color[1];
            pixels[pixelIndex + 2] = color[2];
            pixels[pixelIndex + 3] = 200; // Semi-transparent
        }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    return {
        canvas: canvas,
        dataUrl: canvas.toDataURL('image/png'),
        bounds: differenceData.bounds,
        colorScale: {
            min: center - scale,
            max: center + scale,
            center: center
        }
    };
}

/**
 * Get color for normalized value using diverging color ramp
 */
function getColorForValue(normalized) {
    if (Math.abs(normalized) < 0.01) {
        return DIFFERENCE_COLOR_RAMP.zero;
    }
    
    if (normalized < 0) {
        // Negative - use red ramp
        const t = Math.abs(normalized);
        const low = DIFFERENCE_COLOR_RAMP.negative.low;
        const high = DIFFERENCE_COLOR_RAMP.negative.high;
        return interpolateColor(low, high, t);
    } else {
        // Positive - use blue ramp
        const t = normalized;
        const low = DIFFERENCE_COLOR_RAMP.positive.low;
        const high = DIFFERENCE_COLOR_RAMP.positive.high;
        return interpolateColor(low, high, t);
    }
}

/**
 * Interpolate between two colors
 */
function interpolateColor(color1, color2, t) {
    return [
        Math.round(color1[0] + (color2[0] - color1[0]) * t),
        Math.round(color1[1] + (color2[1] - color1[1]) * t),
        Math.round(color1[2] + (color2[2] - color1[2]) * t)
    ];
}

/**
 * Get current viewport bounds
 */
function getCurrentViewportBounds() {
    if (window.mmgisAPI && window.mmgisAPI.map) {
        const bounds = window.mmgisAPI.map.getBounds();
        return [
            bounds.getWest(),
            bounds.getSouth(),
            bounds.getEast(),
            bounds.getNorth()
        ];
    }
    // Default bounds
    return [-180, -90, 180, 90];
}

// Export for use in renderers.js
export default {
    calculateRealLayerDifference,
    calculateDifferenceStats,
    generateDifferenceVisualization
};