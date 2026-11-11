// Pure helpers over state snapshots (see stateSnapshot.js): a compact summary
// and the difference between two snapshots.

// Compact view returned with every result: visible layers only.
export function summarizeSnapshot(snapshot) {
    if (!snapshot) return null
    const visible = {}
    Object.keys(snapshot.layers || {}).forEach((uuid) => {
        const l = snapshot.layers[uuid]
        if (l.visible) visible[uuid] = l
    })
    return { ...snapshot, layers: undefined, visible_layers: visible, layer_count: Object.keys(snapshot.layers || {}).length }
}

function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b)
}

export function diffSnapshots(before, after) {
    if (!before || !after) return null
    const layers = []
    const ids = new Set([...Object.keys(before.layers || {}), ...Object.keys(after.layers || {})])
    ids.forEach((uuid) => {
        const b = (before.layers || {})[uuid] || {}
        const a = (after.layers || {})[uuid] || {}
        const changes = {}
        ;['visible', 'opacity', 'on_map'].forEach((k) => {
            if (b[k] !== a[k]) changes[k] = { from: b[k] ?? null, to: a[k] ?? null }
        })
        if (!same(b.time, a.time)) changes.time = { from: b.time || null, to: a.time || null }
        if (Object.keys(changes).length) layers.push({ uuid, name: a.name || b.name, ...changes })
    })
    const out = {}
    if (layers.length) out.layers = layers
    if (!same(before.map, after.map)) out.map = { from: before.map, to: after.map }
    if (!same(before.time, after.time)) out.time = { from: before.time, to: after.time }
    if (!same(before.highlight, after.highlight)) out.highlight = { from: before.highlight, to: after.highlight }
    if (!same(before.overlays, after.overlays)) out.overlays = { from: before.overlays, to: after.overlays }
    if (before.animation_ui !== after.animation_ui) out.animation_ui = { from: before.animation_ui, to: after.animation_ui }
    if (!same(before.tools, after.tools)) out.tools = { from: before.tools, to: after.tools }
    return out
}
