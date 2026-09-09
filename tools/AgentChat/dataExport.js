// Data Export Functions for MMGIS Copilot
// Provides data export capabilities for external analysis

import { 
    findLayerMatch,
    resolveArea,
    createAreaUnresolvedError,
} from './rendererUtils.js'
import { sampleRaster } from './localAnalytics.js'

/**
 * Export layer data in various formats
 */
export async function exportLayerData(layerName, options = {}) {
    const {
        format = 'csv',
        area = 'current view',
        timeRange = null,
        includeMetadata = true,
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
        throw createAreaUnresolvedError(area)
    }
    
    if (format.toLowerCase() === 'netcdf') {
        throw new Error(
            'NetCDF export is not available in the browser because no registered exporter can produce a standards-compliant NetCDF file. Choose CSV, GeoJSON, KML, or JSON.'
        )
    }

    const maxPixelsByResolution = {
        full: 100000,
        medium: 25000,
        low: 5000,
    }
    const sampled = await sampleRaster(layerMatch, resolvedArea, {
        includeCoordinates: true,
        maxPixels: maxPixelsByResolution[resolution] || 25000,
        startTime: timeRange?.start || null,
        endTime: timeRange?.end || null,
    })
    const config = layerMatch?.layer?.config || {}
    const declaredUnit =
        config.cogUnits ||
        config.units ||
        config.unit ||
        config.metadata?.units ||
        config.analysis?.units ||
        ''
    const unit =
        typeof declaredUnit === 'string' ? declaredUnit.trim() : ''
    const timestamp =
        timeRange?.end ||
        layerMatch?.layer?.liveInstance?.options?.time ||
        null
    const data = (sampled.samples || []).map((sample) => ({
        lon: sample.lon,
        lat: sample.lat,
        value: sample.value,
        ...(unit ? { unit } : {}),
        timestamp,
    }))
    if (!data.length) {
        throw new Error('No real scalar samples were available to export.')
    }
    
    // Format data based on requested format
    let exportedData
    switch (format.toLowerCase()) {
        case 'csv':
            exportedData = exportAsCSV(data, layerMatch, resolvedArea, includeMetadata)
            break
        case 'geojson':
            exportedData = exportAsGeoJSON(data, layerMatch, resolvedArea, includeMetadata)
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
    const normalizedFormat = format.toLowerCase()
    const downloadInfo = createDownload(
        exportedData,
        normalizedFormat,
        layerMatch.displayName
    )
    
    return {
        layerName: layerMatch.displayName,
        format: normalizedFormat,
        area: resolvedArea.label,
        bbox: resolvedArea.bbox,
        resolution,
        dataPoints: data.length,
        fileSize: exportedData.length,
        downloadInfo,
        status: 'ready',
        source: 'local-cog',
        unit: unit || null,
    }
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
        lines.push(`${point.lon.toFixed(6)},${point.lat.toFixed(6)},${point.value.toFixed(3)},${point.unit || ''},${point.timestamp || ''}`)
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
 * Export data as KML
 */
function exportAsKML(data, layerMatch, area) {
    const kmlPoints = data.map(point => `
        <Placemark>
            <name>${point.value.toFixed(4)}${point.unit ? ` ${point.unit}` : ''}</name>
            <description>${layerMatch.displayName}: ${point.value}${point.unit ? ` ${point.unit}` : ''}</description>
            <Point>
                <coordinates>${point.lon},${point.lat},0</coordinates>
            </Point>
            <ExtendedData>
                <Data name="value">
                    <value>${point.value}</value>
                </Data>
                ${point.unit ? `<Data name="unit"><value>${point.unit}</value></Data>` : ''}
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
        }
        const declaredUnit = data.find((point) => point.unit)?.unit
        if (declaredUnit) output.metadata.units = declaredUnit
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
        'kml': 'application/vnd.google-earth.kml+xml'
    }
    
    const extensions = {
        'csv': 'csv',
        'json': 'json',
        'geojson': 'geojson',
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
