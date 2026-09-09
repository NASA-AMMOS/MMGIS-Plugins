import { test, expect } from '@playwright/test'
import {
    AgentResponseError,
    buildAgentApiUrl,
    buildAgentHistory,
    createToolResult,
    normalizeAgentResponse,
    normalizeRendererResult,
    resolveFinalAssistantText,
    sanitizeErrorMessage,
    sanitizeToolData,
    userFacingAgentError,
} from '../agentProtocol'

test.describe('@unit AgentChat response protocol', () => {
    test('accepts a plain final text response', () => {
        expect(
            normalizeAgentResponse('Zoomed to the Beaufort Sea.', {
                ok: true,
                contentType: 'text/plain; charset=utf-8',
            })
        ).toEqual({
            reply: 'Zoomed to the Beaufort Sea.',
            text: 'Zoomed to the Beaufort Sea.',
            actions: [],
        })
    })

    test('rejects an HTTP-200 login page instead of rendering HTML', () => {
        let caught = null
        try {
            normalizeAgentResponse(
                '<!doctype html><html><form><input type="password"></form>Log in</html>',
                { ok: true, status: 200, contentType: 'text/html' }
            )
        } catch (error) {
            caught = error
        }
        expect(caught).toBeInstanceOf(AgentResponseError)
        expect(caught.code).toBe('AUTH_REQUIRED')
        expect(userFacingAgentError(caught)).toContain('Sign in')
    })

    test('rejects malformed JSON content while preserving text/plain replies', () => {
        expect(() =>
            normalizeAgentResponse('not valid JSON', {
                ok: true,
                status: 200,
                contentType: 'application/json',
            })
        ).toThrow(AgentResponseError)
    })

    test('rejects HTTP-200 structured failures with their safe reason', () => {
        expect(() =>
            normalizeAgentResponse(
                { status: 'failure', message: 'No analyzable layer is visible.' },
                { ok: true, status: 200 }
            )
        ).toThrow('No analyzable layer is visible.')
    })

    test('maps typed host authentication failures to sign-in and outage messages', () => {
        const capture = (payload, status) => {
            try {
                normalizeAgentResponse(payload, {
                    ok: false,
                    status,
                    contentType: 'application/json',
                })
            } catch (error) {
                return error
            }
            throw new Error('Expected authentication response to fail.')
        }

        const required = capture(
            {
                error: 'Sign in to use MMGIS Copilot.',
                code: 'AgentAuthenticationRequired',
            },
            401
        )
        expect(required.code).toBe('AgentAuthenticationRequired')
        expect(userFacingAgentError(required)).toContain('Sign in')

        const unavailable = capture(
            {
                error: 'MMGIS authentication is temporarily unavailable.',
                code: 'AgentAuthenticationUnavailable',
            },
            503
        )
        expect(unavailable.code).toBe('AgentAuthenticationUnavailable')
        expect(userFacingAgentError(unavailable)).toContain(
            'temporarily unavailable'
        )
    })

    test('rejects null and structurally empty payloads', () => {
        for (const payload of [null, undefined, {}, []]) {
            expect(() => normalizeAgentResponse(payload)).toThrow(
                AgentResponseError
            )
        }
    })

    test('rejects a plain-text HTTP failure', () => {
        expect(() =>
            normalizeAgentResponse('upstream unavailable', {
                ok: false,
                status: 503,
            })
        ).toThrow('upstream unavailable')
    })

    test('captures appendLine output as a structured tool result', () => {
        const result = normalizeRendererResult(
            'toggle_layer',
            'call-1',
            undefined,
            ['SWOT binned freeboard is now visible.']
        )
        expect(result).toEqual({
            tool: 'toggle_layer',
            callId: 'call-1',
            ok: true,
            message: 'SWOT binned freeboard is now visible.',
            data: null,
            error: null,
        })
    })

    test('rejects an empty renderer return instead of fabricating success', () => {
        const result = normalizeRendererResult(
            'forgotten_renderer',
            'call-empty',
            undefined,
            []
        )
        expect(result).toMatchObject({
            tool: 'forgotten_renderer',
            callId: 'call-empty',
            ok: false,
            error: { code: 'EMPTY_RENDERER_RESULT' },
        })
        expect(result.message).toContain('did not return a result')
        expect(
            normalizeRendererResult('empty_object', 'call-object', {}, [])
        ).toMatchObject({
            ok: false,
            error: { code: 'EMPTY_RENDERER_RESULT' },
        })
    })

    test('always derives visible final assistant text after tool execution', () => {
        const results = [
            createToolResult({
                tool: 'zoom_to',
                callId: 'call-2',
                ok: true,
                message: 'Zoomed to the Beaufort Sea at zoom level 3.',
            }),
        ]
        expect(
            resolveFinalAssistantText(
                { reply: 'Done — the Beaufort Sea is in view.' },
                results
            )
        ).toBe('Done — the Beaufort Sea is in view.')
        expect(resolveFinalAssistantText({}, results)).toBe(
            'Zoomed to the Beaufort Sea at zoom level 3.'
        )
        expect(resolveFinalAssistantText({}, [])).toContain(
            "Copilot didn't return a response"
        )
    })

    test('uses configured API base or the portable same-instance default', () => {
        expect(
            buildAgentApiUrl({
                configuredBase: 'https://agent.example/api/agent/',
                path: '/continue',
                mission: 'Arctic Demo',
            })
        ).toBe(
            'https://agent.example/api/agent/continue?mission=Arctic%20Demo'
        )
        expect(
            buildAgentApiUrl({
                rootPath: '/mmgis',
                path: '/tools',
                mission: 'demo',
            })
        ).toBe('/mmgis/api/agent/tools?mission=demo')
    })

    test('does not duplicate the just-submitted user message in history', () => {
        const history = [
            { role: 'user', text: 'List layers' },
            { role: 'assistant', reply: 'Layer A and Layer B are available.' },
            { role: 'user', text: 'Hide Layer B' },
        ]
        expect(buildAgentHistory(history, 'Hide Layer B')).toEqual([
            { role: 'user', content: 'List layers' },
            {
                role: 'assistant',
                content: 'Layer A and Layer B are available.',
            },
        ])
    })

    test('scrubs tool exception paths, credentials, queries, and stack text', () => {
        const unsafe = new Error(
            'failed at C:\\Users\\dev\\secret.js token=abc123 https://x.test/a?sig=secret\n    at privateFn (C:\\Users\\dev\\secret.js:1:2)'
        )
        const safe = sanitizeErrorMessage(unsafe)
        expect(safe).not.toContain('C:\\Users')
        expect(safe).not.toContain('abc123')
        expect(safe).not.toContain('sig=secret')
        expect(safe).not.toContain('privateFn')

        const result = createToolResult({
            tool: 'plugin__action',
            ok: false,
            message: unsafe.message,
            errorCode: 'PLUGIN ACTION FAILED',
            data: {
                diagnostic:
                    '/home/operator/private.txt password=hunter2 https://x.test/a?token=secret',
            },
        })
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain('/home/operator')
        expect(serialized).not.toContain('hunter2')
        expect(serialized).not.toContain('token=secret')
        expect(result.error.code).toBe('PLUGIN_ACTION_FAILED')
    })

    test('recursively redacts values stored under sensitive field names', () => {
        const safe = sanitizeToolData({
            apiKey: 'top-level-api-key',
            nested: {
                Authorization: 'Bearer nested-token',
                safe: 'visible',
                items: [
                    { refresh_token: 'refresh-secret', count: 2 },
                    {
                        metadata: {
                            clientSecret: 'client-secret',
                            tokenCount: 4,
                        },
                    },
                ],
            },
        })

        expect(safe).toEqual({
            apiKey: '[redacted]',
            nested: {
                Authorization: '[redacted]',
                safe: 'visible',
                items: [
                    { refresh_token: '[redacted]', count: 2 },
                    {
                        metadata: {
                            clientSecret: '[redacted]',
                            tokenCount: 4,
                        },
                    },
                ],
            },
        })
        const serialized = JSON.stringify(safe)
        expect(serialized).not.toContain('top-level-api-key')
        expect(serialized).not.toContain('nested-token')
        expect(serialized).not.toContain('refresh-secret')
        expect(serialized).not.toContain('client-secret')
    })

    test('maps malformed responses to a useful user-facing message', () => {
        const error = new AgentResponseError('bad payload', {
            code: 'MALFORMED_RESPONSE',
        })
        expect(userFacingAgentError(error)).toContain('invalid response')
    })
})
