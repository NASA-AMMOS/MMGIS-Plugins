// Executes bridge commands in this MMGIS page with the Copilot's own code:
// layer-name resolution and conflict rules from AgentChat/agentActions, the
// window.mmgisAPI adapter semantics of AgentChat's execMmgisApi, and the
// RENDERERS handlers. Each command is confirmed by comparing state snapshots.

import RENDERERS from '../../tools/AgentChat/renderers'
import {
    buildAgentLayerIndex,
    findAgentLayerMatch,
    prepareActionLayerArgs,
    resolveDisplayNameToLayerId,
    applyLayerConflictRules,
    collectAgentLayers,
    buildAgentContextFromLayers,
} from '../../tools/AgentChat/agentActions'
import { tryLocalCopilotCommand } from '../../tools/AgentChat/localCommands'
import { startCapture, waitForCopilotIdle } from './capture'
import { takeSnapshot } from './stateSnapshot'
import { summarizeSnapshot, diffSnapshots } from './stateDiff'
import { verifyCommand } from './verifiers'

const UNDO_LIMIT = 25 // same cap as the Copilot chat
const undoStack = []

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function codedError(code, message) {
    const err = new Error(message)
    err.code = code
    return err
}

// Records map movement that starts while a command runs, so the after-state is
// read once the move/zoom animation has ended.
function trackMapMovement() {
    const map = window.mmgisAPI && window.mmgisAPI.map
    if (!map || typeof map.on !== 'function') return { animationsDisabled: false, moving: () => false, waitForEnd: async () => {}, stop() {} }
    const animationsDisabled = document.visibilityState === 'hidden'
    const restoreAnimations = animationsDisabled ? disableMapAnimations() : () => {}
    let moving = false
    let onIdle = null
    const onStart = () => {
        moving = true
    }
    const onEnd = () => {
        moving = false
        if (onIdle) onIdle()
    }
    map.on('movestart', onStart)
    map.on('moveend', onEnd)
    const animating = () => !!(map._animatingZoom || (map._panAnim && map._panAnim._inProgress))
    // Resolves on the next moveend or after 100 ms, whichever comes first.
    const tick = () =>
        new Promise((resolve) => {
            onIdle = resolve
            setTimeout(resolve, 100)
        })
    return {
        animationsDisabled,
        moving: () => moving || animating(),
        async waitForEnd(timeoutMs) {
            const deadline = Date.now() + timeoutMs
            while ((moving || animating()) && Date.now() < deadline) {
                await tick()
                onIdle = null
            }
        },
        stop() {
            map.off('movestart', onStart)
            map.off('moveend', onEnd)
            restoreAnimations()
        },
    }
}

// Resolves after `count` animation frames, or after timeoutMs if the browser
// is not rendering frames.
function nextFrames(count, timeoutMs) {
    return new Promise((resolve) => {
        let finished = false
        const finish = () => {
            if (!finished) {
                finished = true
                resolve()
            }
        }
        const step = (left) => (left <= 0 ? finish() : window.requestAnimationFrame(() => step(left - 1)))
        step(count)
        setTimeout(finish, timeoutMs)
    })
}

// Background tabs do not run requestAnimationFrame, so Leaflet's animated
// moves would only happen once the tab is shown again. While such a tab runs a
// command, map moves get Leaflet's own `animate: false` option instead.
const MAP_MOVE_OPTIONS_ARG = { setView: 2, fitBounds: 1, panTo: 1, flyTo: 2, flyToBounds: 1, setZoom: 1 }

function disableMapAnimations() {
    const map = window.mmgisAPI && window.mmgisAPI.map
    if (!map) return () => {}
    const restore = []
    for (const [name, index] of Object.entries(MAP_MOVE_OPTIONS_ARG)) {
        const original = map[name]
        if (typeof original !== 'function') continue
        const ownProperty = Object.prototype.hasOwnProperty.call(map, name)
        map[name] = function (...args) {
            args[index] = { ...(args[index] || {}), animate: false }
            return original.apply(this, args)
        }
        restore.push(() => {
            if (ownProperty) map[name] = original
            else delete map[name]
        })
    }
    return () => restore.forEach((fn) => fn())
}

// Lets map animations, layer loads and handler side effects finish.
async function settle(tool, movement) {
    await nextFrames(2, 1000) // Leaflet starts animated zooms on the next animation frame
    if (movement) await movement.waitForEnd(5000)
    if (['toggle_layer', 'set_time', 'threshold_highlight', 'time_series_animation', 'open_animation_tool', 'run_analysis', 'calculate_layer_difference', 'undo'].includes(tool)) {
        await sleep(700)
    }
}

function summarizeMatches(matches) {
    return (matches || []).map((m) => ({
        arg: m.key,
        requested: m.original,
        resolved: m.resolved,
        layer_id: m.uuid || null,
        exact: !!m.exact,
        score: typeof m.score === 'number' ? Math.round(m.score * 1000) / 1000 : null,
        group_path: m.groupPath || '',
    }))
}

// Where Leaflet's fitBounds puts the map for this bbox (zoom_view pads 16 px
// on each side), compared with where the map is. Projection independent.
const ZOOM_VIEW_PADDING_PX = 32

function bboxFit(bbox) {
    const map = window.mmgisAPI && window.mmgisAPI.map
    const L = window.L
    if (!map || !L || !Array.isArray(bbox) || bbox.length !== 4) return null
    try {
        const bounds = L.latLngBounds(L.latLng(bbox[1], bbox[0]), L.latLng(bbox[3], bbox[2]))
        const zoom = map.getBoundsZoom(bounds, false, L.point(ZOOM_VIEW_PADDING_PX, ZOOM_VIEW_PADDING_PX))
        const sw = map.project(bounds.getSouthWest(), zoom)
        const ne = map.project(bounds.getNorthEast(), zoom)
        const targetPx = sw.add(ne).divideBy(2)
        const target = map.unproject(targetPx, zoom)
        const center = map.getCenter()
        const offsetPx = map.project(center, zoom).distanceTo(targetPx)
        const round = (v) => Math.round(v * 1e6) / 1e6
        return {
            expected: { center: [round(target.lng), round(target.lat)], zoom: round(zoom) },
            actual: { center: [round(center.lng), round(center.lat)], zoom: round(map.getZoom()) },
            center_offset_px: Math.round(offsetPx * 10) / 10,
            fitted: Math.abs(map.getZoom() - zoom) < 1e-6 && offsetPx <= 2,
        }
    } catch (_) {
        return null
    }
}

// window.mmgisAPI adapter: same argument mapping, undo capture and conflict
// rules as AgentChat's execMmgisApi().
async function runMmgisApi(spec, prepared, layerIndex, userQuery, before) {
    const args = prepared.args || {}
    const matches = Array.isArray(prepared.__layerMatches) ? prepared.__layerMatches : []
    const nameMatch = matches.find((m) => m.key === 'name')
    const callArgs = []
    let targetId = null
    for (const key of spec.argOrder || []) {
        if (key === 'name' && spec.nameResolution === 'displayNameToInternalId') {
            const id = (nameMatch && nameMatch.uuid) || resolveDisplayNameToLayerId(args.name, layerIndex)
            if (!id) throw codedError('INVALID_INPUT', `Layer "${args.name}" not found.`)
            targetId = id
            callArgs.push(id)
        } else {
            callArgs.push(args[key])
        }
    }
    const fn = window.mmgisAPI && window.mmgisAPI[spec.method]
    if (typeof fn !== 'function') throw codedError('CAPABILITY_UNAVAILABLE', `API method "${spec.method}" not available.`)

    let undo = null
    if (spec.method === 'toggleLayer' && targetId) {
        undo = { method: 'toggleLayer', target: args.name, layerId: targetId, previous: { visible: !!(before.layers[targetId] || {}).visible } }
    }
    await fn.apply(window.mmgisAPI, callArgs)
    let conflictsTurnedOff = []
    if (spec.method === 'toggleLayer' && args.visible === true && targetId) {
        conflictsTurnedOff = await applyLayerConflictRules(targetId, userQuery)
    }
    return { returnValue: { method: spec.method, args: callArgs, conflicts_turned_off: conflictsTurnedOff }, targetId, undo }
}

// The chat records undo entries for mmgisAPI toggles and for zoom_to only.
function undoEntryFor(tool, before) {
    if (tool === 'zoom_to' && before.map && before.map.center) {
        return { tool: 'zoom_to', previous: { center: [before.map.center.lng, before.map.center.lat], zoom: before.map.zoom } }
    }
    return null
}

async function runCopilotAction(command, options) {
    const { tool, args = {}, spec = {} } = command
    await waitForCopilotIdle()
    // Like the chat: layer names are resolved in the context of the user's
    // request when the action came from one (copilot_ask).
    const userQuery = typeof command.user_query === 'string' && command.user_query
        ? command.user_query
        : typeof args.original_query === 'string' ? args.original_query : ''
    const layerIndex = buildAgentLayerIndex()
    const prep = prepareActionLayerArgs(
        { tool, args },
        { userQuery, findMatch: (value, query) => findAgentLayerMatch(value, query, layerIndex) }
    )
    if (prep.error) {
        return { ok: false, status: 'failed', error: { code: 'INVALID_INPUT', message: prep.error, details: { arg: prep.key } }, output: [] }
    }
    const prepared = prep.prepared
    const before = takeSnapshot()
    const capture = startCapture({ mirror: !!options.mirrorToCopilotPanel })
    const movement = trackMapMovement()
    let returnValue
    let thrown = null
    let targetId = null
    let undo = null
    try {
        if (spec.adapter === 'mmgisAPI') {
            ;({ returnValue, targetId, undo } = await runMmgisApi(spec, prepared, layerIndex, userQuery, before))
        } else if (spec.adapter === 'custom') {
            const handler = spec.uiType ? RENDERERS[spec.uiType] : null
            if (typeof handler !== 'function') {
                throw codedError('CAPABILITY_UNAVAILABLE', `Copilot handler '${spec.uiType}' is not available in this MMGIS build.`)
            }
            undo = undoEntryFor(tool, before)
            returnValue = await handler({}, prepared.args || {})
        } else {
            throw codedError('CAPABILITY_UNAVAILABLE', `Unsupported execution adapter '${spec.adapter}'.`)
        }
    } catch (err) {
        thrown = err
    } finally {
        capture.stop()
    }
    await settle(tool, movement)
    movement.stop()
    const after = takeSnapshot()
    const extras = tool === 'zoom_to' && Array.isArray(prepared.args && prepared.args.bbox) ? { bboxFit: bboxFit(prepared.args.bbox) } : {}
    const verification = verifyCommand(tool, {
        before,
        after,
        args: prepared.args || {},
        returnValue,
        output: capture.lines,
        error: thrown,
        matches: prep.matches,
        apiCalls: capture.apiCalls,
        targetId,
        extras,
    })
    if (verification.status === 'succeeded' && undo) {
        undoStack.push({ ...undo, ts: Date.now() })
        if (undoStack.length > UNDO_LIMIT) undoStack.shift()
    }
    let data = returnValue === undefined ? null : returnValue
    if (tool === 'describe_layer' && returnValue && returnValue.id && after.layers[returnValue.id]) {
        data = { ...returnValue, actual_state: after.layers[returnValue.id] }
    }
    const notes = movement.animationsDisabled
        ? [...verification.notes, 'The MMGIS tab was in the background, so map moves were applied without animation.']
        : verification.notes
    return {
        ok: verification.status === 'succeeded',
        status: verification.status,
        error: verification.error,
        output: capture.lines,
        returnValue: data,
        apiCalls: capture.apiCalls,
        resolvedArgs: prepared.args || {},
        layerMatches: summarizeMatches(prep.matches),
        verification: { verified: verification.verified, checks: verification.checks, notes },
        effects: diffSnapshots(before, after),
        state: summarizeSnapshot(after),
    }
}

// Same restore semantics as the Copilot chat's undoLast().
async function runUndo() {
    const entry = undoStack.pop()
    if (!entry) {
        return { ok: false, status: 'no_effect', error: { code: 'EXECUTION_FAILED', message: 'Nothing to undo.' }, output: ['Nothing to undo.'] }
    }
    const before = takeSnapshot()
    const movement = trackMapMovement()
    const output = []
    const checks = []
    if (entry.method === 'toggleLayer') {
        await window.mmgisAPI.toggleLayer(entry.layerId, entry.previous.visible)
        output.push(`Restored visibility for ${entry.target}.`)
    } else if (entry.tool === 'zoom_to') {
        const [lon, lat] = entry.previous.center
        window.mmgisAPI.map.setView([lat, lon], entry.previous.zoom)
        output.push('Restored previous view.')
    }
    await settle('undo', movement)
    movement.stop()
    const after = takeSnapshot()
    if (entry.method === 'toggleLayer') {
        const actual = (after.layers[entry.layerId] || {}).visible
        checks.push({ check: `layer '${entry.target}' visible`, expected: entry.previous.visible, actual, ok: actual === entry.previous.visible })
    } else if (entry.tool === 'zoom_to') {
        const c = after.map.center
        const ok = Math.abs(c.lng - entry.previous.center[0]) < 1e-3 && Math.abs(c.lat - entry.previous.center[1]) < 1e-3 && Math.abs(after.map.zoom - entry.previous.zoom) < 1e-6
        checks.push({ check: 'map view restored', expected: entry.previous, actual: { center: [c.lng, c.lat], zoom: after.map.zoom }, ok })
    }
    const ok = checks.every((c) => c.ok)
    return {
        ok,
        status: ok ? 'succeeded' : 'failed',
        error: ok ? null : { code: 'EXECUTION_FAILED', message: 'The restored state does not match the recorded previous state.' },
        output,
        returnValue: { undone: entry.method || entry.tool, target: entry.target || null, remaining: undoStack.length },
        verification: { verified: ok, checks, notes: [] },
        effects: diffSnapshots(before, after),
        state: summarizeSnapshot(after),
    }
}

async function runLocalCommand(message) {
    await waitForCopilotIdle()
    const before = takeSnapshot()
    const movement = trackMapMovement()
    const handled = await tryLocalCopilotCommand(String(message || ''))
    if (!handled) {
        movement.stop()
        return { ok: true, status: 'succeeded', handled: false }
    }
    await settle('local', movement)
    movement.stop()
    const after = takeSnapshot()
    return {
        ok: true,
        status: 'succeeded',
        handled: true,
        reply: handled.reply || '',
        effects: diffSnapshots(before, after),
        state: summarizeSnapshot(after),
    }
}

export async function executeCommand(command, options = {}) {
    const started = Date.now()
    let result
    try {
        switch (command && command.kind) {
            case 'copilot_action':
                result = await runCopilotAction(command, options)
                break
            case 'get_state': {
                const state = takeSnapshot()
                result = { ok: true, status: 'succeeded', returnValue: state, state: summarizeSnapshot(state), verification: { verified: null, checks: [], notes: [] } }
                break
            }
            case 'undo':
                result = await runUndo()
                break
            case 'local_command':
                result = await runLocalCommand(command.message)
                break
            case 'agent_context':
                result = { ok: true, status: 'succeeded', context: buildAgentContextFromLayers(collectAgentLayers(buildAgentLayerIndex())) }
                break
            default:
                result = { ok: false, status: 'failed', error: { code: 'CAPABILITY_UNAVAILABLE', message: `Unsupported bridge command '${command && command.kind}'.` } }
        }
    } catch (err) {
        result = { ok: false, status: 'failed', error: { code: err.code || 'EXECUTION_FAILED', message: err.message || String(err) } }
    }
    result.durationMs = Date.now() - started
    return result
}
