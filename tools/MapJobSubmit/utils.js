// Utility functions - constants, validation, formatting, detection

// ============================================================================
// Constants
// ============================================================================

// Input name variations for map-based parameters
export const LAT_VARIATIONS = ['lat', 'latitude']
export const LON_VARIATIONS = ['lon', 'lng', 'longitude']
export const BBOX_VARIATIONS = ['bbox', 'boundingbox', 'bounding_box']

// Terminal/completed job statuses - jobs with these statuses won't be refreshed
export const TERMINAL_STATUSES = ['failed', 'successful', 'dismissed', 'job-failed', 'completed', 'cancelled']

// ============================================================================
// Input Parameter Detection
// ============================================================================

// Normalize input key by removing spaces, hyphens, underscores and converting to lowercase
export function normalizeInputKey(key) {
    return String(key).toLowerCase().replace(/[-_\s]/g, '')
}

// Check if a parameter name contains bbox variations
export function containsBboxVariation(key) {
    const normalized = normalizeInputKey(key)
    return BBOX_VARIATIONS.some(variation => normalized.includes(variation))
}

// Check if a parameter name contains both lat and lon variations (for single lat/lon combo fields)
export function containsLatLonCombo(key) {
    const normalized = normalizeInputKey(key)
    const hasLat = LAT_VARIATIONS.some(variation => normalized.includes(variation))
    const hasLon = LON_VARIATIONS.some(variation => normalized.includes(variation))
    return hasLat && hasLon
}

// Check if an input should be treated as numeric based on its key or type
export function shouldBeNumeric(key, type) {
    if (!type) type = ''
    const typeLower = type.toLowerCase()

    // Explicit numeric types
    if (typeLower === 'number' || typeLower === 'integer' ||
        typeLower === 'float' || typeLower === 'double') {
        return true
    }

    // Lat/lon are always numeric
    const normalized = normalizeInputKey(key)
    if (LAT_VARIATIONS.includes(normalized) || LON_VARIATIONS.includes(normalized)) {
        return true
    }

    return false
}

// ============================================================================
// Security & Validation
// ============================================================================

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * Standard pattern used across MMGIS (WorkflowsTool, Config routes, etc.)
 */
export function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

/**
 * Sanitizes user input by removing dangerous characters.
 * Based on F_.sanitize() and backend sanitizeInput() patterns.
 */
export function sanitizeInput(str) {
    if (str == null) return ''
    // Remove potentially dangerous characters: < > ; { }
    // These could be used for XSS/injection attacks
    return String(str).replace(/[<>;{}]/g, '')
}

/**
 * Validates and sanitizes a personal access token.
 * Ensures tokens don't contain XSS/injection characters.
 */
export function sanitizeToken(token) {
    if (!token || typeof token !== 'string') return null

    const trimmed = token.trim()
    if (trimmed.length === 0) return null

    // Check for dangerous characters that could indicate XSS attempt
    const dangerousChars = /[<>'"`;(){}[\]\\]/
    if (dangerousChars.test(trimmed)) {
        console.warn('[MapJobSubmitTool] Token contains potentially dangerous characters')
        return null
    }

    // Reasonable length limit (most tokens are 20-200 chars, allow up to 500)
    if (trimmed.length > 500) {
        console.warn('[MapJobSubmitTool] Token exceeds maximum length')
        return null
    }

    return trimmed
}

// ============================================================================
// Status Helpers
// ============================================================================

export function normalizeStatus(s) {
    if (!s || typeof s !== 'string') return ''
    return s.toLowerCase()
}

export function isTerminal(status) {
    const s = normalizeStatus(status)
    return TERMINAL_STATUSES.includes(s)
}

// ============================================================================
// URL & Data Detection
// ============================================================================

// TEMPORARY: see comment on the ENDPOINTS const.
export function isFilePathValue(v) {
    return typeof v === 'string' && v.startsWith('file://')
}

// Detect a STAC item URL — anything with /stac/... and /items/<id> in the path.
export function isStacItemUrl(u) {
    return (
        typeof u === 'string' &&
        /^https?:\/\//i.test(u) &&
        /\/stac\//i.test(u) &&
        /\/items\//i.test(u)
    )
}

// Extract URLs (http/https) from a free-form description field.
export function urlsFromString(s) {
    if (typeof s !== 'string' || !s) return []
    const out = []
    const re = /https?:\/\/[^\s,]+/gi
    let m
    while ((m = re.exec(s))) out.push(m[0])
    return out
}

// Pull {collection, item} out of a STAC item URL.
export function parseStacItemUrl(u) {
    const m = /\/stac\/collections\/([^/?#]+)\/items\/([^/?#]+)/i.exec(u)
    if (!m) return null
    return { collection: m[1], item: m[2] }
}

// ============================================================================
// Formatting
// ============================================================================

// Parse an ISO-ish timestamp and render in the user's locale.
export function formatLocale(iso) {
    if (!iso) return ''
    // The server's naive timestamps don't include a 'Z' suffix; FastAPI emits
    // UTC-but-unmarked. Append Z so Date doesn't interpret as local time.
    const s =
        typeof iso === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
            ? iso + 'Z'
            : iso
    const d = new Date(s)
    if (isNaN(d.getTime())) return String(iso)
    return d.toLocaleString()
}