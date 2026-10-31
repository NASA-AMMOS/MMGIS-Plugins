// @unit integration tests: the real CopilotMCP routes over HTTP with the
// official MCP SDK client, a stand-in Agent API and simulated bridge pages.
import { test, expect } from '@playwright/test'

const { createFakeMmgis, FakePage, connectClient, rawRequest } = require('./helpers/harness')

test.describe.configure({ mode: 'serial' })

let mmgis
let baseUrl
let alice

const structured = (result) => result.structuredContent

test.beforeAll(async () => {
    mmgis = createFakeMmgis()
    baseUrl = await mmgis.start()
    alice = await connectClient(baseUrl, 'tok-alice')
})

test.afterAll(async () => {
    if (alice) await alice.close()
    if (mmgis) await mmgis.stop()
})

test.describe('Copilot MCP over HTTP @unit', () => {
    test('discovery: the 23 Copilot registry tools plus the server/session tools, with routing-aware schemas', async () => {
        const { tools } = await alice.listTools()
        const names = tools.map((t) => t.name)
        const registryNames = mmgis.app.locals.agentToolRegistry.tools.map((t) => t.name)
        expect(registryNames.length).toBe(23)
        for (const name of registryNames) expect(names).toContain(name)
        for (const name of [
            'copilot_ask',
            'copilot_tool_registry',
            'copilot_demo_queries',
            'copilot_conversations',
            'copilot_layer_info',
            'copilot_resolve_region',
            'copilot_analytics_layers',
            'copilot_raster_statistics',
            'copilot_raster_difference',
            'copilot_resolve_cog',
            'mmgis_list_sessions',
            'mmgis_get_map_state',
            'mmgis_undo_last_action',
        ]) {
            expect(names).toContain(name)
        }
        expect(tools.length).toBe(36)
        for (const tool of tools) {
            expect(tool.description.length).toBeGreaterThan(20)
            expect(tool.inputSchema.type).toBe('object')
        }
        const toggle = tools.find((t) => t.name === 'toggle_layer')
        expect(toggle.inputSchema.required).toEqual(expect.arrayContaining(['name', 'visible']))
        expect(toggle.inputSchema.properties.session_id).toBeTruthy()
        expect(tools.find((t) => t.name === 'zoom_to').inputSchema.oneOf.every((b) => b.properties.session_id)).toBe(true)
        expect(tools.find((t) => t.name === 'detect_anomalies').description).toContain('SIMULATED')
        expect(tools.find((t) => t.name === 'data_export').description).toContain('SYNTHETIC')
    })

    test('server tools call the Copilot backend with the caller credentials and return its data', async () => {
        const stats = structured(await alice.callTool({ name: 'copilot_raster_statistics', arguments: { mission: 'frozon', layer_name: 'SWOT freeboard', region: 'Beaufort Sea' } }))
        expect(stats).toMatchObject({ status: 'succeeded', mission: 'frozon', region: { label: 'Beaufort Sea', bbox: [-160, 70, -120, 76] } })
        expect(stats.statistics).toMatchObject({ mean: 0.0788, bbox: [-160, 70, -120, 76], layer_name: 'SWOT freeboard' })
        const upstreamStats = mmgis.upstream.requests.filter((r) => r.url.startsWith('/api/agent/analytics/statistics'))
        expect(upstreamStats.at(-1).authorization).toBe('Bearer tok-alice')

        const registry = structured(await alice.callTool({ name: 'copilot_tool_registry', arguments: {} }))
        expect(registry.count).toBe(23)
        const demo = structured(await alice.callTool({ name: 'copilot_demo_queries', arguments: {} }))
        expect(demo.queries.length).toBe(2)

        const upstreamError = await alice.callTool({ name: 'copilot_raster_statistics', arguments: { mission: 'frozon', layer_name: 'Land Mask' } })
        expect(upstreamError.isError).toBe(true)
        expect(structured(upstreamError).error).toMatchObject({ code: 'UPSTREAM_ERROR', details: { http_status: 422 } })

        const forbidden = await alice.callTool({ name: 'copilot_raster_statistics', arguments: { mission: 'Secret-Mission', layer_name: 'x' } })
        expect(structured(forbidden).error.code).toBe('MISSION_FORBIDDEN')
    })

    test('input validation uses the Copilot planner rules; unknown tools are protocol errors', async () => {
        const opacity = await alice.callTool({ name: 'set_layer_opacity', arguments: { name: 'Polar Countries', opacity: 'high' } })
        expect(opacity.isError).toBe(true)
        expect(structured(opacity).error).toMatchObject({ code: 'INVALID_INPUT' })
        expect(structured(opacity).error.details.errors[0]).toMatchObject({ path: '.opacity', message: 'should be number' })

        const outOfRange = await alice.callTool({ name: 'set_layer_opacity', arguments: { name: 'Polar Countries', opacity: 1.5 } })
        expect(structured(outOfRange).error.code).toBe('INVALID_INPUT')

        const time = await alice.callTool({ name: 'calculate_layer_mean', arguments: { layer_name: 'SWOT freeboard', geographical_area: 'Beaufort Sea', time_start: 'March 2024' } })
        expect(structured(time).error.details.errors[0].message).toContain('date-time')

        const bbox = await alice.callTool({ name: 'copilot_raster_statistics', arguments: { mission: 'frozon', layer_name: 'x', bbox: [1, 2, 3] } })
        expect(structured(bbox).error.code).toBe('INVALID_INPUT')

        await expect(alice.callTool({ name: 'no_such_tool', arguments: {} })).rejects.toThrow(/Unknown tool: no_such_tool/)
    })

    test('browser tools need a connected session and run only in the targeted session', async () => {
        const none = await alice.callTool({ name: 'toggle_layer', arguments: { name: 'SWOT freeboard', visible: true } })
        expect(structured(none).error.code).toBe('NO_BROWSER_SESSION')

        const frozon = new FakePage(baseUrl, { mission: 'frozon' })
        const reference = new FakePage(baseUrl, { mission: 'Reference-Mission' })
        expect((await frozon.register()).status).toBe(200)
        expect((await reference.register()).status).toBe(200)
        frozon.start()
        reference.start()
        try {
            const sessions = structured(await alice.callTool({ name: 'mmgis_list_sessions', arguments: {} }))
            expect(sessions.sessions.map((s) => s.mission).sort()).toEqual(['Reference-Mission', 'frozon'])

            const ambiguous = await alice.callTool({ name: 'toggle_layer', arguments: { name: 'SWOT freeboard', visible: true } })
            expect(structured(ambiguous).error.code).toBe('AMBIGUOUS_BROWSER_SESSION')
            expect(frozon.executed.length + reference.executed.length).toBe(0)

            const byMission = await alice.callTool({ name: 'toggle_layer', arguments: { name: 'SWOT freeboard', visible: true, mission: 'frozon' } })
            expect(byMission.isError).toBeFalsy()
            expect(structured(byMission)).toMatchObject({ status: 'succeeded', session_id: frozon.id, mission: 'frozon', verification: { verified: true } })
            expect(structured(byMission).delivered_at).toBeTruthy()
            expect(frozon.executed.map((c) => [c.tool, c.args])).toEqual([['toggle_layer', { name: 'SWOT freeboard', visible: true }]])
            expect(frozon.executed[0].spec).toMatchObject({ adapter: 'mmgisAPI', method: 'toggleLayer', nameResolution: 'displayNameToInternalId' })
            expect(reference.executed).toEqual([])

            const bySession = await alice.callTool({ name: 'zoom_to', arguments: { bbox: [-170, 65, -130, 80], session_id: reference.id } })
            expect(structured(bySession).session_id).toBe(reference.id)
            expect(reference.executed.map((c) => c.tool)).toEqual(['zoom_to'])
            expect(reference.executed[0].spec).toMatchObject({ adapter: 'custom', uiType: 'zoom_view' })
            expect(frozon.executed.length).toBe(1)

            const mismatch = await alice.callTool({ name: 'list_layers', arguments: { session_id: reference.id, mission: 'frozon' } })
            expect(structured(mismatch).error.code).toBe('MISSION_MISMATCH')

            const state = structured(await alice.callTool({ name: 'mmgis_get_map_state', arguments: { mission: 'Reference-Mission' } }))
            expect(state).toMatchObject({ status: 'succeeded', data: { mission: 'Reference-Mission' } })

            const undo = await alice.callTool({ name: 'mmgis_undo_last_action', arguments: { mission: 'frozon' } })
            expect(undo.isError).toBe(true)
            expect(structured(undo)).toMatchObject({ status: 'no_effect', error: { code: 'EXECUTION_FAILED', message: 'Nothing to undo.' } })
        } finally {
            await frozon.stop()
            await reference.stop()
        }
        const after = structured(await alice.callTool({ name: 'mmgis_list_sessions', arguments: {} }))
        expect(after.sessions).toEqual([])
    })

    test('browser sessions are private to their MMGIS user and limited to missions the user may view', async () => {
        const bob = await connectClient(baseUrl, 'tok-bob')
        const page = new FakePage(baseUrl, { mission: 'frozon' })
        await page.register()
        page.start()
        try {
            const list = structured(await bob.callTool({ name: 'mmgis_list_sessions', arguments: {} }))
            expect(list).toMatchObject({ user: 'bob', viewable_missions: ['frozon'], sessions: [] })
            const foreign = await bob.callTool({ name: 'toggle_layer', arguments: { name: 'SWOT freeboard', visible: true, session_id: page.id } })
            expect(structured(foreign).error.code).toBe('SESSION_NOT_FOUND')
            const noSession = await bob.callTool({ name: 'list_layers', arguments: {} })
            expect(structured(noSession).error.code).toBe('NO_BROWSER_SESSION')
            expect(page.executed).toEqual([])

            const bobPage = new FakePage(baseUrl, { token: 'tok-bob', httpSession: 'http-bob', mission: 'Reference-Mission' })
            const denied = await bobPage.register()
            expect(denied.status).toBe(403)
            expect(denied.body).toMatchObject({ status: 'failure', code: 'MISSION_FORBIDDEN' })

            // Bridge requests must come from the session's own login.
            const hijack = new FakePage(baseUrl, { token: 'tok-bob', httpSession: 'http-bob' })
            hijack.session = page.session
            expect((await hijack.call('GET', `bridge/poll?session_id=${page.id}`, undefined, hijack.secretHeader())).status).toBe(403)
            const wrongSecret = await page.call('GET', `bridge/poll?session_id=${page.id}`, undefined, { 'X-Copilot-MCP-Secret': 'x'.repeat(64) })
            expect(wrongSecret.status).toBe(404)
        } finally {
            await page.stop()
            await bob.close()
        }
    })

    test('a session that does not pick up a command gets nothing executed (NOT_DELIVERED)', async () => {
        const page = new FakePage(baseUrl, { mission: 'frozon' })
        await page.register() // registered, but not polling (e.g. tab frozen)
        const started = Date.now()
        const result = await alice.callTool({ name: 'set_time', arguments: { time: '2024-03-01T00:00:00Z' } })
        expect(structured(result).error).toMatchObject({ code: 'NOT_DELIVERED', details: { delivered: false } })
        expect(Date.now() - started).toBeGreaterThanOrEqual(mmgis.cfg.deliveryTimeoutMs - 50)
        expect(await page.pollOnce()).toEqual([]) // the withdrawn command is not handed out later
        await page.stop()
    })

    test('a page that receives a command but never acknowledges it does not run it', async () => {
        const page = new FakePage(baseUrl, { mission: 'frozon', ack: false })
        await page.register()
        page.start()
        const result = await alice.callTool({ name: 'list_layers', arguments: {} })
        expect(structured(result).error.code).toBe('NOT_DELIVERED')
        expect(page.received.length).toBeGreaterThan(0)
        expect(page.executed).toEqual([])
        await page.stop()
    })

    test('copilot_ask: local commands run in the page; other requests are planned by the Copilot planner and executed in the session', async () => {
        const page = new FakePage(baseUrl, { mission: 'frozon' })
        await page.register()
        page.start()
        try {
            const local = structured(await alice.callTool({ name: 'copilot_ask', arguments: { message: 'What is MMGIS?' } }))
            expect(local).toMatchObject({ status: 'succeeded', handled_locally: true, session_id: page.id })
            expect(local.reply).toContain('Multi-Mission')
            expect(mmgis.upstream.plannerRequests.length).toBe(0)

            const planned = structured(await alice.callTool({ name: 'copilot_ask', arguments: { message: 'turn on swot and zoom in' } }))
            expect(planned).toMatchObject({ status: 'succeeded', handled_locally: false, executed: true, conversation_id: 'conv-1' })
            expect(planned.results.map((r) => [r.tool, r.is_error, r.result.status])).toEqual([
                ['toggle_layer', false, 'succeeded'],
                ['zoom_to', false, 'succeeded'],
            ])
            const request = mmgis.upstream.plannerRequests.at(-1)
            expect(request).toMatchObject({ mission: 'frozon', user: 'alice', body: { message: 'turn on swot and zoom in', context: { layers: [{ name: 'SWOT freeboard' }] } } })
            expect(page.executed.filter((c) => c.kind === 'copilot_action').map((c) => c.tool)).toEqual(['toggle_layer', 'zoom_to'])
            // Planned actions carry the user's request for layer resolution, as in the chat.
            expect(page.executed.filter((c) => c.kind === 'copilot_action').every((c) => c.user_query === 'turn on swot and zoom in')).toBe(true)

            const actionsBefore = page.executed.filter((c) => c.kind === 'copilot_action').length
            const planOnly = structured(await alice.callTool({ name: 'copilot_ask', arguments: { message: 'turn on swot', execute: false, mission: 'frozon' } }))
            expect(planOnly).toMatchObject({ executed: false, results: [] })
            expect(planOnly.actions.length).toBe(2)
            // Only the read-only layer context was read from the page; no action ran.
            expect(page.executed.filter((c) => c.kind === 'copilot_action').length).toBe(actionsBefore)

            const failed = await alice.callTool({ name: 'copilot_ask', arguments: { message: 'boom' } })
            expect(structured(failed).error).toMatchObject({ code: 'UPSTREAM_ERROR', details: { http_status: 500 } })
        } finally {
            await page.stop()
        }
    })

    test('HTTP layer: authentication, guests, loopback-only access and stateless POST-only endpoint', async () => {
        const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
        const anonymous = await rawRequest(baseUrl, { body: list })
        expect(anonymous.status).toBe(401)
        expect(anonymous.json).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32001 } })

        const guest = await rawRequest(baseUrl, { body: list, headers: { authorization: 'Bearer tok-guest' } })
        expect(guest.status).toBe(401)

        const rebound = await rawRequest(baseUrl, { body: list, headers: { authorization: 'Bearer tok-alice', host: 'attacker.example' } })
        expect(rebound.status).toBe(403)
        const forwarded = await rawRequest(baseUrl, { body: list, headers: { authorization: 'Bearer tok-alice', 'x-forwarded-for': '198.51.100.7' } })
        expect(forwarded.status).toBe(403)
        const bridgeRemote = await rawRequest(baseUrl, { path: '/api/copilot-mcp/bridge/register', body: { mission: 'frozon' }, headers: { authorization: 'Bearer tok-alice', origin: 'https://attacker.example' } })
        expect(bridgeRemote.status).toBe(403)

        const get = await rawRequest(baseUrl, { method: 'GET', headers: { authorization: 'Bearer tok-alice' } })
        expect(get.status).toBe(405)

        const status = await rawRequest(baseUrl, { method: 'GET', path: '/api/copilot-mcp/status', headers: { authorization: 'Bearer tok-alice' } })
        expect(status.json).toMatchObject({ status: 'success', enabled: true, loggedIn: true, user: 'alice' })
    })
})
