export function scopedAgentStorageKey(baseKey, mission) {
    const scope = String(mission || '').trim()
    return scope ? `${baseKey}.${encodeURIComponent(scope)}` : `${baseKey}.no-mission`
}

export function discardUnscopedAgentState(storage, baseKeys) {
    if (!storage || !Array.isArray(baseKeys)) return
    baseKeys.forEach((key) => {
        try {
            storage.removeItem(key)
        } catch (_) {}
    })
}
