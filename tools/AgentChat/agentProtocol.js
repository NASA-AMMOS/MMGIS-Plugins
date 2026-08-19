// Keep the transport fallback self-contained so protocol normalization does
// not depend on optional UI response helpers and always produces readable text.
export const EMPTY_ASSISTANT_REPLY_MESSAGE =
    "Copilot didn't return a response for that. Please try rephrasing or try again."

export class AgentResponseError extends Error {
    constructor(message, { code = 'AGENT_RESPONSE_ERROR', details = null } = {}) {
        super(message)
        this.name = 'AgentResponseError'
        this.code = code
        this.details = details
    }
}

const SENSITIVE_FIELD_NAMES = new Set([
    'apikey',
    'xapikey',
    'token',
    'authtoken',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'secret',
    'clientsecret',
    'password',
    'passwd',
    'privatekey',
    'signature',
    'sig',
    'credential',
    'credentials',
    'authorization',
    'proxyauthorization',
    'cookie',
    'setcookie',
])

function cleanText(value) {
    return typeof value === 'string' ? value.trim() : ''
}

function sanitizeSensitiveText(value) {
    return String(value || '')
        .replace(/[A-Za-z]:\\[^\s"']+/g, '[local path]')
        .replace(
            /\/(?:Users|home|var|tmp|etc|opt|srv|mnt)\/[^\s"']+/g,
            '[local path]'
        )
        .replace(
            /(https?:\/\/[^\s?#]+)\?[^\s#]*/gi,
            '$1?[query redacted]'
        )
        .replace(
            /\b(api[_-]?key|token|secret|password|signature|sig|credential)\s*[:=]\s*[^\s,;]+/gi,
            '$1=[redacted]'
        )
}

function isSensitiveFieldName(value) {
    const normalized = String(value || '')
        .replace(/[^A-Za-z0-9]/g, '')
        .toLowerCase()
    return SENSITIVE_FIELD_NAMES.has(normalized)
}

export function sanitizeErrorMessage(
    value,
    fallback = 'The requested action could not be completed.'
) {
    let message = cleanText(value?.publicMessage || value?.message || value)
    if (!message) return fallback
    message = message.split(/\r?\n/)[0]
    message = sanitizeSensitiveText(message)
    return message.slice(0, 500) || fallback
}

function payloadErrorMessage(payload) {
    const raw =
        payload?.error?.message ||
        payload?.error ||
        payload?.message ||
        payload?.reason ||
        payload?.detail
    return cleanText(raw)
}

function looksLikeHtml(value) {
    return /<(?:!doctype\s+html|html|head|body|form|script|title)\b/i.test(
        String(value || '')
    )
}

function looksLikeLoginHtml(value) {
    const text = String(value || '')
    return (
        looksLikeHtml(text) &&
        /(?:type\s*=\s*["']?password|\blog[ -]?in\b|\bsign[ -]?in\b|authenticate)/i.test(
            text
        )
    )
}

export function sanitizeToolData(value, depth = 0, seen = new WeakSet()) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number')
        return value
    if (typeof value === 'string')
        return sanitizeSensitiveText(value).slice(0, 2000)
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'function' || typeof value === 'symbol') return undefined
    if (depth >= 5) return '[truncated]'
    if (ArrayBuffer.isView(value)) {
        return {
            type: value.constructor?.name || 'TypedArray',
            length: value.length,
        }
    }
    if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', bytes: value.byteLength }
    if (typeof value !== 'object') return String(value)
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) {
        return value
            .slice(0, 50)
            .map((item) => sanitizeToolData(item, depth + 1, seen))
    }
    const result = {}
    Object.keys(value)
        .slice(0, 50)
        .forEach((key) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) return
            if (isSensitiveFieldName(key)) {
                result[key] = '[redacted]'
                return
            }
            const next = sanitizeToolData(value[key], depth + 1, seen)
            if (next !== undefined) result[key] = next
        })
    return result
}

export function buildAgentApiUrl({
    configuredBase = '',
    rootPath = '',
    path = '',
    mission = '',
} = {}) {
    const configured = cleanText(configuredBase).replace(/\/+$/, '')
    const root = String(rootPath || '').replace(/\/+$/, '')
    const base = configured || `${root}/api/agent`
    const suffix = path ? `/${String(path).replace(/^\/+/, '')}` : ''
    const target = `${base}${suffix}`
    if (!mission) return target
    const separator = target.includes('?') ? '&' : '?'
    return `${target}${separator}mission=${encodeURIComponent(mission)}`
}

export function normalizeAgentResponse(payload, response = {}) {
    if (typeof payload === 'string' && payload.trim()) {
        const contentType = cleanText(response.contentType).toLowerCase()
        if (
            contentType.includes('text/html') ||
            looksLikeHtml(payload)
        ) {
            const authentication = looksLikeLoginHtml(payload)
            throw new AgentResponseError(
                authentication
                    ? 'Copilot requires an authenticated MMGIS session. Sign in and try again.'
                    : 'The Copilot service returned an HTML page instead of an agent response.',
                {
                    code: authentication
                        ? 'AUTH_REQUIRED'
                        : 'MALFORMED_RESPONSE',
                    details: null,
                }
            )
        }
        if (contentType && !contentType.includes('text/plain')) {
            throw new AgentResponseError(
                'The Copilot service returned malformed non-text data.',
                { code: 'MALFORMED_RESPONSE', details: null }
            )
        }
        if (response.ok === false) {
            throw new AgentResponseError(payload.trim(), {
                code: 'AGENT_FAILURE',
                details: payload,
            })
        }
        return { reply: payload.trim(), text: payload.trim(), actions: [] }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new AgentResponseError(
            'The Copilot service returned an empty or non-JSON response.',
            { code: 'MALFORMED_RESPONSE', details: payload }
        )
    }
    const status = cleanText(payload.status).toLowerCase()
    const failed =
        response.ok === false ||
        payload.ok === false ||
        status === 'failure' ||
        status === 'failed' ||
        status === 'error'
    if (failed) {
        const serverMessage = payloadErrorMessage(payload)
        const fallback = response.status
            ? `Copilot request failed with status ${response.status}.`
            : 'The Copilot service could not complete this request.'
        throw new AgentResponseError(serverMessage || fallback, {
            code: cleanText(payload.code) || 'AGENT_FAILURE',
            details: payload,
        })
    }
    const actions = Array.isArray(payload.actions)
        ? payload.actions
        : Array.isArray(payload.toolCalls)
          ? payload.toolCalls
          : []
    const hasText = [payload.reply, payload.text, payload.message, payload.output_text]
        .some((value) => cleanText(value))
    if (!actions.length && !hasText) {
        throw new AgentResponseError(
            'The Copilot service returned an empty response.',
            { code: 'MALFORMED_RESPONSE', details: payload }
        )
    }
    return { ...payload, actions }
}

export function buildAgentHistory(history, currentMessage = '', limit = 12) {
    const entries = Array.isArray(history) ? history.slice() : []
    const submitted = cleanText(currentMessage)
    const last = entries[entries.length - 1]
    const lastText = cleanText(last?.reply || last?.text || last?.content)
    if (last?.role === 'user' && submitted && lastText === submitted) {
        entries.pop()
    }
    return entries
        .slice(-Math.max(0, Number.isFinite(Number(limit)) ? Number(limit) : 12))
        .filter(
            (entry) =>
                entry &&
                (entry.role === 'user' || entry.role === 'assistant')
        )
        .map((entry) => ({
            role: entry.role,
            content: String(
                entry.reply || entry.text || entry.content || ''
            ).slice(0, 1500),
        }))
        .filter((entry) => entry.content.trim())
}

export function createToolResult({
    tool,
    callId = null,
    ok,
    message = '',
    data = null,
    errorCode = null,
    errorMessage = '',
} = {}) {
    const success = ok === true
    const publicMessage = success
        ? cleanText(message)
        : sanitizeErrorMessage(message || errorMessage)
    return {
        tool: cleanText(tool) || 'unknown_tool',
        callId: callId == null ? null : String(callId),
        ok: success,
        message: publicMessage,
        data: data == null ? null : sanitizeToolData(data),
        error: success
            ? null
            : {
                  code:
                      cleanText(errorCode)
                          .replace(/[^A-Za-z0-9_.-]/g, '_')
                          .slice(0, 80) || 'TOOL_EXECUTION_FAILED',
                  message:
                      sanitizeErrorMessage(errorMessage || message) ||
                      'The tool could not complete the requested action.',
              },
    }
}

export function normalizeRendererResult(
    tool,
    callId,
    rawResult,
    appendedLines = []
) {
    const captured = (Array.isArray(appendedLines) ? appendedLines : [])
        .map((line) => cleanText(String(line)))
        .filter(Boolean)
        .join('\n')
    if (rawResult && typeof rawResult === 'object' && !Array.isArray(rawResult)) {
        if (!Object.keys(rawResult).length && !captured) {
            return createToolResult({
                tool,
                callId,
                ok: false,
                message:
                    'The requested action returned an empty result. No change was confirmed.',
                data: null,
                errorCode: 'EMPTY_RENDERER_RESULT',
                errorMessage:
                    'The requested action returned an empty result. No change was confirmed.',
            })
        }
        const ok = rawResult.ok !== false
        return createToolResult({
            tool,
            callId,
            ok,
            message:
                cleanText(rawResult.message) ||
                captured ||
                (ok ? `${tool} completed successfully.` : ''),
            data:
                rawResult.data !== undefined
                    ? rawResult.data
                    : rawResult.result !== undefined
                      ? rawResult.result
                      : rawResult,
            errorCode: rawResult.errorCode || rawResult.error?.code,
            errorMessage: ok
                ? ''
                : sanitizeErrorMessage(
                      rawResult.error?.message || rawResult.message || captured
                  ),
        })
    }
    const text = cleanText(rawResult) || captured
    if (!text && rawResult == null) {
        return createToolResult({
            tool,
            callId,
            ok: false,
            message:
                'The requested action did not return a result. No change was confirmed.',
            data: null,
            errorCode: 'EMPTY_RENDERER_RESULT',
            errorMessage:
                'The requested action did not return a result. No change was confirmed.',
        })
    }
    return createToolResult({
        tool,
        callId,
        ok: true,
        message: text,
        data: rawResult == null ? null : rawResult,
    })
}

export function resolveFinalAssistantText(response, toolResults = []) {
    const responseText =
        cleanText(response?.reply) ||
        cleanText(response?.text) ||
        cleanText(response?.message) ||
        cleanText(response?.output_text)
    if (responseText && responseText !== EMPTY_ASSISTANT_REPLY_MESSAGE)
        return responseText
    const results = Array.isArray(toolResults) ? toolResults : []
    const messages = results
        .map((result) => cleanText(result?.message))
        .filter(Boolean)
    if (messages.length) return messages.join('\n')
    const errors = results
        .map((result) => cleanText(result?.error?.message))
        .filter(Boolean)
    if (errors.length) return errors.join('\n')
    return EMPTY_ASSISTANT_REPLY_MESSAGE
}

export function userFacingAgentError(error) {
    const message = sanitizeErrorMessage(error)
    if (
        error?.code === 'AUTH_REQUIRED' ||
        error?.code === 'AgentAuthenticationRequired'
    )
        return 'Copilot requires an authenticated MMGIS session. Sign in and try again.'
    if (error?.code === 'AgentAuthenticationUnavailable')
        return 'MMGIS authentication is temporarily unavailable. Please try again.'
    if (error?.code === 'MALFORMED_RESPONSE')
        return 'The Copilot service returned an invalid response. Please try again; the server log contains the response details.'
    if (/network|fetch|connect|offline/i.test(message))
        return 'Copilot could not reach the agent service. Check the service connection and try again.'
    return message || 'Copilot could not complete that request.'
}
