import { resolveLayerArguments } from './layerArgumentResolver'

function schemaProperties(schema) {
    const properties = { ...(schema?.properties || {}) }
    for (const branchName of ['oneOf', 'anyOf', 'allOf']) {
        for (const branch of schema?.[branchName] || []) {
            Object.assign(properties, branch?.properties || {})
        }
    }
    return properties
}

function normalizeDeclaredKeys(declaration) {
    if (Array.isArray(declaration)) {
        return { scalarKeys: declaration, arrayKeys: [] }
    }
    if (!declaration || typeof declaration !== 'object') return null
    return {
        scalarKeys: Array.isArray(declaration.scalar)
            ? declaration.scalar
            : Array.isArray(declaration.scalarKeys)
            ? declaration.scalarKeys
            : [],
        arrayKeys: Array.isArray(declaration.arrays)
            ? declaration.arrays
            : Array.isArray(declaration.arrayKeys)
            ? declaration.arrayKeys
            : [],
    }
}

export function layerArgumentKeysForTool(spec) {
    const declared = normalizeDeclaredKeys(
        spec?.layerArguments || spec?.execution?.layerArguments
    )
    if (declared) return declared

    // Runtime plug-in/core actions own their argument semantics. A generic
    // property named `name` may identify a tool, feature, preset, etc.; only
    // explicit metadata may opt a registered action into layer resolution.
    if (spec?.execution?.adapter === 'pluginAction') {
        return { scalarKeys: [], arrayKeys: [] }
    }

    const properties = schemaProperties(
        spec?.parameters || spec?.modelParameters || {}
    )
    const scalarKeys = ['layer', 'layer_name', 'layer_a', 'layer_b'].filter(
        (key) => properties[key]
    )
    const arrayKeys = ['layer_names', 'layers'].filter((key) => {
        const property = properties[key]
        return property?.type === 'array'
    })
    if (
        properties.name &&
        (spec?.execution?.nameResolution === 'displayNameToInternalId' ||
            /\blayer\b/i.test(String(properties.name.description || '')))
    ) {
        scalarKeys.push('name')
    }
    return { scalarKeys, arrayKeys }
}

export function prepareActionLayerArguments({
    action,
    spec,
    layers,
    userQuery = '',
} = {}) {
    const { scalarKeys, arrayKeys } = layerArgumentKeysForTool(spec)
    if (!scalarKeys.length && !arrayKeys.length) {
        return {
            prepared: { ...action, args: { ...(action?.args || {}) } },
            matches: [],
        }
    }
    const resolution = resolveLayerArguments({
        args: action?.args || {},
        layers,
        userQuery,
        scalarKeys,
        arrayKeys,
    })
    if (resolution.error) return resolution
    return {
        prepared: {
            ...action,
            args: resolution.args,
            __layerMatches: resolution.matches,
        },
        matches: resolution.matches,
    }
}

/**
 * Attach layer-resolution diagnostics without rebuilding the prepared action.
 *
 * `prepareActionLayerArguments` deliberately returns a `{ prepared, matches }`
 * envelope.  Keeping this finalization in a pure helper prevents callers from
 * accidentally reading `resolution.args` (which is not part of that envelope)
 * and dropping every non-layer argument such as `region`, `zoom`, or `time`.
 */
export function finalizePreparedAction(action, resolution = {}) {
    const matches = Array.isArray(resolution.matches)
        ? resolution.matches
        : []
    const prepared =
        resolution.prepared && typeof resolution.prepared === 'object'
            ? resolution.prepared
            : {
                  ...action,
                  args: { ...(action?.args || {}) },
              }
    return {
        prepared: {
            ...prepared,
            args: { ...(prepared.args || {}) },
            __layerMatches: matches,
        },
        matches,
    }
}
