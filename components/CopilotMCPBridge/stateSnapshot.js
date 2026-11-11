// Snapshot of the MMGIS browser state that Copilot actions can change. Used
// with stateDiff.js to confirm what a command actually did.

import L_ from '@basics/Layers_/Layers_'
import TimeControl from '@basics/TimeControl_/TimeControl'

function round(value, digits = 6) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null
    const f = Math.pow(10, digits)
    return Math.round(value * f) / f
}

function safe(fn, fallback = null) {
    try {
        const v = fn()
        return v === undefined ? fallback : v
    } catch (_) {
        return fallback
    }
}

function highlightExpression(url) {
    if (typeof url !== 'string') return null
    const q = url.split('?')[1]
    if (!q) return null
    try {
        return new URLSearchParams(q).get('expression')
    } catch (_) {
        return null
    }
}

export function takeSnapshot() {
    const api = window.mmgisAPI || {}
    const map = api.map
    const configs = safe(() => api.getLayerConfigs(), {}) || {}
    const visible = safe(() => api.getVisibleLayers(), {}) || {}
    const live = safe(() => api.getLayers(), {}) || {}
    const opacities = (L_ && L_.layers && L_.layers.opacity) || {}

    const layers = {}
    Object.keys(configs).forEach((uuid) => {
        const cfg = configs[uuid] || {}
        if (cfg.type === 'header') return
        const inst = live[uuid]
        const timeEnabled = !!(cfg.time && cfg.time.enabled)
        layers[uuid] = {
            name: cfg.display_name || cfg.name || uuid,
            type: cfg.type || null,
            visible: !!visible[uuid],
            on_map: !!(inst && inst._map),
            opacity: round(opacities[uuid], 4),
            time: timeEnabled
                ? {
                      start: safe(() => api.getLayerStartTime(uuid)),
                      end: safe(() => api.getLayerEndTime(uuid)),
                  }
                : null,
        }
    })

    const overlayStore = window.__mmgisAgentChatOverlays || {}
    const tile = overlayStore.highlightTile
    const overlays = {}
    Object.keys(overlayStore).forEach((key) => {
        const group = overlayStore[key]
        if (key === 'highlightTile' || !group || typeof group.getLayers !== 'function') return
        overlays[key] = {
            features: group.getLayers().length,
            on_map: !!(map && map.hasLayer && map.hasLayer(group)),
        }
    })

    const center = map ? safe(() => map.getCenter()) : null
    const bounds = map ? safe(() => map.getBounds()) : null
    const controller = window.ToolController_ || {}

    return {
        captured_at: new Date().toISOString(),
        mission: (L_ && L_.mission) || null,
        map: map
            ? {
                  center: center ? { lat: round(center.lat), lng: round(center.lng) } : null,
                  zoom: round(safe(() => map.getZoom()), 4),
                  bounds: bounds
                      ? [
                            round(bounds.getWest()),
                            round(bounds.getSouth()),
                            round(bounds.getEast()),
                            round(bounds.getNorth()),
                        ]
                      : null,
                  crs: safe(() => L_.configData.projection.epsg) || 'EPSG:3857',
              }
            : null,
        time: {
            enabled: !!(TimeControl && TimeControl.enabled),
            start: safe(() => api.getStartTime()),
            end: safe(() => api.getEndTime()),
            current: safe(() => api.getTime()),
        },
        layers,
        highlight: tile
            ? {
                  active: !!(map && map.hasLayer && map.hasLayer(tile)),
                  opacity: round(safe(() => tile.options.opacity), 4),
                  expression: highlightExpression(tile._url),
              }
            : { active: false, opacity: null, expression: null },
        overlays,
        animation_ui: !!document.getElementById('mmgis-animation-overlay'),
        tools: {
            active: controller.activeToolName || null,
            separated: Array.isArray(controller.activeSeparatedTools)
                ? controller.activeSeparatedTools.slice()
                : [],
            available: Array.isArray(controller.toolModuleNames)
                ? controller.toolModuleNames.slice()
                : [],
        },
    }
}
