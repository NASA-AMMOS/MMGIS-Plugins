import $ from 'jquery'
import './MapJobSubmitTool.css'
import L_ from '@basics/Layers_/Layers_'
import Map_ from '@basics/Map_/Map_'
import ToolController_ from '@basics/ToolController_/ToolController_'

// Import utility modules with wildcard syntax
import * as Utils from './utils.js'
import * as API from './api.js'
import * as LayerManager from './layerManager.js'
import * as UI from './ui.js'

// mmgisAPI is intentionally accessed via window.mmgisAPI at call time rather
// than imported at module top. Importing it here creates a cycle through
// src/pre/tools.js → MapJobSubmitTool → mmgisAPI → LayerUtils that fails with
// "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization."

const VECTOR_EXTS = ['geojson', 'json', 'gpkg', 'kml']
const DEFAULT_POLL_INTERVAL_MS = 30000
const PAGE_SIZE = 10

// Local aliases to the extracted helper modules — kept so the bulk of this
// file (written before the utils.js/api.js/layerManager.js split) doesn't
// need every call site rewritten. Definitions live in the imported modules;
// no logic is duplicated here.
const { LAT_VARIATIONS, LON_VARIATIONS } =
    Utils
const normalizeInputKey = Utils.normalizeInputKey
const containsBboxVariation = Utils.containsBboxVariation
const containsLatLonCombo = Utils.containsLatLonCombo
const escapeHTML = Utils.escapeHTML
const sanitizeInput = Utils.sanitizeInput
const sanitizeToken = Utils.sanitizeToken
const normalizeStatus = Utils.normalizeStatus
const isTerminal = Utils.isTerminal
const isFilePathValue = Utils.isFilePathValue
const isStacItemUrl = Utils.isStacItemUrl
const urlsFromString = Utils.urlsFromString

function mmgisFetch(path, init) {
    return API.mmgisFetch(path, init, Workflows.personalAccessToken)
}
function verifyToken() {
    return API.verifyToken(Workflows.baseUrl, Workflows.personalAccessToken)
}
function fetchMaapUserId() {
    return API.fetchMaapUserId(
        Workflows.memberInfoUrl,
        Workflows.personalAccessToken
    )
}
function fetchProcesses() {
    return API.fetchProcesses(Workflows.baseUrl)
}
function fetchProcessDetails(processID) {
    return API.fetchProcessDetails(processID, Workflows.baseUrl)
}
function fetchResources() {
    return API.fetchResources(
        Workflows.resourcesConfig,
        Workflows.personalAccessToken
    )
}
function pollJob(jobId, getJobDetails) {
    return API.pollJob(
        jobId,
        Workflows.baseUrl,
        Workflows.personalAccessToken,
        getJobDetails
    )
}
function fetchSubmittedRegistry() {
    return API.fetchSubmittedRegistry(
        Workflows.maapUserId,
        Workflows.personalAccessToken
    )
}
function recordSubmittedJob(jobId, endpoint, payload, name) {
    return API.recordSubmittedJob(
        jobId,
        endpoint,
        payload,
        name,
        Workflows.maapUserId,
        Workflows.personalAccessToken
    )
}
function deleteJobFromDatabase(jobId) {
    return API.deleteJobFromDatabase(jobId, Workflows.personalAccessToken)
}

function removeLayerForJob(jobId, job) {
    return LayerManager.removeLayerForJob(
        jobId,
        job,
        L_,
        ToolController_,
        Workflows.renderJobs
    )
}

// Algorithms fetched from the workflows API (baseUrl + '/processes')
// Shape: { processes: [{ id, title, description, version, deployedBy, processID, ... }] }
// This global gets populated asynchronously via fetchProcesses() when the tool opens.
let PROCESSES = []

// Human-friendly label for a job's endpoint/processID. If we recognize the
// processID in our fetched PROCESSES list, return its title; otherwise prettify.
function endpointLabel(endpoint) {
    if (!endpoint) return ''
    // Try parsing as a processID integer if it looks like one
    const asInt = parseInt(endpoint, 10)
    if (!isNaN(asInt) && String(asInt) === String(endpoint)) {
        const proc = PROCESSES.find((p) => p.processID === asInt)
        if (proc) return proc.title || proc.id || `Process ${asInt}`
    }
    // Fallback: prettify the string
    return endpoint
        .replace(/^\/api\//, '')
        .replace(/_v\d+$/i, '')
        .replace(/[/_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
}

// Pull a status from the API response. Handles multiple formats:
// - OGC API standard: { status: "failed" }
// Always returned lowercase to keep CSS classes consistent.
function readStatus(body) {
    if (!body) return ''
    return Utils.normalizeStatus(
        body.status || ''
    )
}

// Collect every output URI we can find on a workflow body. Walks:
//   - stages[].products[].products[].file_uris[]  (canonical file paths)
//   - stages[].products[].products[].prod_description (URLs, e.g. STAC items)
// Also tolerates flat strings and the obvious url/uri/href keys.
function extractOutputUris(body) {
    const uris = []
    const push = (u) => {
        if (typeof u === 'string' && u) uris.push(u)
    }
    if (!body || typeof body !== 'object') return uris
    push(body.output_uri)
    if (Array.isArray(body.output_uris)) body.output_uris.forEach(push)
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (const stage of stages) {
        if (!stage || !Array.isArray(stage.products)) continue
        for (const outer of stage.products) {
            if (!outer) continue
            if (typeof outer === 'string') {
                push(outer)
                continue
            }
            const inner = Array.isArray(outer.products)
                ? outer.products
                : [outer]
            for (const item of inner) {
                if (!item) continue
                if (typeof item === 'string') {
                    push(item)
                    continue
                }
                if (Array.isArray(item.file_uris))
                    item.file_uris.forEach(push)
                push(item.url)
                push(item.uri)
                push(item.href)
                push(item.path)
                urlsFromString(item.prod_description).forEach(push)
            }
        }
    }
    // Dedupe while preserving first-seen order.
    return Array.from(new Set(uris))
}

// Pick the first URI we can actually load as a map layer, in preference order:
//   1. STAC item URLs (MMGIS's own stac-item: prefix handles COG/vector)
//   2. HTTP/HTTPS URLs with a vector extension (geojson/gpkg/kml/json)
//   3. WFS GetFeature URLs returning GeoJSON (heuristic on query string)
// s3://, file://, and non-viewable formats are shown in the panel but not
// auto-added.
function findAutoAddableUri(uris) {
    // Pass 1: STAC items.
    for (const u of uris) {
        if (isStacItemUrl(u)) return u
    }
    // Pass 2: HTTP vector files.
    for (const u of uris) {
        if (!/^https?:\/\//i.test(u)) continue
        const ext = (u.split('?')[0].split('.').pop() || '').toLowerCase()
        if (VECTOR_EXTS.includes(ext)) return u
    }
    // Pass 3: WFS GeoJSON.
    for (const u of uris) {
        if (
            /^https?:\/\//i.test(u) &&
            /GetFeature/i.test(u) &&
            /outputFormat=(application(\/|%2F)json|json)/i.test(u)
        )
            return u
    }
    return null
}

// Friendly endpoint label: prefer what we locally knew (the path the user
// submitted), then template_id, then nothing.
function readEndpoint(body, existingEndpoint) {
    if (existingEndpoint) return existingEndpoint
    if (body && typeof body.template_id === 'string') return body.template_id
    return ''
}

// For RUNNING workflows: pull the current stage name if available.
function readCurrentStage(body) {
    if (!body) return ''
    const stages = Array.isArray(body.stages) ? body.stages : []
    const idx =
        typeof body.current_stage_index === 'number'
            ? body.current_stage_index
            : -1
    if (idx >= 0 && idx < stages.length && stages[idx]) {
        return stages[idx].name || ''
    }
    return ''
}

// For FAILED workflows: prefer the top-level summary, fall back to the last
// stage with an error_message.
function readError(body) {
    if (!body) return ''
    if (typeof body.overall_error === 'string' && body.overall_error)
        return body.overall_error
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i]
        if (s && typeof s.error_message === 'string' && s.error_message)
            return s.error_message
    }
    return ''
}

// Check if an input name suggests it should have map selection
function shouldShowMapSelect(key) {
    if (Utils.containsBboxVariation(key)) return true
    if (Utils.containsLatLonCombo(key)) return true
    const normalized = Utils.normalizeInputKey(key)
    return (
        Utils.LAT_VARIATIONS.includes(normalized) ||
        Utils.LON_VARIATIONS.includes(normalized)
    )
}

// Get the map selection type for a given input
function getMapSelectType(key) {
    if (Utils.containsBboxVariation(key)) return 'bbox'
    if (Utils.containsLatLonCombo(key)) return 'point'
    const normalized = Utils.normalizeInputKey(key)
    if (
        Utils.LAT_VARIATIONS.includes(normalized) ||
        Utils.LON_VARIATIONS.includes(normalized)
    )
        return 'point'
    return null
}

// ---- HTTP helpers ----
// See api.js for mmgisFetch / mmgisUrl / verifyToken / fetchMaapUserId /
// fetchProcesses / fetchProcessDetails / fetchResources / pollJob and the
// job-history DB functions (fetchSubmittedRegistry, recordSubmittedJob,
// deleteJobFromDatabase). See layerManager.js for the
// "Workflow Outputs" layer group helpers (ensureWorkflowsGroup,
// buildLayerDescription, buildLayerObjForJob, persistLayerToMission,
// removeLayerForJob, addLayerForJob).

// ---- Map Input Display State ----
const MapInputDisplay = {
    layers: {}, // jobId -> array of Leaflet layers

    show: function(jobId, payload) {
        // Clear any existing layers for this job
        this.clear(jobId)

        // Access the map through the imported Map_ module (same as Draw tool)
        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available')
            window.alert('Map is not available')
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            return
        }

        // Check if map has a valid CRS
        if (!map.options || !map.options.crs) {
            console.warn('[MapJobSubmitTool] Map CRS not initialized')
            window.alert('Map projection system is not ready. Please try again.')
            return
        }

        const layers = []

        // Check if payload has an 'inputs' wrapper (new format with queue/tag/inputs)
        const inputsToUse = payload.inputs || payload

        // Label used in popups: prefer the job's tag, fall back to its id.
        const jobLabel = (payload.tag && String(payload.tag).trim()) || jobId

        // Collect all map inputs from payload
        const points = [] // Array of {lat, lon, label}
        const bboxes = [] // Array of {bbox, label}
        let latValue = null
        let lonValue = null

        Object.entries(inputsToUse).forEach(([key, value]) => {
            // Check for bbox (contains bbox variation anywhere in name)
            if (containsBboxVariation(key)) {
                bboxes.push({ bbox: value, label: key })
            }
            // Check for lat/lon combo (single field with both lat and lon)
            else if (containsLatLonCombo(key)) {
                // Parse "lat,lon" format
                if (typeof value === 'string' && value.includes(',')) {
                    const parts = value.split(',').map(s => parseFloat(s.trim()))
                    if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                        points.push({ lat: parts[0], lon: parts[1], label: key })
                    }
                }
            }
            // Check for individual lat/lon fields (exact match)
            else {
                const normalized = normalizeInputKey(key)
                if (LAT_VARIATIONS.includes(normalized)) {
                    latValue = parseFloat(value)
                } else if (LON_VARIATIONS.includes(normalized)) {
                    lonValue = parseFloat(value)
                }
            }
        })

        // If we found individual lat and lon values, add them as a point
        if (latValue != null && lonValue != null && !isNaN(latValue) && !isNaN(lonValue)) {
            points.push({ lat: latValue, lon: lonValue, label: 'lat/lon' })
        }

        // Draw all points
        points.forEach(point => {
            try {
                const marker = L.circleMarker([point.lat, point.lon], {
                    radius: 8,
                    color: '#00A9E0',
                    fillColor: '#00A9E0',
                    fillOpacity: 0.6,
                    weight: 2
                }).addTo(map)
                marker.bindPopup(`Job: ${escapeHTML(jobLabel)}<br>Input: ${escapeHTML(point.label)}<br>Lat: ${point.lat.toFixed(6)}<br>Lon: ${point.lon.toFixed(6)}`)
                layers.push(marker)
            } catch (err) {
                console.error('[MapJobSubmitTool] Failed to add point marker:', err)
            }
        })

        // Draw all bounding boxes
        bboxes.forEach(bboxObj => {
            const bbox = bboxObj.bbox
            // Handle both string and array formats
            let parts
            if (Array.isArray(bbox)) {
                parts = bbox.map(v => parseFloat(v))
            } else {
                parts = String(bbox).split(',').map(s => parseFloat(s.trim()))
            }

            if (parts.length === 4 && parts.every(n => !isNaN(n))) {
                const [west, south, east, north] = parts

                try {
                    // Create a single rectangle (Leaflet handles wrapping automatically)
                    const rect = L.rectangle([[south, west], [north, east]], {
                        color: '#ffb74d',
                        fillColor: '#ffb74d',
                        fillOpacity: 0.15,
                        weight: 2
                    }).addTo(map)

                    // Check if this is a dateline-crossing bbox (west > east)
                    const crossesDateline = west > east
                    const popupText = crossesDateline
                        ? `Job: ${escapeHTML(jobLabel)}<br>Input: ${escapeHTML(bboxObj.label)} (crosses dateline)<br>Bounding Box:<br>W: ${west}, S: ${south}<br>E: ${east}, N: ${north}<br><small>Spans ${(360 - (west - east)).toFixed(1)}° longitude</small>`
                        : `Job: ${escapeHTML(jobLabel)}<br>Input: ${escapeHTML(bboxObj.label)}<br>Bounding Box:<br>W: ${west}, S: ${south}<br>E: ${east}, N: ${north}`
                    rect.bindPopup(popupText)

                    layers.push(rect)
                } catch (err) {
                    console.error('[MapJobSubmitTool] Failed to add bounding box:', err)
                    console.error('[MapJobSubmitTool] Error stack:', err.stack)
                }
            }
        })

        // If we drew anything, store the layers and zoom to fit all
        if (layers.length > 0) {
            this.layers[jobId] = layers

            // The map container's cached size can be stale if it was
            // resized/hidden by tool-panel layout changes since the last
            // render (see Map_.centerAt for the same pattern) - without
            // this, fitBounds/setView compute zoom and centering against
            // the wrong dimensions.
            map.invalidateSize()

            const group = L.featureGroup(layers)
            const bounds = group.getBounds()

            if (points.length === 1 && bboxes.length === 0) {
                // A single point has zero-size bounds. fitBounds on a
                // degenerate bounds zooms all the way to the map's max
                // zoom and can behave oddly with centering; explicitly
                // center on the point instead at a reasonable fixed zoom.
                const p = points[0]
                const targetZoom = Math.min(
                    12,
                    map.getMaxZoom ? map.getMaxZoom() : 18
                )
                map.setView([p.lat, p.lon], targetZoom)
            } else {
                // Multiple features and/or bboxes: fit them all in frame.
                map.fitBounds(bounds, { padding: [50, 50] })
            }
        } else {
            window.alert('No valid map inputs found in this job.')
        }
    },

    clear: function(jobId) {
        if (this.layers[jobId]) {
            if (Map_ && Map_.map) {
                this.layers[jobId].forEach(layer => {
                    Map_.map.removeLayer(layer)
                })
            }
            delete this.layers[jobId]
        }
    },

    clearAll: function() {
        Object.keys(this.layers).forEach(jobId => {
            this.clear(jobId)
        })
    }
}

// ---- Map Selection State ----
const MapSelection = {
    active: false,
    type: null, // 'bbox' or 'point'
    inputKey: null,
    $targetInput: null, // For single input (point)
    $bboxInputs: null, // For bbox: {$minLon, $minLat, $maxLon, $maxLat}
    $latInput: null, // For lat/lon pair
    $lonInput: null, // For lat/lon pair
    drawing: null,
    clickHandler: null,
    persistentLayers: {}, // Map of inputKey -> layer, so each button has only one feature

    startPoint: function($latInput, $lonInput) {
        this.cancel() // Cancel any existing selection
        this.active = true
        this.type = 'point'
        this.inputKey = 'latlon-pair'
        this.$latInput = $latInput
        this.$lonInput = $lonInput

        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available for selection')
            window.alert('Map is not available for selection')
            this.cancel()
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            this.cancel()
            return
        }

        // Clear any existing layer for this button
        if (this.persistentLayers[this.inputKey]) {
            try {
                map.removeLayer(this.persistentLayers[this.inputKey])
            } catch (err) {
                console.warn('[MapJobSubmitTool] Failed to remove previous layer:', err)
            }
            delete this.persistentLayers[this.inputKey]
        }

        // Listen for a single click on the map
        this.clickHandler = (e) => {
            const lat = e.latlng.lat
            const lon = e.latlng.lng

            // Fill both lat and lon fields
            this.$latInput.val(lat.toFixed(6))
            this.$lonInput.val(lon.toFixed(6))

            // Add a persistent marker at the selected location
            const marker = L.circleMarker([lat, lon], {
                radius: 8,
                color: '#00A9E0',
                fillColor: '#00A9E0',
                fillOpacity: 0.6,
                weight: 2
            }).addTo(map)
            marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

            // Store the marker so it persists until job submission (one per button)
            this.persistentLayers[this.inputKey] = marker

            this.cancel()
        }
        map.on('click', this.clickHandler)

        // Change cursor to crosshair
        map.getContainer().style.cursor = 'crosshair'
    },

    start: function(type, inputKey, $input, $bboxInputs) {
        this.cancel() // Cancel any existing selection
        this.active = true
        this.type = type
        this.inputKey = inputKey
        this.$targetInput = $input
        this.$bboxInputs = $bboxInputs

        if (!Map_ || !Map_.map) {
            console.warn('[MapJobSubmitTool] Map not available for selection')
            window.alert('Map is not available for selection')
            this.cancel()
            return
        }

        const map = Map_.map
        const L = window.L
        if (!L) {
            console.warn('[MapJobSubmitTool] Leaflet not available')
            window.alert('Leaflet library is not available')
            this.cancel()
            return
        }

        // Clear any existing layer for this button
        if (this.persistentLayers[this.inputKey]) {
            try {
                map.removeLayer(this.persistentLayers[this.inputKey])
            } catch (err) {
                console.warn('[MapJobSubmitTool] Failed to remove previous layer:', err)
            }
            delete this.persistentLayers[this.inputKey]
        }

        if (type === 'bbox') {
            // Use Leaflet Draw to draw a rectangle
            this.drawing = new L.Draw.Rectangle(map, {
                shapeOptions: {
                    color: '#ff8800',
                    weight: 2,
                    fillOpacity: 0.2
                }
            })
            this.drawing.enable()

            // Listen for the draw:created event
            const handler = (e) => {
                const layer = e.layer

                // Keep the drawn rectangle as-is on the map (don't alter it!)
                layer.addTo(map)

                // Get corner coordinates - use RAW values, don't normalize yet
                const latLngs = layer.getLatLngs()[0]
                const lngs = latLngs.map(ll => ll.lng)  // Keep raw values
                const lats = latLngs.map(ll => ll.lat)

                // Find the extremes - these are the RAW unwrapped coordinates
                const south = Math.min(...lats)
                const north = Math.max(...lats)
                const west = Math.min(...lngs)   // Can be < -180
                const east = Math.max(...lngs)   // Can be > 180


                // Display popup with raw coordinates
                const span = east - west
                const popupText = `Selected Bbox<br>W: ${west.toFixed(6)}<br>S: ${south.toFixed(6)}<br>E: ${east.toFixed(6)}<br>N: ${north.toFixed(6)}<br><small>Spans ${span.toFixed(1)}° longitude</small>`
                layer.bindPopup(popupText)

                // Store the drawn layer
                this.persistentLayers[this.inputKey] = layer

                // If we have bbox inputs object, populate the 4 fields
                if (this.$bboxInputs) {
                    this.$bboxInputs.$minLon.val(west.toFixed(6))
                    this.$bboxInputs.$minLat.val(south.toFixed(6))
                    this.$bboxInputs.$maxLon.val(east.toFixed(6))
                    this.$bboxInputs.$maxLat.val(north.toFixed(6))
                    // Trigger input event to update the "Submit as" field
                    this.$bboxInputs.$minLon.trigger('input')
                } else if (this.$targetInput) {
                    // Fallback: single string input
                    const bbox = [west, south, east, north].join(',')
                    this.$targetInput.val(bbox)
                }
                this.cancel()
            }
            map.on('draw:created', handler)
            this._drawCreatedHandler = handler
        } else if (type === 'point') {
            // Listen for a single click on the map
            this.clickHandler = (e) => {
                const lat = e.latlng.lat
                const lon = e.latlng.lng

                // Add a persistent marker at the selected location
                const marker = L.circleMarker([lat, lon], {
                    radius: 8,
                    color: '#00A9E0',
                    fillColor: '#00A9E0',
                    fillOpacity: 0.6,
                    weight: 2
                }).addTo(map)
                marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

                // Store the marker so it persists until job submission (one per button)
                this.persistentLayers[this.inputKey] = marker

                // Determine how to populate the input based on field type
                const normalized = normalizeInputKey(inputKey)

                // Check if this is a lat/lon combo field (contains both lat and lon)
                if (containsLatLonCombo(inputKey)) {
                    // Lat/lon combo field - set as "lat,lon"
                    this.$targetInput.val(`${lat.toFixed(6)},${lon.toFixed(6)}`)
                } else if (LAT_VARIATIONS.includes(normalized)) {
                    // Individual latitude field
                    this.$targetInput.val(lat.toFixed(6))
                } else if (LON_VARIATIONS.includes(normalized)) {
                    // Individual longitude field
                    this.$targetInput.val(lon.toFixed(6))
                } else {
                    // Fallback: generic point - set as "lat,lon"
                    this.$targetInput.val(`${lat.toFixed(6)},${lon.toFixed(6)}`)
                }
                this.cancel()
            }
            map.on('click', this.clickHandler)

            // Change cursor to crosshair
            map.getContainer().style.cursor = 'crosshair'
        }
    },

    cancel: function() {
        if (!this.active) return

        if (Map_ && Map_.map) {
            const map = Map_.map
            if (this.drawing) {
                this.drawing.disable()
                this.drawing = null
            }
            if (this._drawCreatedHandler) {
                map.off('draw:created', this._drawCreatedHandler)
                this._drawCreatedHandler = null
            }
            if (this.clickHandler) {
                map.off('click', this.clickHandler)
                this.clickHandler = null
            }
            // Reset cursor
            map.getContainer().style.cursor = ''
        }

        this.active = false
        this.type = null
        this.inputKey = null
        this.$targetInput = null
    },

    clearPersistentLayers: function() {
        if (Map_ && Map_.map) {
            const map = Map_.map
            Object.keys(this.persistentLayers).forEach(key => {
                try {
                    map.removeLayer(this.persistentLayers[key])
                } catch (err) {
                    console.warn('[MapJobSubmitTool] Failed to remove layer:', err)
                }
            })
        }
        this.persistentLayers = {}
    }
}

// ---- Tool ----

const Workflows = {
    height: 0,
    width: 360,
    vars: null,
    baseUrl: '',
    accountCreationUrl: '',
    memberInfoUrl: '', // Full URL to member info endpoint, configurable in Configure UI
    selectedProcessID: null,
    selectedAlgorithmId: null,
    selectedVersion: null,
    selectedDeployer: null,
    jobs: {},
    jobIds: [],
    filterText: '',
    expandedIds: null, // initialized in make()
    paramsExpandedIds: null, // initialized in make()
    page: 0,
    pollTimer: null,
    authPollTimer: null,
    onAuthReady: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    personalAccessToken: null, // Stored in memory only for security
    maapUserId: null, // MAAP user ID from /api/members/self (stored in memory, not token)
    MMGISInterface: null,
    lastRefreshTime: null, // Track when jobs were last refreshed

    make: function () {
        Workflows.vars = L_.getToolVars('mapjobsubmit') || {}
        if (Workflows.vars.pollIntervalMs)
            Workflows.pollIntervalMs = Workflows.vars.pollIntervalMs
        // baseUrl is a tool variable (configurable in the Configure UI).
        // Fall back to the legacy top-level `workflows` config block for
        // missions configured before this moved.
        const legacy = (L_.configData && L_.configData.workflows) || {}
        Workflows.baseUrl = Workflows.vars.baseUrl || legacy.baseUrl || ''
        // accountCreationUrl is optional and configurable in the Configure UI
        Workflows.accountCreationUrl = Workflows.vars.accountCreationUrl || ''
        // memberInfoUrl is a full URL to the member info endpoint, configurable in the Configure UI
        Workflows.memberInfoUrl = Workflows.vars.memberInfoUrl || ''
        // resourcesConfig can be: URL, comma-separated list, or empty (disabled)
        Workflows.resourcesConfig = Workflows.vars.resourcesConfig || ''
        if (!Workflows.expandedIds) Workflows.expandedIds = new Set()
        if (!Workflows.paramsExpandedIds)
            Workflows.paramsExpandedIds = new Set()
        Workflows.MMGISInterface = new interfaceWithMMGIS()

        // Fetch processes immediately (no auth required)
        if (Workflows.baseUrl) {
            fetchProcesses().then((procs) => {
                PROCESSES = procs
                // Trigger UI update if the interface is ready
                if (typeof Workflows._populateAlgorithmDropdown === 'function') {
                    Workflows._populateAlgorithmDropdown()
                }
            })
        }

        // Don't load jobs on initial make() - wait for user to authenticate
        // Jobs will be loaded when user enters PAT and connects
    },

    destroy: function () {
        // Cancel any active map selection
        MapSelection.cancel()

        // Clear all map input displays
        MapInputDisplay.clearAll()

        if (Workflows.MMGISInterface)
            Workflows.MMGISInterface.separateFromMMGIS()
        Workflows.MMGISInterface = null
        if (Workflows.pollTimer) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
        }
        if (Workflows.authPollTimer) {
            clearInterval(Workflows.authPollTimer)
            Workflows.authPollTimer = null
        }
        // Note: Do NOT clear personalAccessToken and maapUserId here
        // They should persist across tool switches so user stays logged in
    },

    // Authenticates using a personal access token by verifying it with the /jobs endpoint
    connect: function (token) {
        // Sanitize and validate token
        const sanitized = sanitizeToken(token)
        if (!sanitized) {
            window.alert('Invalid token format. Please enter a valid personal access token.')
            return
        }
        Workflows.personalAccessToken = sanitized

        // Verify the token by calling /jobs endpoint (returns 403 if invalid)
        verifyToken().then((isValid) => {
            if (!isValid) {
                Workflows.personalAccessToken = null
                Workflows.maapUserId = null
                window.alert('Invalid personal access token. Please check your token and try again.')
                // Reset queue dropdown
                const $queueSelect = $('#mjs-queue-select')
                if ($queueSelect.length) {
                    $queueSelect.empty().append('<option value="">Enter PAT to see Queues</option>')
                    $queueSelect.attr('disabled', true)
                }
                if (typeof Workflows._renderUnauthenticated === 'function') {
                    Workflows._renderUnauthenticated()
                }
                return
            }

            // Token is valid - fetch MAAP user ID
            return fetchMaapUserId().then((userId) => {
                if (!userId) {
                    console.error('[MapJobSubmitTool] Failed to fetch MAAP user ID')
                    Workflows.personalAccessToken = null
                    Workflows.maapUserId = null
                    window.alert('Failed to fetch user information. Please try again.')
                    if (typeof Workflows._renderUnauthenticated === 'function') {
                        Workflows._renderUnauthenticated()
                    }
                    return
                }

                // Store user ID and render authenticated state
                Workflows.maapUserId = userId
                if (typeof Workflows._renderAuthenticated === 'function') {
                    Workflows._renderAuthenticated()
                }
            })
        }).catch(() => {
            Workflows.personalAccessToken = null
            Workflows.maapUserId = null
            window.alert('Failed to verify token. Please try again.')
            // Reset queue dropdown
            const $queueSelect = $('#mjs-queue-select')
            if ($queueSelect.length) {
                $queueSelect.empty().append('<option value="">Enter PAT to see Queues</option>')
                $queueSelect.attr('disabled', true)
            }
            if (typeof Workflows._renderUnauthenticated === 'function') {
                Workflows._renderUnauthenticated()
            }
        })
    },

    submit: function (processID, payload, name) {
        const proxyUrl = `api/mapjobsubmit/processes/${processID}/execution?baseUrl=` + encodeURIComponent(Workflows.baseUrl)
        return mmgisFetch(proxyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload || {}),
        })
            .then((r) => {
                // Check if response is successful (2xx status code)
                if (!r.ok) {
                    // Non-2xx response - parse error and reject
                    return r.json().then((errorData) => {
                        console.error('[MapJobSubmitTool] Job submission failed:', errorData)

                        // The proxy wraps the actual API error in the 'apiError' field
                        let actualError = errorData.apiError || errorData

                        // Extract error message from the actual API response
                        const errorMsg = actualError.detail || actualError.title || actualError.message || errorData.message || 'Unknown error'
                        const statusCode = errorData.statusCode || actualError.status || r.status

                        throw new Error(`Job submission failed (${statusCode}): ${errorMsg}`)
                    }).catch((jsonErr) => {
                        // If JSON parsing fails, throw a generic error
                        if (jsonErr.message && jsonErr.message.includes('Job submission failed')) {
                            throw jsonErr // Re-throw the error we just created
                        }
                        throw new Error(`Job submission failed (${r.status}): ${r.statusText}`)
                    })
                }
                return r.json()
            })
            .then((data) => {
                const jobId = data.jobID
                if (!jobId) {
                    console.error('[MapJobSubmitTool] No job ID in response:', data)
                    throw new Error('No job ID in response')
                }
                Workflows.jobs[jobId] = {
                    endpoint: String(processID), // store processID as the endpoint identifier
                    payload: payload,
                    name: name || '',
                    status: readStatus(data) || 'queued',
                    startedAt: Date.now(),
                }
                // Prepend to ordered list and jump to first page so the user
                // sees their submission immediately.
                const i = Workflows.jobIds.indexOf(jobId)
                if (i !== -1) Workflows.jobIds.splice(i, 1)
                Workflows.jobIds.unshift(jobId)
                Workflows.page = 0
                // Wait for DB write to complete before rendering to avoid race conditions
                return recordSubmittedJob(jobId, String(processID), payload, name)
                    .then(() => {
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                        return jobId
                    })
                    .catch((err) => {
                        console.warn('[MapJobSubmitTool] Failed to record to DB, but showing in UI anyway:', err)
                        // Still render even if DB write fails
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                        return jobId
                    })
            })
            // NOTE: No .catch() here - let errors propagate to the caller so they can display to user
    },

    ensurePolling: function () {
        if (Workflows.pollTimer) return
        Workflows.pollTimer = setInterval(
            Workflows.pollAll,
            Workflows.pollIntervalMs
        )
    },

    refreshFromServer: function () {
        // Check if authenticated before fetching jobs
        if (!Workflows.personalAccessToken) {
            return Promise.resolve()
        }

        // Update the last refresh timestamp
        Workflows.lastRefreshTime = Date.now()
        updateLastRefreshDisplay()

        // Fetch job history from MMGIS DB (not from MAAP API)
        return fetchSubmittedRegistry()
            .then((reg) => {
                // Merge registry data into Workflows.jobs
                Object.keys(reg).forEach((jobId) => {
                    if (!Workflows.jobs[jobId]) {
                        Workflows.jobs[jobId] = {
                            endpoint: reg[jobId].endpoint || '',
                            payload: reg[jobId].payload,
                            name: reg[jobId].name || '',
                            status: 'unknown',
                            startedAt: reg[jobId].ts || Date.now(),
                        }
                    } else {
                        // Update fields that might be missing
                        Workflows.jobs[jobId].payload =
                            Workflows.jobs[jobId].payload ||
                            reg[jobId].payload
                        Workflows.jobs[jobId].endpoint =
                            Workflows.jobs[jobId].endpoint ||
                            reg[jobId].endpoint
                        Workflows.jobs[jobId].name =
                            Workflows.jobs[jobId].name ||
                            reg[jobId].name ||
                            ''
                    }
                })

                // Build jobIds list from what we have in Workflows.jobs
                Workflows.jobIds = Object.keys(Workflows.jobs)
                    .sort(
                        (a, b) =>
                            (Workflows.jobs[b].startedAt || 0) -
                            (Workflows.jobs[a].startedAt || 0)
                    )


                // Clamp the current page in case the new list is shorter
                const maxPage = Math.max(
                    0,
                    Math.ceil(Workflows.jobIds.length / PAGE_SIZE) - 1
                )
                if (Workflows.page > maxPage) Workflows.page = maxPage

                // Render immediately with what we have
                Workflows.renderJobs()

                // Fetch details for visible jobs
                return Workflows.fetchPageDetails()
            })
            .then(() => {
                Workflows.renderJobs()
                const hasActive = Object.values(Workflows.jobs).some(
                    (j) => !isTerminal(j.status)
                )
                if (hasActive) Workflows.ensurePolling()
            })
            .catch((err) => {
                console.warn('[MapJobSubmitTool] refresh failed', err)
            })
    },

    // The job ids currently visible given the text filter (matches tag,
    // job ID, or process name - case-insensitive partial match).
    getVisibleJobIds: function () {
        const f = Workflows.filterText
        if (!f) return Workflows.jobIds
        const filterLower = f.toLowerCase()
        return Workflows.jobIds.filter((id) => {
            const job = Workflows.jobs[id]
            if (!job) return false

            // Check job ID (partial match)
            if (id.toLowerCase().includes(filterLower)) return true

            // Check job name/tag (partial match)
            const name = job.name || ''
            if (name.toLowerCase().includes(filterLower)) return true

            // Check process name from endpoint (partial match)
            const endpoint = job.endpoint || ''
            if (endpoint.toLowerCase().includes(filterLower)) return true

            // Also check the human-friendly process label (partial match)
            const processLabel = endpointLabel(endpoint).toLowerCase()
            if (processLabel.includes(filterLower)) return true

            return false
        })
    },

    fetchPageDetails: function () {
        // Check if authenticated before fetching job details from MAAP API
        if (!Workflows.personalAccessToken) {
            return Promise.resolve()
        }

        const start = Workflows.page * PAGE_SIZE
        const slice = Workflows.getVisibleJobIds().slice(
            start,
            start + PAGE_SIZE
        )
        return Promise.all(
            slice.map((id) => {
                // Skip polling jobs that are already in a terminal state
                const job = Workflows.jobs[id]
                if (job && isTerminal(job.status)) {
                    return Promise.resolve()
                }

                return pollJob(id)
                    .then((body) => mergeJobUpdate(id, body))
                    // One bad job must never sink the whole page's render.
                    .catch((err) => {
                        console.warn(
                            `[MapJobSubmitTool] detail fetch failed for ${id}`,
                            err
                        )
                        // Don't update the job on error - keep existing state
                    })
            })
        )
    },

    goToPage: function (n) {
        const maxPage = Math.max(
            0,
            Math.ceil(Workflows.getVisibleJobIds().length / PAGE_SIZE) - 1
        )
        const target = Math.max(0, Math.min(n, maxPage))
        if (target === Workflows.page) return
        Workflows.page = target
        Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        Workflows.renderJobs() // immediate render with whatever we have
    },

    pollAll: function () {
        // Check if authenticated before polling
        if (!Workflows.personalAccessToken) {
            if (Workflows.pollTimer) {
                clearInterval(Workflows.pollTimer)
                Workflows.pollTimer = null
            }
            return
        }

        const ids = Object.keys(Workflows.jobs).filter(
            (id) => !isTerminal(Workflows.jobs[id].status)
        )
        if (ids.length === 0) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
            return
        }
        ids.forEach((id) => {
            pollJob(id)
                .then((body) => {
                    const prev = Workflows.jobs[id]
                    if (!prev) return
                    const prevStatus = prev.status
                    mergeJobUpdate(id, body)
                    if (Workflows.jobs[id].status !== prevStatus)
                        Workflows.renderJobs()
                })
                .catch((err) => {
                    // Silently continue polling other jobs if one fails
                    console.warn(`[MapJobSubmitTool] pollAll failed for ${id}:`, err)
                })
        })
    },

    renderJobs: function () {
        const $list = $('#mapJobSubmitTool .mjs-jobs-list')
        if ($list.length === 0) {
            return
        }
        $list.empty()

        // Bootstrap jobIds from Workflows.jobs the first time renderJobs runs
        // before refreshFromServer has populated the ordered list.
        if (Workflows.jobIds.length === 0) {
            Workflows.jobIds = Object.keys(Workflows.jobs).sort(
                (a, b) =>
                    (Workflows.jobs[b].startedAt || 0) -
                    (Workflows.jobs[a].startedAt || 0)
            )
        }

        const visibleIds = Workflows.getVisibleJobIds()
        const total = visibleIds.length
        if (total === 0) {
            $list.append(
                `<div class="mjs-empty">${
                    Workflows.filterText
                        ? 'No jobs match the filter.'
                        : 'No jobs yet.'
                }</div>`
            )
            renderPagination(0, 0, 0)
            return
        }

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (Workflows.page >= totalPages) Workflows.page = totalPages - 1
        const start = Workflows.page * PAGE_SIZE
        const pageIds = visibleIds.slice(start, start + PAGE_SIZE)

        pageIds.forEach((id) => {
            const job = Workflows.jobs[id] || { status: 'loading…', endpoint: '' }
            const statusClass = normalizeStatus(job.status) || 'loading'
            const isExpanded = Workflows.expandedIds.has(id)
            const $div = $('<div class="mjs-job"></div>')
            // Named runs show just the name (uuid available via tooltip and
            // the expanded drawer); unnamed runs fall back to the uuid.
            const primary = job.name
                ? `<span class="mjs-job-name" title="${escapeHTML(
                      id
                  )}">${escapeHTML(job.name)}</span>`
                : `<span class="mjs-job-id">${escapeHTML(id)}</span>`
            // Inline visibility checkbox on the tile itself once the layer
            // exists — no need to open the drawer just to toggle. The
            // mjs-layer-toggle handler stops propagation, so clicking it
            // doesn't expand/collapse the row.
            const layerExists = L_.layers.data[id] != null
            const tileVisibility = layerExists
                ? `<div class="mjs-tile-visibility mjs-layer-toggle" data-job-id="${escapeHTML(
                      id
                  )}" title="Toggle layer visibility">` +
                  `<div class="mjs-checkbox${
                      L_.layers.on[id] === true ? ' on' : ''
                  }"></div>` +
                  `</div>`
                : ''
            const $header = $(
                `<div class="mjs-job-header" data-job-id="${escapeHTML(id)}">` +
                    `<span class="mjs-job-chevron">${isExpanded ? '▼' : '▶'}</span> ` +
                    primary + ' ' +
                    `<span class="mjs-job-status ${escapeHTML(statusClass)}">${escapeHTML(job.status)}</span>` +
                    tileVisibility +
                    `</div>`
            )
            $div.append($header)
            if (job.endpoint) {
                $div.append(
                    `<div class="mjs-job-output" title="${escapeHTML(
                        job.endpoint
                    )}">${escapeHTML(endpointLabel(job.endpoint))}</div>`
                )
            }
            // Parameters are shown in the expanded section only, not in the collapsed tile view
            if (statusClass === 'running' && job.currentStage) {
                $div.append(
                    `<div class="mjs-job-stage">stage: ${escapeHTML(
                        job.currentStage
                    )}</div>`
                )
            }
            if (statusClass === 'failed' && job.error) {
                $div.append(
                    `<div class="mjs-job-error">${escapeHTML(job.error)}</div>`
                )
            }
            if (isExpanded) {
                $div.append(buildExpandedSection(job, id))
            }
            $list.append($div)
        })

        renderPagination(Workflows.page, totalPages, total)
    },
}

// Single source of truth for merging a backend response into Workflows.jobs.
// Preserves locally-known fields (the path the user actually submitted, our
// startedAt) and overlays the latest server state. Triggers layer add when
// a job first reaches completed with an output URI.
function mergeJobUpdate(id, body) {
    if (!body || typeof body !== 'object') return
    const existing = Workflows.jobs[id] || {}
    const status = readStatus(body) || existing.status || 'unknown'
    const freshUris = extractOutputUris(body)
    const output_uris =
        freshUris.length > 0
            ? freshUris
            : Array.isArray(existing.output_uris)
              ? existing.output_uris
              : []
    const next = {
        endpoint: readEndpoint(body, existing.endpoint),
        payload: existing.payload, // submitted payload sticks; server doesn't echo it
        name: existing.name || '', // client-side label
        status,
        output_uris,
        autoAddableUri:
            findAutoAddableUri(output_uris) || existing.autoAddableUri,
        currentStage:
            status === 'running' ? readCurrentStage(body) : undefined,
        error: status === 'failed' ? readError(body) : undefined,
        startedAt: existing.startedAt || Date.now(),
        layerAdded: existing.layerAdded,
        body: body, // full latest server response for the expanded view
        fromServer: true,
    }
    Workflows.jobs[id] = next
    // No auto-add: completed jobs with an addable output render an
    // "add as layer" button instead — the user decides what lands on the map.
}

// Parse an ISO-ish timestamp (the API returns naive UTC like "2026-06-02T23:20:50.586000")
// and render in the user's locale. Falls back to the raw string on bad input.
function formatLocale(iso) {
    if (!iso) return ''
    // The server's naive timestamps don't include a 'Z' suffix; FastAPI emits
    // UTC-but-unmarked. Append Z so Date doesn't interpret as local time.
    const s =
        typeof iso === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
            ? iso + 'Z'
            : iso
    const d = new Date(s)
    if (isNaN(d.getTime())) return String(iso)
    return d.toLocaleString()
}

// Check if job has any inputs that can be displayed on map
function hasMapDisplayableInputs(payload) {
    if (!payload || typeof payload !== 'object') return false

    // Check if payload has an 'inputs' wrapper (new format with queue/tag/inputs)
    const inputsToCheck = payload.inputs || payload

    return Object.keys(inputsToCheck).some(key => shouldShowMapSelect(key))
}

// Update the "Last refreshed" timestamp display
function updateLastRefreshDisplay() {
    const $display = $('#mjs-last-refresh')
    if (!$display.length) return

    if (!Workflows.lastRefreshTime) {
        $display.text('')
        return
    }

    const date = new Date(Workflows.lastRefreshTime)
    const timeString = date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    })

    $display.text(`Last refreshed: ${timeString}`)
}

function buildExpandedSection(job, jobId) {
    const $exp = $('<div class="mjs-job-expanded"></div>')

    // Workflow uuid — always shown at top of expanded section
    $exp.append(
        `<div class="mjs-exp-uuid" title="Workflow id">${escapeHTML(
            jobId
        )}</div>`
    )

    // Submitted params — only if we know them (locally submitted or hydrated
    // from the persistent registry). TEMPORARY: file:// values stripped.
    if (job.payload && Object.keys(job.payload).length > 0) {
        const display = Object.fromEntries(
            Object.entries(job.payload).filter(
                ([, v]) => !isFilePathValue(v)
            )
        )
        if (Object.keys(display).length > 0) {
            $exp.append('<div class="mjs-exp-label">Submitted parameters</div>')
            const $pre = $('<pre class="mjs-exp-json"></pre>')
            $pre.text(JSON.stringify(display, null, 2))
            $exp.append($pre)

            // Add "View Inputs on Map" button if job has mappable inputs
            if (hasMapDisplayableInputs(job.payload)) {
                const isShowing = MapInputDisplay.layers[jobId] && MapInputDisplay.layers[jobId].length > 0
                const $viewBtn = $(
                    `<button type="button" class="mjs-view-inputs-btn" data-job-id="${escapeHTML(jobId)}">${
                        isShowing ? 'Hide Inputs from Map' : 'View Inputs on Map'
                    }</button>`
                )
                $exp.append($viewBtn)
            }
        }
    } else if (job.fromServer) {
        $exp.append(
            '<div class="mjs-exp-hint">No submitted parameters on record (job was likely submitted from elsewhere or before this browser stored them).</div>'
        )
    }

    // Output data controls
    if (normalizeStatus(job.status) === 'successful') {
        const $row = $('<div class="mjs-map-btn-row"></div>')
        $row.append(
            `<button type="button" class="mjs-map-btn mjs-view-data-btn" data-job-id="${escapeHTML(
                jobId
            )}" disabled>View Data on Map</button>`
        )
        $row.append(
            `<button type="button" class="mjs-map-btn mjs-download-data-btn" data-job-id="${escapeHTML(
                jobId
            )}" disabled>Download Data</button>`
        )
        $exp.append($row)
    }

    // Server-side metadata, when present.
    const body = job.body
    if (body) {
        if (body.created_at || body.updated_at) {
            $exp.append('<div class="mjs-exp-label">Timing</div>')
            const lines = []
            if (body.created_at)
                lines.push(`created: ${formatLocale(body.created_at)}`)
            if (body.updated_at)
                lines.push(`updated: ${formatLocale(body.updated_at)}`)
            $exp.append(
                `<div class="mjs-exp-hint">${escapeHTML(lines.join(' · '))}</div>`
            )
        }
        if (Array.isArray(body.stages) && body.stages.length > 0) {
            $exp.append('<div class="mjs-exp-label">Stages</div>')
            const $stages = $('<div class="mjs-exp-stages"></div>')
            body.stages.forEach((s, i) => {
                const sclass = normalizeStatus(s && s.status) || 'unknown'
                const isCurrent = i === body.current_stage_index
                const $row = $(
                    `<div class="mjs-exp-stage ${escapeHTML(sclass)}${
                        isCurrent ? ' current' : ''
                    }">` +
                        `<span class="mjs-exp-stage-status">${escapeHTML(
                            s.status || ''
                        )}</span> ` +
                        `<span class="mjs-exp-stage-name">${escapeHTML(
                            s.name || ''
                        )}</span>` +
                        (s.subsystem
                            ? ` <span class="mjs-exp-stage-sub">[${escapeHTML(
                                  s.subsystem
                              )}]</span>`
                            : '') +
                        `</div>`
                )
                if (s.error_message) {
                    $row.append(
                        `<div class="mjs-exp-stage-error">${escapeHTML(
                            s.error_message
                        )}</div>`
                    )
                }
                $stages.append($row)
            })
            $exp.append($stages)
        }
    }

    // Remove Job button - always shown at the bottom
    $exp.append('<div class="mjs-exp-label" style="margin-top: 20px;">Actions</div>')
    $exp.append(
        `<button type="button" class="mjs-remove-job-btn" data-job-id="${escapeHTML(
            jobId
        )}">Remove Job</button>`
    )

    return $exp
}

function renderPagination(page, totalPages, total) {
    const $container = $('#mapJobSubmitTool .mjs-pagination')
    if ($container.length === 0) return
    $container.empty()
    if (totalPages <= 1) return
    const $prev = $(
        '<button type="button" class="mjs-page-btn mjs-page-prev">Prev</button>'
    )
    if (page === 0) $prev.attr('disabled', true)
    $prev.on('click', () => Workflows.goToPage(Workflows.page - 1))
    const $next = $(
        '<button type="button" class="mjs-page-btn mjs-page-next">Next</button>'
    )
    if (page >= totalPages - 1) $next.attr('disabled', true)
    $next.on('click', () => Workflows.goToPage(Workflows.page + 1))
    const $label = $(
        `<span class="mjs-page-label">Page ${page + 1} of ${totalPages} · ${total} jobs</span>`
    )
    $container.append($prev).append($label).append($next)
}

function interfaceWithMMGIS() {
    const tools = $('#toolPanel')
    tools.css({
        background: 'var(--color-k)',
        'box-shadow': 'inset 2px 0px 10px 0px rgba(0,0,0,0.2)',
    })
    tools.empty()
    tools.html('<div id="mapJobSubmitTool" class="mmgisScrollbar"></div>')
    const $root = $('#mapJobSubmitTool')
    $root.append('<div class="mjs-header">Workflows</div>')

    const $authBanner = $('<div id="mjs-auth-banner"></div>')
    $root.append($authBanner)

    // Form content wrapper - will be hidden until authenticated
    const $formContent = $('<div id="mjs-form-content" style="display: none;"></div>')

    // Algorithm selection dropdowns (3-step: id → version → deployer)
    $formContent.append('<div class="mjs-section-label">Algorithm</div>')
    const $algorithmSelect = $('<select id="mjs-algorithm-select"><option value="">Select algorithm...</option></select>')
    $formContent.append($algorithmSelect)

    $formContent.append('<div class="mjs-section-label">Version</div>')
    const $versionSelect = $('<select id="mjs-version-select" disabled><option value="">Select version...</option></select>')
    $formContent.append($versionSelect)

    $formContent.append('<div class="mjs-section-label">Deployer</div>')
    const $deployerSelect = $('<select id="mjs-deployer-select" disabled><option value="">Select deployer...</option></select>')
    $formContent.append($deployerSelect)

    $formContent.append('<div class="mjs-endpoint-desc" id="mjs-endpoint-desc"></div>')

    // Queue section - wrapped in a container for easy show/hide
    const $queueSection = $('<div class="mjs-queue-section"></div>')
    $queueSection.append('<div class="mjs-section-label">Queue</div>')
    const $queueSelect = $('<select id="mjs-queue-select" disabled></select>')
    $queueSelect.append('<option value="">Enter token to see queues</option>')
    $queueSection.append($queueSelect)
    $formContent.append($queueSection)

    $formContent.append('<div class="mjs-section-label">Tag</div>')
    const $tagInput = $(
        '<input type="text" id="mjs-submit-name" class="mjs-name-input" placeholder="e.g. test_default_inputs" />'
    )
    $formContent.append($tagInput)

    $formContent.append('<div class="mjs-section-label">Parameters</div>')
    const $form = $('<div id="mjs-form"></div>')
    $formContent.append($form)

    const $submit = $('<button class="mjs-submit" disabled>Loading…</button>')
    $formContent.append($submit)

    $root.append($formContent)

    $root.append(
        '<div class="mjs-jobs"><div class="mjs-jobs-header"><div class="mjs-section-label">Jobs</div><div class="mjs-jobs-header-btns"><button class="mjs-import-btn" type="button">Import Job</button><button class="mjs-refresh-btn" type="button">Refresh</button><span class="mjs-last-refresh" id="mjs-last-refresh"></span></div></div><input type="text" class="mjs-jobs-filter" placeholder="Filter by name or id…" spellcheck="false" /><div class="mjs-jobs-list"></div><div class="mjs-pagination"></div></div>'
    )
    // Don't call renderJobs() here - it will be called after authentication in renderAuthenticated()

    let filterFetchTimer = null
    $root.find('.mjs-jobs-filter').on('input', function () {
        Workflows.filterText = ($(this).val() || '').trim().toLowerCase()
        Workflows.page = 0
        Workflows.renderJobs()
        // Fetch details for the newly visible page, lightly debounced so
        // fast typing doesn't spray requests.
        clearTimeout(filterFetchTimer)
        filterFetchTimer = setTimeout(() => {
            Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        }, 300)
    })

    $root.find('.mjs-refresh-btn').on('click', function () {
        const $btn = $(this)
        $btn.attr('disabled', true).text('Refreshing…')
        Workflows.refreshFromServer().finally(() => {
            $btn.attr('disabled', false).text('Refresh')
        })
    })

    $root.find('.mjs-import-btn').on('click', function () {
        const jobId = window.prompt('Enter Job ID to import:')
        if (!jobId || !jobId.trim()) return

        const trimmedJobId = jobId.trim()

        // Check if job already exists
        if (Workflows.jobs[trimmedJobId]) {
            window.alert('Job already present in your jobs list.')
            return
        }

        const $btn = $(this)
        $btn.attr('disabled', true).text('Importing…')

        // Fetch job details from API with getJobDetails=true
        pollJob(trimmedJobId, true)
            .then((body) => {
                if (!body || Object.keys(body).length === 0) {
                    window.alert('Job not found or returned empty data. Please check the Job ID and try again.')
                    return
                }

                // Extract inputs from the API response
                // The API returns inputs as an array of objects with name, destination, and value
                let payload = {}

                if (Array.isArray(body.inputs)) {
                    // Convert array format to object format for storage
                    body.inputs.forEach((input) => {
                        if (input.name && input.value !== undefined && input.value !== null) {
                            payload[input.name] = input.value
                        }
                    })
                } else if (body.inputs && typeof body.inputs === 'object') {
                    // Already in object format
                    payload = body.inputs
                }


                // Create job entry using processID from body
                const status = readStatus(body) || 'unknown'
                // Use process_name as endpoint if available, otherwise use processID
                const endpoint = body.process_name || (body.processID ? String(body.processID) : readEndpoint(body, null))

                // Use tags[0] as the primary name, fallback to title, then to empty string
                const jobName = (Array.isArray(body.tags) && body.tags.length > 0)
                    ? body.tags[0]
                    : (body.title || '')

                Workflows.jobs[trimmedJobId] = {
                    endpoint: endpoint,
                    payload: payload, // Extracted from API response
                    name: jobName,
                    status: status,
                    startedAt: body.created ? new Date(body.created).getTime() : Date.now(),
                    fromServer: true,
                    body: body
                }


                // Add to ordered list at the top
                const i = Workflows.jobIds.indexOf(trimmedJobId)
                if (i !== -1) Workflows.jobIds.splice(i, 1)
                Workflows.jobIds.unshift(trimmedJobId)
                Workflows.page = 0

                // Save to database
                return recordSubmittedJob(trimmedJobId, endpoint, payload, jobName)
                    .then(() => {
                        window.alert('Job imported successfully!')
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                    })
                    .catch((err) => {
                        console.warn('[MapJobSubmitTool] Failed to save imported job to DB:', err)
                        // Still show the job even if DB save fails
                        window.alert('Job imported successfully! (Note: failed to persist to database)')
                        Workflows.ensurePolling()
                        Workflows.renderJobs()
                    })
            })
            .catch((err) => {
                console.error('[MapJobSubmitTool] Failed to import job:', err)
                // Parse error message to show more specific feedback
                const errMsg = err.message || String(err)
                if (errMsg.includes('404')) {
                    window.alert('Job not found. The Job ID does not exist or you do not have permission to view it.')
                } else if (errMsg.includes('403')) {
                    window.alert('Access denied. Please check your authentication token.')
                } else if (errMsg.includes('401')) {
                    window.alert('Unauthorized. Please connect with a valid personal access token.')
                } else {
                    window.alert(`Failed to import job: ${errMsg}`)
                }
            })
            .finally(() => {
                $btn.attr('disabled', false).text('Import Job')
            })
    })

    // Click-to-expand on job rows. Delegated so it survives re-renders.
    $root.find('.mjs-jobs-list').on('click', '.mjs-job-header', function () {
        const id = $(this).attr('data-job-id')
        if (!id) return

        // If collapsing, clear any map inputs being displayed
        if (Workflows.expandedIds.has(id)) {
            Workflows.expandedIds.delete(id)
            MapInputDisplay.clear(id)
        } else {
            Workflows.expandedIds.add(id)
        }

        Workflows.renderJobs()
    })

    // View job inputs on map (lat/lon/bbox). Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-view-inputs-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job || !job.payload) return

        // Toggle: if already showing, clear; otherwise show
        if (MapInputDisplay.layers[id] && MapInputDisplay.layers[id].length > 0) {
            MapInputDisplay.clear(id)
        } else {
            MapInputDisplay.show(id, job.payload)
        }

        // Re-render to update button text
        Workflows.renderJobs()
    })

    // Remove job from MMGIS database (not from MAAP). Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-remove-job-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return

        if (!window.confirm('This will delete the job from this MMGIS instance, not your MAAP account. You can readd this job later with the Import Job button.')) {
            return
        }

        const $btn = $(this)
        $btn.attr('disabled', true).text('Removing...')

        // Delete from database
        deleteJobFromDatabase(id)
            .then(() => {
                // Remove from local state
                delete Workflows.jobs[id]
                const idx = Workflows.jobIds.indexOf(id)
                if (idx !== -1) {
                    Workflows.jobIds.splice(idx, 1)
                }

                // Clear any map displays
                MapInputDisplay.clear(id)

                // Remove layer if it exists
                if (L_.layers.data[id]) {
                    const job = { layerAdded: true }
                    removeLayerForJob(id, job).then(() => {
                        Workflows.renderJobs()
                    })
                } else {
                    Workflows.renderJobs()
                }
            })
            .catch((err) => {
                console.error('[MapJobSubmitTool] Failed to remove job:', err)
                window.alert(`Failed to remove job: ${err.message}`)
                $btn.attr('disabled', false).text('Remove Job')
            })
    })

    // View data on map button. Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-view-data-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        // TODO implement
    })

    // Download data button. Delegated.
    $root.find('.mjs-jobs-list').on('click', '.mjs-download-data-btn', function (e) {
        e.preventDefault()
        e.stopPropagation()
        // TODO implement
    })

    // Handle "Select Point on Map" button for lat/lon pairs. Delegated.
    $root.on('click', '.mjs-select-point-btn', function(e) {
        e.preventDefault()
        e.stopPropagation()

        // If already active, cancel the selection
        if ($(this).hasClass('mjs-map-select-active')) {
            MapSelection.cancel()
            return
        }

        const latKey = $(this).attr('data-lat-key')
        const lonKey = $(this).attr('data-lon-key')
        if (!latKey || !lonKey) return

        // Find the input fields for lat and lon
        const $latInput = $(`#mjs-input-${latKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)
        const $lonInput = $(`#mjs-input-${lonKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)

        if (!$latInput.length || !$lonInput.length) return

        // Start point selection with both inputs
        MapSelection.startPoint($latInput, $lonInput)

        // Update button text to indicate active selection
        $(this).text('Click map to select point').addClass('mjs-map-select-active')

        // Restore button text when selection is cancelled/completed
        const originalBtn = $(this)
        const restoreBtn = () => {
            originalBtn.text('Select Point on Map').removeClass('mjs-map-select-active')
        }

        // Poll to detect when selection is cancelled
        const checkInterval = setInterval(() => {
            if (!MapSelection.active) {
                restoreBtn()
                clearInterval(checkInterval)
            }
        }, 100)
    })

    // Handle "Select on Map" button clicks for bbox/lat/lon inputs. Delegated.
    $root.on('click', '.mjs-map-select-btn', function(e) {
        e.preventDefault()
        e.stopPropagation()

        // If already active, cancel the selection
        if ($(this).hasClass('mjs-map-select-active')) {
            MapSelection.cancel()
            return
        }

        const inputKey = $(this).attr('data-input-key')
        if (!inputKey) return

        const selectType = getMapSelectType(inputKey)
        if (!selectType) return

        let $input = null
        let $bboxInputs = null

        if (selectType === 'bbox') {
            // Find the bbox input fields in the parent field
            const $field = $(this).closest('.mjs-field')
            const $minLon = $field.find('input[data-bbox-field="min_lon"]')
            const $minLat = $field.find('input[data-bbox-field="min_lat"]')
            const $maxLon = $field.find('input[data-bbox-field="max_lon"]')
            const $maxLat = $field.find('input[data-bbox-field="max_lat"]')

            if ($minLon.length && $minLat.length && $maxLon.length && $maxLat.length) {
                $bboxInputs = { $minLon, $minLat, $maxLon, $maxLat }
            }
        } else {
            // For point inputs, get the sibling input
            $input = $(this).siblings('input')
            if (!$input.length) return
        }

        MapSelection.start(selectType, inputKey, $input, $bboxInputs)

        // Update button text to indicate active selection
        $(this).text('Click to cancel').addClass('mjs-map-select-active')

        // Restore button text when selection is cancelled/completed
        const originalBtn = $(this)
        const restoreBtn = () => {
            originalBtn.text('Select on Map').removeClass('mjs-map-select-active')
        }

        // Poll to detect when selection is cancelled
        const checkInterval = setInterval(() => {
            if (!MapSelection.active) {
                restoreBtn()
                clearInterval(checkInterval)
            }
        }, 100)
    })

    let collectPayload = () => ({})

    function renderSelectedProcess() {
        if (!Workflows.selectedProcessID) {
            $('#mjs-endpoint-desc').text('')
            $form.empty().append('<div class="mjs-empty">Select an algorithm to see parameters.</div>')
            collectPayload = () => ({
                queue: $queueSelect.val() || '',
                tag: $tagInput.val().trim() || '',
                inputs: {}
            })
            return
        }

        // Show loading state
        $('#mjs-endpoint-desc').text('Loading...')
        $form.empty().append('<div class="mjs-empty">Loading parameters...</div>')

        // Fetch process details including inputs
        fetchProcessDetails(Workflows.selectedProcessID).then((details) => {
            if (!details) {
                $('#mjs-endpoint-desc').text('Failed to load process details')
                $form.empty().append('<div class="mjs-empty">Failed to load parameters.</div>')
                collectPayload = () => ({
                    queue: $queueSelect.val() || '',
                    tag: $tagInput.val().trim() || '',
                    inputs: {}
                })
                return
            }

            const desc = details.description || details.title || ''
            $('#mjs-endpoint-desc').text(desc)

            // Build form from the inputs object
            if (details.inputs && typeof details.inputs === 'object') {
                collectPayload = UI.buildFormFromInputs(
                    $form,
                    details.inputs,
                    $queueSelect,
                    $tagInput,
                    Map_,
                    shouldShowMapSelect,
                    MapSelection
                )
            } else {
                $form.empty().append('<div class="mjs-empty">No parameters required.</div>')
                collectPayload = () => ({
                    queue: $queueSelect.val() || '',
                    tag: $tagInput.val().trim() || '',
                    inputs: {}
                })
            }
        })
    }

    function populateAlgorithmDropdown() {
        const $select = $('#mjs-algorithm-select')
        $select.empty().append('<option value="">Select algorithm...</option>')
        if (PROCESSES.length === 0) {
            $select.attr('disabled', true)
            return
        }
        // Get unique algorithm ids
        const uniqueIds = Array.from(new Set(PROCESSES.map((p) => p.id)))
        uniqueIds.sort()
        uniqueIds.forEach((id) => {
            $select.append(`<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateVersionDropdown(algorithmId) {
        const $select = $('#mjs-version-select')
        $select.empty().append('<option value="">Select version...</option>')
        if (!algorithmId) {
            $select.attr('disabled', true)
            return
        }
        const matches = PROCESSES.filter((p) => p.id === algorithmId)
        const uniqueVersions = Array.from(new Set(matches.map((p) => p.version)))
        uniqueVersions.sort()
        uniqueVersions.forEach((v) => {
            $select.append(`<option value="${escapeHTML(v)}">${escapeHTML(v)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateDeployerDropdown(algorithmId, version) {
        const $select = $('#mjs-deployer-select')
        $select.empty().append('<option value="">Select deployer...</option>')
        if (!algorithmId || !version) {
            $select.attr('disabled', true)
            return
        }
        const matches = PROCESSES.filter((p) => p.id === algorithmId && p.version === version)
        const uniqueDeployers = Array.from(new Set(matches.map((p) => p.deployedBy)))
        uniqueDeployers.sort()
        uniqueDeployers.forEach((d) => {
            const proc = matches.find((p) => p.deployedBy === d)
            const label = d || '(unknown)'
            $select.append(`<option value="${proc.processID}">${escapeHTML(label)}</option>`)
        })
        $select.attr('disabled', false)
    }

    function populateQueueDropdown() {
        const $select = $queueSelect
        const $queueSection = $select.parent()

        // Fetch resources from the API or config
        fetchResources().then((resources) => {
            // Mode 1: Queues disabled (resources is null)
            if (resources === null) {
                $queueSection.hide()
                return
            }

            // Mode 2 & 3: Show queue field
            $queueSection.show()
            $select.empty().append('<option value="">Select queue...</option>')

            if (!resources || resources.length === 0) {
                console.warn('[MapJobSubmitTool] No resources returned')
                $select.append('<option value="">No queues available</option>')
                $select.attr('disabled', false)
                return
            }

            // Handle both array of strings and array of objects
            if (Array.isArray(resources)) {
                resources.forEach((resource) => {
                    const value = typeof resource === 'string' ? resource : (resource.name || resource.id || String(resource))
                    const label = typeof resource === 'string' ? resource : (resource.label || resource.name || resource.id || String(resource))
                    $select.append(`<option value="${escapeHTML(value)}">${escapeHTML(label)}</option>`)
                })
            }

            $select.attr('disabled', false)
        }).catch((err) => {
            console.warn('[MapJobSubmitTool] Failed to load queues', err)
            $select.empty().append('<option value="">Failed to load queues</option>')
            $select.attr('disabled', false)
        })
    }

    function renderUnauthenticated() {
        $authBanner.empty()
        const $section = $('<div class="mjs-auth-input-section"></div>')
        $section.append('<div class="mjs-section-label">Personal Access Token</div>')
        const $tokenInput = $(
            '<input type="password" id="mjs-token-input" placeholder="Paste your personal access token" autocomplete="off" />'
        )
        const $connectBtn = $(
            '<button type="button" class="mjs-connect-btn">Connect</button>'
        )

        $connectBtn.on('click', function () {
            const token = $tokenInput.val().trim()
            if (!token) {
                window.alert('Please enter a personal access token.')
                return
            }
            $connectBtn.text('Connecting...').attr('disabled', true)
            Workflows.connect(token)
        })

        // Allow Enter key to submit
        $tokenInput.on('keydown', function (e) {
            if (e.key === 'Enter') {
                $connectBtn.trigger('click')
            }
        })

        $section.append($tokenInput).append($connectBtn)
        $authBanner.append($section)

        // Add account creation link if configured
        if (Workflows.accountCreationUrl) {
            const $linkSection = $(
                `<div class="mjs-account-link">Link for information to create an account: <a href="${escapeHTML(
                    Workflows.accountCreationUrl
                )}" target="_blank" rel="noopener noreferrer">${escapeHTML(
                    Workflows.accountCreationUrl
                )}</a></div>`
            )
            $authBanner.append($linkSection)
        }

        // Hide form content (algorithms, parameters, submit button) until authenticated
        $('#mjs-form-content').hide()

        // Hide jobs section until authenticated
        $('.mjs-jobs').hide()
    }

    // Store render functions on Workflows object so connect() can call them
    Workflows._renderUnauthenticated = renderUnauthenticated
    Workflows._renderAuthenticated = renderAuthenticated
    Workflows._populateAlgorithmDropdown = populateAlgorithmDropdown

    function renderAuthenticated() {
        $authBanner.empty()

        const $row = $(
            `<div class="mjs-auth-ok">Connected · ${escapeHTML(
                Workflows.baseUrl
            )} <a class="mjs-signout" href="#">sign out</a></div>`
        )
        $row.find('.mjs-signout').on('click', function (e) {
            e.preventDefault()
            // Stop polling
            if (Workflows.pollTimer) {
                clearInterval(Workflows.pollTimer)
                Workflows.pollTimer = null
            }
            // Clear the token and user ID from memory
            Workflows.personalAccessToken = null
            Workflows.maapUserId = null
            // Clear jobs
            Workflows.jobs = {}
            Workflows.jobIds = []
            Workflows.lastRefreshTime = null
            // Hide jobs section and form content
            $('.mjs-jobs').hide()
            $('#mjs-form-content').hide()
            renderUnauthenticated()
        })

        $authBanner.append($row)

        // Show form content (algorithms, parameters, submit button) now that user is authenticated
        $('#mjs-form-content').show()

        // Populate algorithm dropdown (already fetched in make())
        populateAlgorithmDropdown()

        // Populate queue dropdown from MAAP API
        populateQueueDropdown()

        // Enable submit button
        $submit.text('Submit Job').attr('disabled', false)

        // Show jobs section now that user is authenticated
        $('.mjs-jobs').show()

        // Pull existing jobs for this MAAP user from the database
        Workflows.refreshFromServer()
    }

    // Cascade: algorithm → version → deployer → processID
    $('#mjs-algorithm-select').on('change', function () {
        Workflows.selectedAlgorithmId = $(this).val()
        Workflows.selectedVersion = null
        Workflows.selectedDeployer = null
        Workflows.selectedProcessID = null
        $('#mjs-version-select').val('').attr('disabled', true)
        $('#mjs-deployer-select').val('').attr('disabled', true)
        if (Workflows.selectedAlgorithmId) {
            populateVersionDropdown(Workflows.selectedAlgorithmId)
        }
        // Clear map selections when algorithm changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $('#mjs-version-select').on('change', function () {
        Workflows.selectedVersion = $(this).val()
        Workflows.selectedDeployer = null
        Workflows.selectedProcessID = null
        $('#mjs-deployer-select').val('').attr('disabled', true)
        if (Workflows.selectedAlgorithmId && Workflows.selectedVersion) {
            populateDeployerDropdown(Workflows.selectedAlgorithmId, Workflows.selectedVersion)
        }
        // Clear map selections when version changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $('#mjs-deployer-select').on('change', function () {
        const processID = parseInt($(this).val(), 10)
        if (isNaN(processID)) {
            Workflows.selectedProcessID = null
            Workflows.selectedDeployer = null
        } else {
            Workflows.selectedProcessID = processID
            const proc = PROCESSES.find((p) => p.processID === processID)
            Workflows.selectedDeployer = proc ? proc.deployedBy : null
        }
        // Clear map selections when deployer changes
        MapSelection.clearPersistentLayers()
        renderSelectedProcess()
    })

    $submit.on('click', function () {
        // Check authentication first
        if (!Workflows.personalAccessToken) {
            window.alert('Please enter your personal access token to connect before submitting a job.')
            return
        }

        // Then check if algorithm is selected
        if (!Workflows.selectedProcessID) {
            window.alert('Please select an algorithm, version, and deployer.')
            return
        }

        // Only validate queue if the queue section is visible (queues enabled)
        const $queueSection = $('.mjs-queue-section')
        if ($queueSection.is(':visible')) {
            const queue = $queueSelect.val()
            if (!queue) {
                window.alert('Please select a queue.')
                $queueSelect.trigger('focus')
                return
            }
        }

        // Sanitize tag/name input to prevent XSS
        const tag = sanitizeInput($tagInput.val().trim())
        const payload = collectPayload()

        // Remove queue from payload if queues are disabled
        if (!$queueSection.is(':visible') && payload.queue !== undefined) {
            delete payload.queue
        }

        $submit.attr('disabled', true).text('Submitting…')
        Workflows.submit(Workflows.selectedProcessID, payload, tag)
            .then(() => {
                $submit.attr('disabled', false).text('Submit Job')
                $tagInput.val('')
                // Clear any persistent map selections (bbox rectangles, point markers)
                MapSelection.clearPersistentLayers()
            })
            .catch((err) => {
                $submit.attr('disabled', false).text('Submit Job')
                console.error('[MapJobSubmitTool] Submit error:', err)
                // Display error message to user
                const errorMsg = err.message || 'Unknown error occurred'
                window.alert(`Job Submission Failed\n\n${errorMsg}`)
            })
    })

    if (!Workflows.baseUrl) {
        $authBanner.append(
            '<div class="mjs-auth-msg">No API Base URL configured. Set it in the Configure page under Tools → Workflows.</div>'
        )
        $submit.text('Not configured').attr('disabled', true)
    } else {
        // Check if user is already authenticated (token persists across tool switches)
        if (Workflows.personalAccessToken && Workflows.maapUserId) {
            // User is already authenticated - render authenticated state
            renderAuthenticated()
        } else {
            // Show the token input form
            renderUnauthenticated()
        }
        // Populate algorithm dropdown if processes are already loaded
        populateAlgorithmDropdown()
    }

    this.separateFromMMGIS = function () {}
}

const MapJobSubmit = Workflows
export default MapJobSubmit
