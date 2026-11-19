// UI building functions - forms, pagination, expanded job views

import $ from 'jquery'
import * as Utils from './utils.js'

/**
 * Builds a form from process inputs (algorithms with input schemas)
 * Returns a collector function that gathers the form values as a payload
 *
 * @param {Object} MapSelection - The MapSelection object from the main tool (for persistent layers)
 */
export function buildFormFromInputs($parent, inputs, $queueSelect, $tagInput, Map_, shouldShowMapSelect, MapSelection) {
    $parent.empty()
    if (!inputs || Object.keys(inputs).length === 0) {
        $parent.append('<div class="mjs-empty">No parameters required.</div>')
        return () => ({
            queue: ($queueSelect && $queueSelect.val()) || '',
            tag: ($tagInput && $tagInput.val().trim()) || '',
            inputs: {}
        })
    }

    const inputRefs = []

    // First pass: detect if we have both lat and lon fields
    let latKey = null
    let lonKey = null
    Object.keys(inputs).forEach((key) => {
        const normalized = Utils.normalizeInputKey(key)
        if (Utils.LAT_VARIATIONS.includes(normalized)) {
            latKey = key
        } else if (Utils.LON_VARIATIONS.includes(normalized)) {
            lonKey = key
        }
    })

    const hasLatLonPair = latKey && lonKey
    let lastLatLonField = null // Track the last lat or lon field to insert button after

    Object.entries(inputs).forEach(([key, input]) => {
        const id = `mjs-input-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
        const $field = $('<div class="mjs-field"></div>')

        // Determine input type
        const inputType = (input.type || '').toLowerCase()

        // Check if this is a bbox field (contains any bbox variation)
        const isBbox = Utils.containsBboxVariation(key)

        // Check if this is a lat/lon combo field (single field containing both lat and lon)
        const isLatLonCombo = Utils.containsLatLonCombo(key)

        // Label using the input name/key
        const typeLabel = inputType ? ` <span class="mjs-field-type">${Utils.escapeHTML(inputType)}</span>` : ''
        $field.append(
            `<div class="mjs-field-label"><label for="${id}">${Utils.escapeHTML(key)}</label>${typeLabel}</div>`
        )

        let $input
        if (isBbox) {
            // Special handling for bbox: 4 coordinate fields + format selector
            // Validate that type is string, array, or text
            if (inputType !== 'string' && inputType !== 'array' && inputType !== 'text') {
                $field.append(
                    '<div class="mjs-bbox-error">⚠ bbox must be string, array, or text type</div>'
                )
                $parent.append($field)
                return
            }

            // Create 4 input fields for bbox coordinates
            const $bboxGrid = $('<div class="mjs-bbox-grid"></div>')

            const $minLon = $('<input type="number" step="any" placeholder="Min Lon" class="mjs-bbox-input" data-bbox-field="min_lon" />')
            const $minLat = $('<input type="number" step="any" placeholder="Min Lat" class="mjs-bbox-input" data-bbox-field="min_lat" />')
            const $maxLon = $('<input type="number" step="any" placeholder="Max Lon" class="mjs-bbox-input" data-bbox-field="max_lon" />')
            const $maxLat = $('<input type="number" step="any" placeholder="Max Lat" class="mjs-bbox-input" data-bbox-field="max_lat" />')

            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Min Lon</label></div>').append($minLon)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Min Lat</label></div>').append($minLat)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Max Lon</label></div>').append($maxLon)
            )
            $bboxGrid.append(
                $('<div class="mjs-bbox-field"><label>Max Lat</label></div>').append($maxLat)
            )

            $field.append($bboxGrid)

            // Add "Submit as" text input showing the raw formatted values
            const $formatLabel = $('<div class="mjs-bbox-format-label">Submit as</div>')
            const $formatInput = $('<input type="text" class="mjs-bbox-format-input" readonly />')

            // Set initial placeholder text
            let placeholderText = ''
            if (inputType === 'array') {
                placeholderText = '[min_longitude, min_latitude, max_longitude, max_latitude]'
            } else {
                // string or text type
                placeholderText = 'min_longitude,min_latitude,max_longitude,max_latitude'
            }
            $formatInput.val(placeholderText)

            // Function to update the "Submit as" field with raw values
            const updateFormatDisplay = () => {
                const minLon = $minLon.val()
                const minLat = $minLat.val()
                const maxLon = $maxLon.val()
                const maxLat = $maxLat.val()

                if (minLon && minLat && maxLon && maxLat) {
                    let formatted = ''
                    if (inputType === 'array') {
                        formatted = `[${minLon}, ${minLat}, ${maxLon}, ${maxLat}]`
                    } else {
                        // string or text type
                        formatted = `${minLon},${minLat},${maxLon},${maxLat}`
                    }
                    $formatInput.val(formatted)
                } else {
                    // Show placeholder text when fields are empty
                    $formatInput.val(placeholderText)
                }
            }

            // Function to update the bbox rectangle on the map
            const updateBboxOnMap = () => {
                const minLon = parseFloat($minLon.val())
                const minLat = parseFloat($minLat.val())
                const maxLon = parseFloat($maxLon.val())
                const maxLat = parseFloat($maxLat.val())

                if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {
                    if (Map_ && Map_.map) {
                        const map = Map_.map
                        const L = window.L

                        // Remove existing rectangle if present
                        if (MapSelection.persistentLayers[key]) {
                            try {
                                map.removeLayer(MapSelection.persistentLayers[key])
                            } catch (err) {
                                console.warn('[MapJobSubmitTool] Failed to remove bbox layer:', err)
                            }
                        }

                        // Create a single rectangle (Leaflet handles wrapping automatically)
                        // Note: For dateline-crossing bboxes where minLon > maxLon,
                        // the rectangle will wrap around the world as intended
                        const rect = L.rectangle([[minLat, minLon], [maxLat, maxLon]], {
                            color: '#ff8800',
                            weight: 2,
                            fillOpacity: 0.2
                        }).addTo(map)

                        const crossesDateline = minLon > maxLon
                        const popupText = crossesDateline
                            ? `Selected Bbox (crosses dateline)<br>W: ${minLon.toFixed(6)}<br>S: ${minLat.toFixed(6)}<br>E: ${maxLon.toFixed(6)}<br>N: ${maxLat.toFixed(6)}<br><small>Spans ${(360 - (minLon - maxLon)).toFixed(1)}° longitude</small>`
                            : `Selected Bbox<br>W: ${minLon.toFixed(6)}<br>S: ${minLat.toFixed(6)}<br>E: ${maxLon.toFixed(6)}<br>N: ${maxLat.toFixed(6)}`
                        rect.bindPopup(popupText)

                        // Store the rectangle
                        MapSelection.persistentLayers[key] = rect
                    }
                }
            }

            // Update the format display and map whenever any bbox field changes
            $minLon.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $minLat.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $maxLon.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })
            $maxLat.on('input', () => {
                updateFormatDisplay()
                updateBboxOnMap()
            })

            $field.append($formatLabel)
            $field.append($formatInput)

            // Add "Select on Map" button
            const $mapBtn = $('<button type="button" class="mjs-map-select-btn mjs-bbox-map-btn" data-input-key="' + Utils.escapeHTML(key) + '">Select on Map</button>')
            $field.append($mapBtn)

            // Store reference to all bbox components
            inputRefs.push({
                key,
                type: inputType,
                isBbox: true,
                $minLon,
                $minLat,
                $maxLon,
                $maxLat,
                $formatInput
            })
        } else if (inputType === 'boolean') {
            // Boolean toggle switch
            const defaultValue = input.default != null ? input.default : false
            const checked = defaultValue === true || defaultValue === 'true'

            const $toggleWrapper = $('<div class="mjs-toggle-wrapper"></div>')
            $input = $('<input type="checkbox" class="mjs-toggle-input" />')
                .attr('id', id)
                .prop('checked', checked)
            const $slider = $('<span class="mjs-toggle-slider"></span>')

            // Make the slider clickable
            $slider.on('click', function() {
                $input.prop('checked', !$input.prop('checked'))
            })

            $toggleWrapper.append($input).append($slider)
            $field.append($toggleWrapper)
            inputRefs.push({ key, $input, type: inputType })
        } else {
            // Text input for all other types
            const defaultValue = input.default != null ? String(input.default) : ''
            $input = $('<input type="text" />')
                .attr('id', id)
                .attr('placeholder', input.placeholder || '')
                .val(defaultValue)

            // Check if this is a lat or lon field (for separate lat/lon pairs)
            const isLatOrLon = Utils.LAT_VARIATIONS.includes(Utils.normalizeInputKey(key)) ||
                               Utils.LON_VARIATIONS.includes(Utils.normalizeInputKey(key))

            // Add map select button if applicable
            // Show button for:
            // 1. Lat/lon combo fields (single field with both lat and lon in name)
            // 2. Individual lat/lon fields that are NOT part of a pair
            // 3. Any other field that shouldShowMapSelect returns true for
            const shouldShowButton = shouldShowMapSelect(key) &&
                                    !(hasLatLonPair && isLatOrLon) // Skip individual buttons if we have a lat/lon pair

            if (shouldShowButton) {
                const $inputWrapper = $('<div class="mjs-input-with-btn"></div>')
                $inputWrapper.append($input)
                const $mapBtn = $('<button type="button" class="mjs-map-select-btn" data-input-key="' + Utils.escapeHTML(key) + '">Select on Map</button>')
                $inputWrapper.append($mapBtn)
                $field.append($inputWrapper)
            } else {
                $field.append($input)
            }
            inputRefs.push({ key, $input, type: inputType })
        }

        // Description if provided
        if (input.description) {
            $field.append(
                `<div class="mjs-field-description">${Utils.escapeHTML(input.description)}</div>`
            )
        }

        $parent.append($field)

        // Track if this is a lat or lon field for button placement
        if (hasLatLonPair && (key === latKey || key === lonKey)) {
            lastLatLonField = $field
        }
    })

    // Add a single "Select Point on Map" button after the last lat/lon field
    if (hasLatLonPair && lastLatLonField) {
        const $pointBtn = $('<button type="button" class="mjs-select-point-btn" data-lat-key="' + Utils.escapeHTML(latKey) + '" data-lon-key="' + Utils.escapeHTML(lonKey) + '">Select Point on Map</button>')
        lastLatLonField.after($pointBtn)

        // Add listeners to update the point marker when lat/lon fields change
        const $latInput = $(`#mjs-input-${latKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)
        const $lonInput = $(`#mjs-input-${lonKey.replace(/[^A-Za-z0-9_-]/g, '_')}`)

        const updatePointOnMap = () => {
            const lat = parseFloat($latInput.val())
            const lon = parseFloat($lonInput.val())

            if (!isNaN(lat) && !isNaN(lon)) {
                if (Map_ && Map_.map) {
                    const map = Map_.map
                    const L = window.L

                    // Remove existing marker if present
                    const markerKey = 'latlon-pair'
                    if (MapSelection.persistentLayers[markerKey]) {
                        try {
                            map.removeLayer(MapSelection.persistentLayers[markerKey])
                        } catch (err) {
                            console.warn('[MapJobSubmitTool] Failed to remove point marker:', err)
                        }
                    }

                    // Create new marker
                    const marker = L.circleMarker([lat, lon], {
                        radius: 8,
                        color: '#00A9E0',
                        fillColor: '#00A9E0',
                        fillOpacity: 0.6,
                        weight: 2
                    }).addTo(map)
                    marker.bindPopup(`Selected Point<br>Lat: ${lat.toFixed(6)}<br>Lon: ${lon.toFixed(6)}`)

                    // Store the new marker
                    MapSelection.persistentLayers[markerKey] = marker
                }
            }
        }

        if ($latInput.length && $lonInput.length) {
            $latInput.on('input', updatePointOnMap)
            $lonInput.on('input', updatePointOnMap)
        }
    }

    return function collectPayload() {
        const inputs = {}
        inputRefs.forEach((ref) => {
            const { key, $input, type, isBbox } = ref

            if (isBbox) {
                // Collect bbox coordinates - use raw values as-is
                const minLon = parseFloat(ref.$minLon.val())
                const minLat = parseFloat(ref.$minLat.val())
                const maxLon = parseFloat(ref.$maxLon.val())
                const maxLat = parseFloat(ref.$maxLat.val())

                // Only add if all values are present
                if (!isNaN(minLon) && !isNaN(minLat) && !isNaN(maxLon) && !isNaN(maxLat)) {

                    // Order: [min_longitude, min_latitude, max_longitude, max_latitude]
                    // Format based on the input type from the algorithm
                    if (type === 'array') {
                        inputs[key] = [minLon, minLat, maxLon, maxLat]
                    } else {
                        // String or text format: "min_lon,min_lat,max_lon,max_lat"
                        inputs[key] = `${minLon},${minLat},${maxLon},${maxLat}`
                    }
                }
            } else if (type === 'boolean') {
                inputs[key] = $input.is(':checked')
            } else {
                const val = $input.val()
                if (val !== '') {
                    // Convert to number if it's a numeric input type or lat/lon
                    if (Utils.shouldBeNumeric(key, type)) {
                        const num = parseFloat(val)
                        if (!isNaN(num)) {
                            inputs[key] = num
                        } else {
                            inputs[key] = val // Keep as string if conversion fails
                        }
                    } else {
                        inputs[key] = val
                    }
                }
            }
        })
        return {
            queue: ($queueSelect && $queueSelect.val()) || '',
            tag: ($tagInput && $tagInput.val().trim()) || '',
            inputs: inputs
        }
    }
}

// NOTE: buildForm / buildExpandedSection / renderPagination /
// updateLastRefreshDisplay were removed from this module — MapJobSubmitTool.js
// has its own versions of these that are actually wired up to the DOM/state
// used by that tool (different signatures than what was drafted here). Only
// buildFormFromInputs above is currently used.
