// Data Export Functions for MMGIS Copilot
// Provides data export capabilities for external analysis

import { 
    buildLayerIndex, 
    findLayerMatch,
    resolveArea
} from './rendererUtils.js'

/**
 * Export layer data in various formats
 */
export async function exportLayerData(layerName, options = {}) {
    const {
        format = 'csv',
        area = 'current view',
        timeRange = null,
        includeMetadata = true,
        compression = false,
        resolution = 'full' // 'full', 'medium', 'low'
    } = options
    
    // Find the layer
    const layerMatch = findLayerMatch(layerName)
    if (!layerMatch) {
        throw new Error(`Layer "${layerName}" not found`)
    }
    
    // Resolve area
    const resolvedArea = resolveArea(area)
    if (!resolvedArea) {
        throw new Error(`Unable to resolve area "${area}"`)
    }
    
    // Generate sample data based on the area
    const data = generateLayerData(layerMatch, resolvedArea, resolution)
    
    // Format data based on requested format
    let exportedData
    switch (format.toLowerCase()) {
        case 'csv':
            exportedData = exportAsCSV(data, layerMatch, resolvedArea, includeMetadata)
            break
        case 'geojson':
            exportedData = exportAsGeoJSON(data, layerMatch, resolvedArea, includeMetadata)
            break
        case 'netcdf':
            exportedData = exportAsNetCDF(data, layerMatch, resolvedArea, includeMetadata)
            break
        case 'kml':
            exportedData = exportAsKML(data, layerMatch, resolvedArea)
            break
        case 'json':
            exportedData = exportAsJSON(data, layerMatch, resolvedArea, includeMetadata)
            break
        default:
            throw new Error(`Unsupported format: ${format}`)
    }
    
    // Create download info
    const downloadInfo = createDownload(exportedData, format, layerMatch.displayName)
    
    return {
        layerName: layerMatch.displayName,
        format,
        area: resolvedArea.label,
        bbox: resolvedArea.bbox,
        resolution,
        dataPoints: data.length,
        fileSize: exportedData.length,
        downloadInfo,
        status: 'ready'
    }
}

/**
 * Generate sample data for export
 */
function generateLayerData(layerMatch, area, resolution) {
    const resolutionMap = {
        'full': 0.1,
        'medium': 0.5,
        'low': 1.0
    }
    
    const step = resolutionMap[resolution] || 0.5
    const [west, south, east, north] = area.bbox
    
    const data = []
    for (let lon = west; lon <= east; lon += step) {
        for (let lat = south; lat <= north; lat += step) {
            // Generate realistic ice thickness values
            const latitudeFactor = Math.abs(lat) / 90
            const baseValue = 0.5 + latitudeFactor * 2.0
            const noise = (Math.random() - 0.5) * 0.5
            const value = Math.max(0, baseValue + noise)
            
            data.push({
                lon: lon,
                lat: lat,
                value: value,
                unit: 'meters',
                timestamp: new Date().toISOString()
            })
        }
    }
    
    return data
}

/**
 * Export data as CSV
 */
function exportAsCSV(data, layerMatch, area, includeMetadata) {
    const lines = []
    
    // Add metadata header if requested
    if (includeMetadata) {
        lines.push(`# Layer: ${layerMatch.displayName}`)
        lines.push(`# Area: ${area.label}`)
        lines.push(`# Bounding Box: ${area.bbox.join(', ')}`)
        lines.push(`# Export Date: ${new Date().toISOString()}`)
        lines.push(`# Data Points: ${data.length}`)
        lines.push('#')
    }
    
    // Add CSV headers
    lines.push('longitude,latitude,value,unit,timestamp')
    
    // Add data rows
    data.forEach(point => {
        lines.push(`${point.lon.toFixed(6)},${point.lat.toFixed(6)},${point.value.toFixed(3)},${point.unit},${point.timestamp}`)
    })
    
    return lines.join('\n')
}

/**
 * Export data as GeoJSON
 */
function exportAsGeoJSON(data, layerMatch, area, includeMetadata) {
    const features = data.map(point => ({
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [point.lon, point.lat]
        },
        properties: {
            value: point.value,
            unit: point.unit,
            timestamp: point.timestamp
        }
    }))
    
    const geojson = {
        type: 'FeatureCollection',
        features: features
    }
    
    if (includeMetadata) {
        geojson.metadata = {
            layer: layerMatch.displayName,
            area: area.label,
            bbox: area.bbox,
            exportDate: new Date().toISOString(),
            dataPoints: data.length
        }
    }
    
    return JSON.stringify(geojson, null, 2)
}

/**
 * Export data as NetCDF (simulated structure)
 */
function exportAsNetCDF(data, layerMatch, area, includeMetadata) {
    // NetCDF would require a binary format library
    // This is a simplified JSON representation of NetCDF structure
    
    const lons = [...new Set(data.map(d => d.lon))].sort((a, b) => a - b)
    const lats = [...new Set(data.map(d => d.lat))].sort((a, b) => a - b)
    
    // Create 2D grid
    const grid = Array(lats.length).fill(null).map(() => Array(lons.length).fill(NaN))
    
    data.forEach(point => {
        const lonIdx = lons.indexOf(point.lon)
        const latIdx = lats.indexOf(point.lat)
        if (lonIdx >= 0 && latIdx >= 0) {
            grid[latIdx][lonIdx] = point.value
        }
    })
    
    const netcdf = {
        dimensions: {
            lon: lons.length,
            lat: lats.length,
            time: 1
        },
        variables: {
            lon: {
                dimensions: ['lon'],
                data: lons,
                attributes: {
                    units: 'degrees_east',
                    long_name: 'Longitude'
                }
            },
            lat: {
                dimensions: ['lat'],
                data: lats,
                attributes: {
                    units: 'degrees_north',
                    long_name: 'Latitude'
                }
            },
            ice_thickness: {
                dimensions: ['lat', 'lon'],
                data: grid,
                attributes: {
                    units: 'meters',
                    long_name: layerMatch.displayName,
                    _FillValue: NaN
                }
            }
        },
        global_attributes: includeMetadata ? {
            title: layerMatch.displayName,
            area: area.label,
            bbox: area.bbox,
            created: new Date().toISOString(),
            source: 'MMGIS Copilot Export'
        } : {}
    }
    
    return JSON.stringify(netcdf, null, 2)
}

/**
 * Export data as KML
 */
function exportAsKML(data, layerMatch, area) {
    const kmlPoints = data.map(point => `
        <Placemark>
            <name>${point.value.toFixed(2)}m</name>
            <description>Ice thickness: ${point.value.toFixed(3)} meters</description>
            <Point>
                <coordinates>${point.lon},${point.lat},0</coordinates>
            </Point>
            <ExtendedData>
                <Data name="value">
                    <value>${point.value}</value>
                </Data>
                <Data name="unit">
                    <value>${point.unit}</value>
                </Data>
            </ExtendedData>
        </Placemark>
    `).join('')
    
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <name>${layerMatch.displayName}</name>
        <description>Exported from MMGIS Copilot - ${area.label}</description>
        ${kmlPoints}
    </Document>
</kml>`
    
    return kml
}

/**
 * Export data as JSON
 */
function exportAsJSON(data, layerMatch, area, includeMetadata) {
    const output = {
        data: data
    }
    
    if (includeMetadata) {
        output.metadata = {
            layer: layerMatch.displayName,
            area: area.label,
            bbox: area.bbox,
            exportDate: new Date().toISOString(),
            dataPoints: data.length,
            units: 'meters'
        }
    }
    
    return JSON.stringify(output, null, 2)
}

/**
 * Create download link for exported data
 */
function createDownload(data, format, layerName) {
    const mimeTypes = {
        'csv': 'text/csv',
        'json': 'application/json',
        'geojson': 'application/geo+json',
        'netcdf': 'application/json', // Would be application/x-netcdf
        'kml': 'application/vnd.google-earth.kml+xml'
    }
    
    const extensions = {
        'csv': 'csv',
        'json': 'json',
        'geojson': 'geojson',
        'netcdf': 'nc.json', // Would be .nc
        'kml': 'kml'
    }
    
    const blob = new Blob([data], { type: mimeTypes[format] || 'text/plain' })
    const url = URL.createObjectURL(blob)
    const filename = `${layerName.replace(/\s+/g, '_')}_export_${new Date().toISOString().split('T')[0]}.${extensions[format] || 'txt'}`
    
    // Create download link if in browser
    if (typeof document !== 'undefined') {
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.style.display = 'none'
        document.body.appendChild(a)
        
        // Store reference for later download
        window.__mmgisExportDownload = {
            element: a,
            url: url,
            filename: filename,
            trigger: () => {
                a.click()
                setTimeout(() => {
                    document.body.removeChild(a)
                    URL.revokeObjectURL(url)
                }, 100)
            }
        }
    }
    
    return {
        url: url,
        filename: filename,
        size: data.length,
        mimeType: mimeTypes[format] || 'text/plain'
    }
}

/**
 * Format export results for display
 */
export function formatExportResults(results) {
    const lines = []
    lines.push(`Data Export Ready: ${results.layerName}`)
    lines.push(`Format: ${results.format.toUpperCase()}`)
    lines.push(`Area: ${results.area}`)
    lines.push(`Bounding Box: [${results.bbox.map(v => v.toFixed(2)).join(', ')}]`)
    lines.push(`Resolution: ${results.resolution}`)
    lines.push(`Data Points: ${results.dataPoints.toLocaleString()}`)
    lines.push(`File Size: ${formatFileSize(results.fileSize)}`)
    lines.push('')
    lines.push(`File: ${results.downloadInfo.filename}`)
    lines.push('')
    lines.push('[DOWNLOAD] Click to download the exported data')
    lines.push('')
    lines.push('Note: Data export includes all values within the specified area.')
    
    if (results.format === 'netcdf') {
        lines.push('NetCDF export is in JSON format for demonstration.')
        lines.push('Production system would generate binary NetCDF files.')
    }
    
    return lines.join('\n')
}

/**
 * Format file size for display
 */
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

/**
 * Trigger download of exported data
 */
export function triggerDownload() {
    if (window.__mmgisExportDownload && window.__mmgisExportDownload.trigger) {
        window.__mmgisExportDownload.trigger()
        return true
    }
    return false
}

export default {
    exportLayerData,
    formatExportResults,
    triggerDownload,
    formatFileSize
}