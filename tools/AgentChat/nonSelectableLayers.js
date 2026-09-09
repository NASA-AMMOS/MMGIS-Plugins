// Layers a user cannot meaningfully select/interact with (pure background
// context, e.g. a land/ocean mask) and so shouldn't appear when Copilot
// enumerates "the layers" for a person to pick from or analyze.
//
// TODO: no config field currently marks this (checked tool-registry.json,
// the mission config schema, and LayerTypeRegistry's "selectable" concept,
// which is about map feature-picking, not this). This is a stopgap
// name-based exclusion; move it to a real per-layer config flag (e.g.
// `selectable: false`, settable via Configure) as soon as one exists so
// this doesn't silently miss future non-selectable layers or mis-tag a
// same-named layer in another mission.

function normalizeName(value) {
    return (value || '')
        .toString()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

const NON_SELECTABLE_LAYER_NAMES = new Set(['land mask'])

export function isNonSelectableLayerName(name) {
    return NON_SELECTABLE_LAYER_NAMES.has(normalizeName(name))
}
