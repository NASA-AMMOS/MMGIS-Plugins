import { buildAgentApiUrl } from './agentProtocol'

export function appendQueryParameters(target, params = {}, origin = '') {
    const raw = String(target || '').trim()
    if (!raw) return ''
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    const baseOrigin =
        origin ||
        (typeof window !== 'undefined' && window.location?.origin) ||
        'http://mmgis.invalid'
    const url = new URL(raw, baseOrigin)
    const entries =
        params instanceof URLSearchParams
            ? Array.from(params.entries())
            : Object.entries(params || {})
    entries.forEach(([key, value]) => {
        if (value == null || value === '') return
        url.searchParams.set(key, String(value))
    })
    return absolute
        ? url.toString()
        : `${url.pathname}${url.search}${url.hash}`
}

export function buildConfiguredAgentEndpoint({
    path = '',
    mission = '',
    rootPath = '',
    configuredUrl = null,
    params = {},
    origin = '',
} = {}) {
    const target =
        typeof configuredUrl === 'function'
            ? configuredUrl(path)
            : buildAgentApiUrl({ rootPath, path, mission })
    return appendQueryParameters(target, { mission, ...params }, origin)
}

export function buildConfiguredAnalyticsEndpoint({
    path = '',
    analyticsBaseUrl = '',
    mission = '',
    rootPath = '',
    configuredUrl = null,
    params = {},
    origin = '',
} = {}) {
    const safePath = String(path || '').replace(/^\/+/, '')
    const override = String(analyticsBaseUrl || '').trim().replace(/\/+$/, '')
    if (override) {
        return appendQueryParameters(
            `${override}/${safePath}`,
            { mission, ...params },
            origin
        )
    }
    return buildConfiguredAgentEndpoint({
        path: `/analytics/${safePath}`,
        mission,
        rootPath,
        configuredUrl,
        params,
        origin,
    })
}
