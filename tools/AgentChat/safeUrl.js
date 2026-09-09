export function safeCitationUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null
    const candidate = value.trim()
    if (/^(https?):\/\//i.test(candidate)) return candidate
    if (/^(\/|\.\/|\.\.\/)/.test(candidate)) return candidate
    return null
}
