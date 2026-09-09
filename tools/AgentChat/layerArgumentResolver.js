import { normalizeLayerText, resolveLayerSelection } from './layerResolver'

function resolveOne(value, userQuery, layers) {
    const resolution = resolveLayerSelection({
        requestedName: value,
        userQuery,
        layers,
    })
    if (!resolution?.ambiguous) return resolution?.match || null
    const candidates = resolution.candidates || []
    const names = candidates
        .map((candidate) => normalizeLayerText(candidate.displayName || ''))
        .filter(Boolean)
    const duplicates =
        names.length > 0 && names.every((name) => name === names[0])
    if (duplicates) {
        const retry = resolveLayerSelection({
            requestedName: candidates[0].displayName,
            userQuery,
            layers,
        })
        if (retry?.match && !retry.ambiguous) return retry.match
    }
    return { ambiguous: true, candidates }
}

function failureFor(value, key, match) {
    if (!match) {
        return {
            error: `Could not find a layer matching "${value}".`,
            key,
        }
    }
    const options = (match.candidates || [])
        .map((candidate) => {
            const name = candidate.displayName || '(unnamed layer)'
            return candidate.groupPath
                ? `${candidate.groupPath} > ${name}`
                : name
        })
        .filter(Boolean)
    return {
        error: `Layer "${value}" is ambiguous. Choose one: ${options.join(
            ' | '
        )}.`,
        key,
    }
}

export function resolveLayerArguments({
    args,
    layers,
    userQuery = '',
    scalarKeys = ['name', 'layer_name', 'layer_a', 'layer_b'],
    arrayKeys = ['layer_names', 'layers'],
} = {}) {
    const input = args && typeof args === 'object' ? args : {}
    const updatedArgs = { ...input }
    const matches = []

    for (const key of scalarKeys) {
        const value = updatedArgs[key]
        if (typeof value !== 'string' || !value.trim()) continue
        const match = resolveOne(value, userQuery, layers || [])
        if (!match || match.ambiguous) return failureFor(value, key, match)
        updatedArgs[key] = match.resolved
        matches.push({ key, requested: value, ...match })
    }

    for (const key of arrayKeys) {
        const values = updatedArgs[key]
        if (!Array.isArray(values)) continue
        const resolvedValues = []
        for (let index = 0; index < values.length; index += 1) {
            const value = values[index]
            if (typeof value !== 'string' || !value.trim()) {
                return {
                    error: `Layer argument "${key}[${index}]" must be a non-empty string.`,
                    key: `${key}[${index}]`,
                }
            }
            const itemKey = `${key}[${index}]`
            const match = resolveOne(value, userQuery, layers || [])
            if (!match || match.ambiguous)
                return failureFor(value, itemKey, match)
            resolvedValues.push(match.resolved)
            matches.push({ key: itemKey, requested: value, ...match })
        }
        updatedArgs[key] = resolvedValues
    }

    return { args: updatedArgs, matches }
}
