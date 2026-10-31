// Per-tool confirmation of what a Copilot action did, computed from state
// snapshots taken before and after the action, the handler's return value,
// its output and the analytics API responses it received.
//
// status: 'succeeded' | 'no_effect' (handler ran, requested change did not
// happen) | 'failed'. verified: true/false when a check was possible, null for
// read-only or simulated operations.

export const HIGHLIGHT_OPERATORS = ['>', '>=', '<', '<=']

const OVERLAY_KEYS = {
    calculate_layer_mean: 'mean',
    multilayer_statistics: 'multilayer-stats',
    temporal_trends: 'temporal-trends',
    spatial_statistics: 'spatial-analysis',
    change_detection: 'change-detection',
}

function check(name, expected, actual, ok) {
    return { check: name, expected, actual, ok: !!ok }
}

function close(a, b, tolerance) {
    return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tolerance
}

function layerById(state, id) {
    return id && state && state.layers ? state.layers[id] || null : null
}

function apiCall(apiCalls, pattern) {
    return (apiCalls || []).filter((c) => pattern.test(c.url || '')).pop() || null
}

function done(status, verified, checks = [], notes = [], error = null) {
    return { status, verified, checks, notes, error }
}

function fromChecks(checks, notes = [], failureMessage = null) {
    const ok = checks.every((c) => c.ok)
    return done(ok ? 'succeeded' : 'failed', ok, checks, notes, ok ? null : { code: 'EXECUTION_FAILED', message: failureMessage || 'The resulting state does not match the request.' })
}

function firstLine(output) {
    return (output || []).join('\n').split('\n').find((l) => l.trim()) || ''
}

function overlayCheck(tool, after, required = true) {
    const key = OVERLAY_KEYS[tool]
    if (!key || !required) return []
    const overlay = after && after.overlays ? after.overlays[key] : null
    return [check(`analysis area drawn ('${key}' overlay)`, true, !!(overlay && overlay.features > 0), overlay && overlay.features > 0)]
}

function readOnly({ output }) {
    return (output || []).length
        ? done('succeeded', null, [], ['Read-only operation; no map state change expected.'])
        : done('failed', false, [], [], { code: 'EXECUTION_FAILED', message: 'The Copilot handler produced no output.' })
}

// The Copilot handlers announce the tool as opened even when the mission does
// not include it; report that as unavailable instead of a success.
function toolOpened(moduleName, label, after) {
    const tools = (after && after.tools) || {}
    if (Array.isArray(tools.available) && tools.available.length && !tools.available.includes(moduleName)) {
        return done('failed', false, [check('tool enabled in this mission', moduleName, tools.available, false)], [], {
            code: 'CAPABILITY_UNAVAILABLE',
            message: `The ${label} tool is not enabled for this mission, so nothing was opened (the Copilot handler's message claims otherwise). Enable '${label}' in the mission's Tools configuration.`,
        })
    }
    return fromChecks([check('active tool', moduleName, tools.active || null, tools.active === moduleName)])
}

const VERIFIERS = {
    toggle_layer({ args, after, targetId }) {
        const layer = layerById(after, targetId)
        const actual = layer ? layer.visible : null
        return fromChecks(
            [check(`layer '${args.name}' visible`, args.visible, actual, actual === args.visible)],
            [],
            `Layer '${args.name}' is ${actual === null ? 'not found' : actual ? 'visible' : 'hidden'} after the toggle.`
        )
    },

    set_layer_opacity({ args, after, returnValue }) {
        const layer = layerById(after, returnValue && returnValue.id)
        const actual = layer ? layer.opacity : null
        return fromChecks([check(`layer '${args.name}' opacity`, args.opacity, actual, close(actual, args.opacity, 0.001))])
    },

    zoom_to({ args, after, extras = {} }) {
        if (Array.isArray(args.center)) {
            const c = after && after.map ? after.map.center : null
            return fromChecks([
                check('map center [lon, lat]', args.center, c ? [c.lng, c.lat] : null, !!c && close(c.lng, args.center[0], 1e-3) && close(c.lat, args.center[1], 1e-3)),
                check('map zoom', args.zoom, after && after.map ? after.map.zoom : null, after && after.map && close(after.map.zoom, args.zoom, 1e-6)),
            ])
        }
        const fit = extras.bboxFit
        return fromChecks([
            check('map fitted to the bbox like Leaflet fitBounds (center within 2 px, same zoom)', fit ? fit.expected : 'fitted view', fit ? fit.actual : null, !!(fit && fit.fitted)),
        ])
    },

    set_time({ returnValue, before, after, output }) {
        if (!returnValue || !returnValue.ok) {
            return done('no_effect', false, [], [], { code: 'EXECUTION_FAILED', message: firstLine(returnValue && returnValue.lines) || firstLine(output) || 'No layer accepted the time request.' })
        }
        const changed = JSON.stringify(before.time) !== JSON.stringify(after.time) ||
            Object.keys(after.layers || {}).some((id) => JSON.stringify((before.layers[id] || {}).time) !== JSON.stringify(after.layers[id].time))
        const notes = (returnValue.skipped || []).map((s) => `Skipped ${s.name}: ${s.reason}`)
        return fromChecks(
            [
                check('layers updated by the handler', '>= 1', (returnValue.updates || []).length, (returnValue.updates || []).length > 0),
                check('time window / layer times changed (or already at the requested time)', true, changed, changed || (returnValue.updates || []).length > 0),
            ],
            notes
        )
    },

    threshold_highlight({ args, returnValue, after, output }) {
        if (!returnValue || returnValue.found === false) {
            return done('no_effect', false, [], [], { code: 'EXECUTION_FAILED', message: firstLine(output) || 'No matching layer to highlight.' })
        }
        const notes = []
        if (!HIGHLIGHT_OPERATORS.includes(args.operator)) {
            notes.push(`The Copilot highlight handler supports ${HIGHLIGHT_OPERATORS.join(' ')}; operator '${args.operator}' was executed as '${returnValue.operator}'.`)
        }
        return fromChecks(
            [
                check('highlight overlay active', true, after.highlight.active, after.highlight.active),
                check('highlight expression', returnValue.expression, after.highlight.expression, after.highlight.expression === returnValue.expression),
            ],
            notes
        )
    },

    highlight_toggle({ returnValue, after, output }) {
        if (!returnValue || returnValue.overlay === false) {
            return done('no_effect', false, [], [], { code: 'EXECUTION_FAILED', message: firstLine(output) || 'No highlight overlay to hide/show.' })
        }
        return fromChecks([check('highlight opacity', returnValue.opacity, after.highlight.opacity, close(after.highlight.opacity, returnValue.opacity, 0.001))])
    },

    highlight_clear({ returnValue, after }) {
        const notes = returnValue && returnValue.overlay === false ? ['No highlight overlay was present; the map is already clear.'] : []
        return fromChecks([check('highlight overlay active', false, after.highlight.active, after.highlight.active === false)], notes)
    },

    highlight_opacity({ args, returnValue, after, output }) {
        if (!returnValue || returnValue.overlay === false) {
            return done('no_effect', false, [], [], { code: 'EXECUTION_FAILED', message: firstLine(output) || 'No highlight overlay to adjust.' })
        }
        const notes = []
        const requested = (returnValue.previous || 0) + Number(args.delta)
        if (!close(requested, returnValue.opacity, 0.001)) notes.push(`Opacity is clamped to [0.05, 0.4] by the Copilot handler (requested ${requested.toFixed(3)}).`)
        return fromChecks([check('highlight opacity', returnValue.opacity, after.highlight.opacity, close(after.highlight.opacity, returnValue.opacity, 0.001))], notes)
    },

    calculate_layer_mean({ returnValue, after, apiCalls, output }) {
        if (!returnValue || returnValue.supported === false) {
            return done('failed', false, [], [], { code: 'EXECUTION_FAILED', message: firstLine(output) || 'Statistics are not available for this layer.' })
        }
        const mean = returnValue.stats && returnValue.stats.mean
        const checks = [check('mean computed', 'number', typeof mean, typeof mean === 'number')]
        if (returnValue.source === 'server') {
            const call = apiCall(apiCalls, /\/api\/agent\/analytics\/statistics/)
            checks.push(check('value equals /api/agent/analytics/statistics response', mean, call && call.body ? call.body.mean : null, !!call && call.status === 200 && call.body && call.body.mean === mean))
        }
        return fromChecks([...checks, ...overlayCheck('calculate_layer_mean', after)], [`Statistics source: ${returnValue.source}.`])
    },

    calculate_layer_difference({ returnValue, apiCalls, output }) {
        if (!returnValue || returnValue.error) {
            return done('failed', false, [], [], { code: 'EXECUTION_FAILED', message: (returnValue && returnValue.error) || firstLine(output) || 'Difference computation failed.' })
        }
        const call = apiCall(apiCalls, /\/api\/agent\/analytics\/difference/)
        return fromChecks([
            check('difference mean computed', 'number', typeof returnValue.mean, typeof returnValue.mean === 'number'),
            check('value equals /api/agent/analytics/difference response', returnValue.mean, call && call.body ? call.body.mean : null, !!call && call.status === 200 && call.body && call.body.mean === returnValue.mean),
        ])
    },

    detect_anomalies({ returnValue }) {
        return done('succeeded', null, [], [
            returnValue && returnValue.simulated
                ? 'SIMULATED: the existing Copilot anomaly handler reports fixed placeholder statistics; nothing was computed from the layer data.'
                : 'Anomaly handler completed.',
        ])
    },

    multilayer_statistics({ returnValue, after }) {
        return fromChecks([check('statistics returned', true, !!returnValue, !!returnValue), ...overlayCheck('multilayer_statistics', after)])
    },

    temporal_trends({ returnValue, after }) {
        return fromChecks([check('trend results returned', true, !!returnValue, !!returnValue), ...overlayCheck('temporal_trends', after)])
    },

    spatial_statistics({ args, returnValue, after }) {
        const drawn = args.visualize !== false && !!(returnValue && returnValue.spatialStats)
        return fromChecks([check('spatial statistics returned', true, !!returnValue, !!returnValue), ...overlayCheck('spatial_statistics', after, drawn)])
    },

    change_detection({ args, returnValue, after }) {
        return fromChecks([check('change detection results returned', true, !!returnValue, !!returnValue), ...overlayCheck('change_detection', after, args.visualize !== false)])
    },

    time_series_animation({ returnValue, after }) {
        return fromChecks([
            check('animation created', true, !!returnValue, !!returnValue),
            check('animation controls shown', true, after.animation_ui, after.animation_ui),
        ])
    },

    data_export({ returnValue }) {
        return fromChecks(
            [check('export prepared', 'ready', returnValue && returnValue.status, !!returnValue && returnValue.status === 'ready')],
            ['SYNTHETIC: the existing Copilot export handler generates sample values; the file does not contain raster pixels.']
        )
    },

    open_animation_tool({ after }) {
        return toolOpened('AnimationTool', 'Animation', after)
    },

    run_analysis({ after, output }) {
        if (/not available/i.test(firstLine(output))) {
            return done('failed', false, [], [], { code: 'CAPABILITY_UNAVAILABLE', message: firstLine(output) })
        }
        return toolOpened('AnalysisTool', 'Analysis', after)
    },

    describe_layer({ returnValue, after, output }) {
        const base = readOnly({ output })
        if (returnValue && returnValue.found && returnValue.id) {
            const layer = layerById(after, returnValue.id)
            if (layer && layer.visible !== returnValue.visible) {
                base.notes.push(`The Copilot handler printed 'Visible: ${returnValue.visible ? 'Yes' : 'No'}'; the layer is actually ${layer.visible ? 'visible' : 'hidden'} (see data.actual_state).`)
            }
        }
        return base
    },
}

export function verifyCommand(tool, ctx) {
    if (ctx.error) {
        return done('failed', false, [], [], { code: ctx.error.code || 'EXECUTION_FAILED', message: ctx.error.message || String(ctx.error) })
    }
    const verifier = VERIFIERS[tool] || readOnly
    return verifier({ output: [], args: {}, apiCalls: [], extras: {}, ...ctx })
}

export const VERIFIED_TOOLS = Object.keys(VERIFIERS)
