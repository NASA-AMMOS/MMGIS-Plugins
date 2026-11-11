// @unit tests for the Copilot MCP browser-session registry (lib/sessions.js).
import { test, expect } from '@playwright/test'

const { BrowserSessionRegistry } = require('../lib/sessions')
const { ERROR_CODES } = require('../lib/results')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fakeClock(start = 1_000_000) {
    let t = start
    return { now: () => t, advance: (ms) => (t += ms) }
}

function registerOne(registry, owner = 'alice', mission = 'frozon', httpSessionId = 'http-1') {
    return registry.register({ owner, mission, httpSessionId, page: { title: 'MMGIS' } })
}

test.describe('BrowserSessionRegistry @unit', () => {
    test('register + authenticate require the secret, the same user and the same HTTP session', () => {
        const registry = new BrowserSessionRegistry()
        const { session, secret } = registerOne(registry)
        expect(registry.authenticate(session.id, secret, { owner: 'alice', httpSessionId: 'http-1' })).toBe(session)
        expect(() => registry.authenticate(session.id, 'wrong', { owner: 'alice' })).toThrow(/Unknown or expired/)
        expect(() => registry.authenticate(session.id, secret, { owner: 'bob' })).toThrow(/different login/)
        expect(() => registry.authenticate(session.id, secret, { owner: 'alice', httpSessionId: 'http-2' })).toThrow(/different login/)
        expect(() => registry.authenticate('nope', secret, { owner: 'alice' })).toThrow(/Unknown or expired/)
    })

    test('a command resolves only after the page acknowledged it and reported a result', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const polled = registry.poll(session, 5000)
        const call = registry.dispatch(session, { kind: 'copilot_action', tool: 'toggle_layer' })
        const commands = await polled
        expect(commands.map((c) => c.tool)).toEqual(['toggle_layer'])
        // Result before the acknowledgement is ignored: the page may only run acknowledged commands.
        expect(registry.complete(session, commands[0].id, { ok: true })).toEqual({ accepted: false, reason: 'unknown_command' })
        expect(registry.acknowledge(session, [commands[0].id, 'unknown'])).toEqual([commands[0].id])
        expect(registry.isBusy(session)).toBe(true)
        expect(registry.complete(session, commands[0].id, { ok: true, status: 'succeeded' })).toEqual({ accepted: true })
        const result = await call
        expect(result).toMatchObject({ ok: true, status: 'succeeded', commandId: commands[0].id })
        expect(typeof result.deliveredAt).toBe('number')
        expect(registry.isBusy(session)).toBe(false)
        expect(registry.describe(session).executed_commands).toBe(1)
    })

    test('an unacknowledged command is withdrawn with NOT_DELIVERED and can no longer be acknowledged', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const call = registry.dispatch(session, { kind: 'copilot_action', tool: 'zoom_to' }, { deliveryTimeoutMs: 80 })
        const commands = await registry.poll(session, 1000) // handed out, never acknowledged
        await expect(call).rejects.toMatchObject({ code: ERROR_CODES.NOT_DELIVERED, details: { delivered: false } })
        expect(registry.acknowledge(session, [commands[0].id])).toEqual([])
    })

    test('commands handed to a poll that never acknowledged them are handed out again on the next poll', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const call = registry.dispatch(session, { kind: 'get_state' })
        const first = await registry.poll(session, 1000) // response lost (e.g. behind a proxy)
        const second = await registry.poll(session, 1000)
        expect(second.map((c) => c.id)).toEqual(first.map((c) => c.id))
        registry.acknowledge(session, [second[0].id])
        registry.complete(session, second[0].id, { ok: true, status: 'succeeded' })
        await expect(call).resolves.toMatchObject({ status: 'succeeded' })
    })

    test('requeue() after a dropped poll connection keeps the original order', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const a = registry.dispatch(session, { kind: 'copilot_action', tool: 'a' })
        const b = registry.dispatch(session, { kind: 'copilot_action', tool: 'b' })
        const handed = await registry.poll(session, 1000)
        registry.requeue(session, handed)
        const again = await registry.poll(session, 1000)
        expect(again.map((c) => c.tool)).toEqual(['a', 'b'])
        for (const c of again) {
            registry.acknowledge(session, [c.id])
            registry.complete(session, c.id, { ok: true })
        }
        await Promise.all([a, b])
    })

    test('an acknowledged command without a result times out as RESULT_TIMEOUT (outcome unknown); late results are ignored', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const call = registry.dispatch(session, { kind: 'copilot_action', tool: 'temporal_trends' }, { resultTimeoutMs: 60 })
        const [command] = await registry.poll(session, 1000)
        registry.acknowledge(session, [command.id])
        await expect(call).rejects.toMatchObject({ code: ERROR_CODES.RESULT_TIMEOUT, details: { delivered: true } })
        expect(registry.complete(session, command.id, { ok: true })).toEqual({ accepted: false, reason: 'late' })
    })

    test('a command queued behind a long-running one is not withdrawn while the page is busy', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const first = registry.dispatch(session, { kind: 'copilot_action', tool: 'long' }, { deliveryTimeoutMs: 50, resultTimeoutMs: 5000 })
        const [long] = await registry.poll(session, 1000)
        registry.acknowledge(session, [long.id])
        const second = registry.dispatch(session, { kind: 'copilot_action', tool: 'next' }, { deliveryTimeoutMs: 50, resultTimeoutMs: 5000 })
        await sleep(150) // three delivery timeouts pass while the page is busy
        registry.complete(session, long.id, { ok: true })
        await first
        const [next] = await registry.poll(session, 1000)
        expect(next.tool).toBe('next')
        registry.acknowledge(session, [next.id])
        registry.complete(session, next.id, { ok: true })
        await expect(second).resolves.toMatchObject({ ok: true })
    })

    test('unregister rejects pending commands with SESSION_CLOSED and states whether they ran', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        const running = registry.dispatch(session, { kind: 'copilot_action', tool: 'running' })
        const [cmd] = await registry.poll(session, 1000)
        registry.acknowledge(session, [cmd.id])
        const queued = registry.dispatch(session, { kind: 'copilot_action', tool: 'queued' })
        registry.unregister(session, 'browser_closed')
        await expect(running).rejects.toMatchObject({ code: ERROR_CODES.SESSION_CLOSED, details: { delivered: true } })
        await expect(queued).rejects.toMatchObject({ code: ERROR_CODES.SESSION_CLOSED, details: { delivered: false } })
        await expect(registry.dispatch(session, { kind: 'get_state' })).rejects.toMatchObject({ code: ERROR_CODES.SESSION_CLOSED })
    })

    test('poll resolves with [] on timeout and when its connection aborts', async () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry)
        await expect(registry.poll(session, 20)).resolves.toEqual([])
        const aborter = new AbortController()
        const pending = registry.poll(session, 5000, aborter.signal)
        aborter.abort()
        await expect(pending).resolves.toEqual([])
        expect(session.waiter).toBe(null)
    })

    test('liveness: open poll or running command keeps a session; silence beyond the grace closes it', async () => {
        const clock = fakeClock()
        const registry = new BrowserSessionRegistry({ livenessGraceMs: 20000, now: clock.now })
        const { session } = registerOne(registry)
        clock.advance(19000)
        expect(registry.isConnected(session)).toBe(true)
        clock.advance(2000)
        expect(registry.isConnected(session)).toBe(false) // e.g. a proxy hid the closed connection
        registry.poll(session, 60000) // a poll is open again
        clock.advance(100000)
        expect(registry.isConnected(session)).toBe(true)
        registry.releaseWaiter(session, []) // poll answered at "now"
        clock.advance(25000)
        registry.sweep()
        expect(registry.sessions.has(session.id)).toBe(false)
    })

    test('select(): routing by session_id and mission, ambiguity, and other users\' sessions', () => {
        const registry = new BrowserSessionRegistry()
        expect(() => registry.select({ owner: 'alice' })).toThrow(expect.objectContaining({ code: ERROR_CODES.NO_BROWSER_SESSION }))
        const a = registerOne(registry, 'alice', 'frozon').session
        expect(registry.select({ owner: 'alice' })).toBe(a)
        const b = registerOne(registry, 'alice', 'Reference-Mission').session
        expect(() => registry.select({ owner: 'alice' })).toThrow(expect.objectContaining({ code: ERROR_CODES.AMBIGUOUS_BROWSER_SESSION }))
        expect(registry.select({ owner: 'alice', mission: 'Reference-Mission' })).toBe(b)
        expect(registry.select({ owner: 'alice', sessionId: a.id })).toBe(a)
        expect(() => registry.select({ owner: 'alice', sessionId: a.id, mission: 'Reference-Mission' })).toThrow(
            expect.objectContaining({ code: ERROR_CODES.MISSION_MISMATCH })
        )
        // Another user's session is indistinguishable from a missing one.
        expect(() => registry.select({ owner: 'bob', sessionId: a.id })).toThrow(expect.objectContaining({ code: ERROR_CODES.SESSION_NOT_FOUND }))
        expect(registry.list({ owner: 'bob' })).toEqual([])
        expect(() => registry.select({ owner: 'bob' })).toThrow(expect.objectContaining({ code: ERROR_CODES.NO_BROWSER_SESSION }))
    })

    test("missionOf() reports a registered session's mission and null for unknown ids", () => {
        const registry = new BrowserSessionRegistry()
        const { session } = registerOne(registry, 'alice', 'Reference-Mission')
        expect(registry.missionOf(session.id)).toBe('Reference-Mission')
        expect(registry.missionOf('no-such-session')).toBe(null)
        expect(registry.missionOf(undefined)).toBe(null)
        registry.unregister(session)
        expect(registry.missionOf(session.id)).toBe(null)
    })

    test('keeps at most maxSessionsPerUser sessions per user, replacing the least recently seen', () => {
        const clock = fakeClock()
        const registry = new BrowserSessionRegistry({ maxSessionsPerUser: 2, now: clock.now })
        const first = registerOne(registry).session
        clock.advance(10)
        registerOne(registry)
        clock.advance(10)
        registerOne(registry)
        expect(registry.list({ owner: 'alice' }).length).toBe(2)
        expect(registry.sessions.has(first.id)).toBe(false)
        registerOne(registry, 'bob')
        expect(registry.list({ owner: 'bob' }).length).toBe(1)
    })
})
