// Live end-to-end verification of the Copilot MCP interface against a running
// MMGIS (opt-in: COPILOT_MCP_LIVE=1; see backend/CopilotMCP/README.md).
//
// Every Copilot registry tool runs twice from the same starting state: in one
// browser session through the existing Copilot chat (only the LLM planner
// response is mocked, so the chat's own exec() path runs), and in a second
// session of the same mission through MCP. The resulting map state and the
// Copilot output must be equivalent, and other sessions must not change.
import { test, expect } from '@playwright/test'

const fs = require('fs')
const path = require('path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const LIVE = process.env.COPILOT_MCP_LIVE === '1'
const APP = (process.env.MMGIS_APP_URL || 'http://localhost:8889').replace(/\/$/, '')
const API = (process.env.MMGIS_API_URL || 'http://localhost:8888').replace(/\/$/, '')
const MISSION = process.env.COPILOT_MCP_MISSION || 'frozon'
const MISSION2 = process.env.COPILOT_MCP_MISSION2 || 'Reference-Mission'
const REPORT = process.env.COPILOT_MCP_LIVE_REPORT || null
const USER = process.env.MMGIS_USER
const PASSWORD = process.env.MMGIS_PASSWORD
const TOKEN = process.env.MMGIS_MCP_TOKEN
const USER2 = process.env.MMGIS_USER2
const PASSWORD2 = process.env.MMGIS_PASSWORD2
const MARKER = 'mcp-live-check'

// Layers of the frozon mission used by the equivalence sequence.
const SWOT = 'SWOT freeboard'
const ICESAT = 'ICESat-2 freeboard'
const COUNTRIES = 'Polar Countries'
const SSHA = 'ssha SWOT_L2_LR_NPFRB_024_535 COG'

test.describe.configure({ mode: 'serial' })
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } })

const report = { started_at: new Date().toISOString(), app: APP, api: API, mission: MISSION, mission2: MISSION2, cases: [], page_errors: [] }
let context
let client
let chat
let mcp
let idle
let other
let chatSeq = 0

function record(entry) {
    report.cases.push(entry)
}

async function login(ctx, username, password) {
    const res = await ctx.request.post(`${API}/api/users/login`, { data: { username, password } })
    const body = await res.json()
    expect(body.status, `login ${username}`).toBe('success')
    await ctx.addCookies([{ name: 'MMGISUser', value: JSON.stringify({ username: body.username, token: body.token }), domain: new URL(APP).hostname, path: '/' }])
}

async function connect(headers) {
    const transport = new StreamableHTTPClientTransport(new URL(`${API}/api/copilot-mcp/mcp`), { requestInit: { headers } })
    const c = new Client({ name: 'copilot-mcp-live-test', version: '0.1.0' })
    await c.connect(transport)
    return c
}

async function settle(page) {
    await page.evaluate(async () => {
        const map = window.mmgisAPI.map
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        const deadline = Date.now() + 5000
        while ((map._animatingZoom || (map._panAnim && map._panAnim._inProgress)) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100))
        }
    })
    await page.waitForTimeout(800)
}

async function openMission(mission, label) {
    const page = await context.newPage()
    page.on('pageerror', (e) => report.page_errors.push(`${label}: ${e.message}`))
    await page.goto(`${APP}/?mission=${encodeURIComponent(mission)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    return attach(page, mission, label)
}

async function attach(page, mission, label) {
    await page.waitForFunction(() => window.mmgisAPI && window.mmgisAPI.map && window.ToolController_ && window.ToolController_.loaded, null, { timeout: 120000 })
    await page.waitForFunction(() => window.mmgisCopilotMCPBridge && window.mmgisCopilotMCPBridge.sessionId && window.mmgisCopilotMCPBridge.state === 'connected', null, { timeout: 60000 })
    // Same panels in every page so the map containers (and "current view" analyses) match.
    await page.evaluate(() => window.ToolController_.openTool('AgentChat'))
    await page.waitForSelector('#agentChatInput', { timeout: 30000 })
    await page.waitForTimeout(3000)
    await settle(page)
    const sessionId = await page.evaluate(() => window.mmgisCopilotMCPBridge.sessionId)
    return { page, mission, label, sessionId }
}

async function navigate(p, mission) {
    await p.page.goto(`${APP}/?mission=${encodeURIComponent(mission)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    return attach(p.page, mission, p.label)
}

// Map state read from MMGIS's public browser API, independently of the bridge.
function readState(p) {
    return p.page.evaluate(() => {
        const r = (v, d = 4) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v === undefined ? null : v)
        const get = (fn) => {
            try {
                const v = fn()
                return v === undefined ? null : v
            } catch (_) {
                return null
            }
        }
        const api = window.mmgisAPI
        const map = api.map
        const c = map.getCenter()
        const configs = get(() => api.getLayerConfigs()) || {}
        const visible = get(() => api.getVisibleLayers()) || {}
        const opacity = (window.L_ && window.L_.layers && window.L_.layers.opacity) || {}
        const layers = {}
        for (const [id, cfg] of Object.entries(configs)) {
            if (!cfg || cfg.type === 'header') continue
            layers[id] = {
                name: cfg.display_name || cfg.name,
                visible: !!visible[id],
                opacity: r(opacity[id], 3),
                time: cfg.time && cfg.time.enabled ? [get(() => api.getLayerStartTime(id)), get(() => api.getLayerEndTime(id))] : null,
            }
        }
        const store = window.__mmgisAgentChatOverlays || {}
        const tile = store.highlightTile
        const overlays = {}
        for (const [key, group] of Object.entries(store)) {
            if (key !== 'highlightTile' && group && typeof group.getLayers === 'function') overlays[key] = { features: group.getLayers().length, on_map: map.hasLayer(group) }
        }
        return {
            center: [r(c.lng), r(c.lat)],
            zoom: r(map.getZoom(), 3),
            time: [get(() => api.getStartTime()), get(() => api.getEndTime())],
            layers,
            highlight: tile ? { on_map: map.hasLayer(tile), opacity: r(tile.options.opacity, 3), url: String(tile._url || '').replace(/^https?:\/\/[^/]+/, '') } : null,
            overlays,
            animation_ui: !!document.getElementById('mmgis-animation-overlay'),
            active_tool: window.ToolController_.activeToolName || null,
        }
    })
}

function changedLayers(before, after) {
    return Object.keys(after.layers).filter((id) => JSON.stringify(before.layers[id]) !== JSON.stringify(after.layers[id]))
}

// Runs actions through the existing Copilot chat: only the planner (LLM)
// response for this one message is mocked; everything else is the chat's code.
async function runInChat(p, actions, message = null) {
    const seq = ++chatSeq
    const text = message || `${MARKER} ${seq}`
    const handler = async (route) => {
        const req = route.request()
        if (!message && req.method() === 'POST' && (req.postData() || '').includes(`"${text}"`)) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: `${MARKER} plan ${seq}`, text: '', actions, citations: [] }) })
        }
        return route.fallback()
    }
    await p.page.route('**/api/agent**', handler)
    await p.page.evaluate(() => {
        window.__liveChatLines = window.__liveChatLines || []
        const current = window.__mmgisAgentChatAppend
        if (typeof current === 'function' && !current.__live) {
            const wrapped = function (t) {
                window.__liveChatLines.push(String(t))
                return current.apply(this, arguments)
            }
            wrapped.__live = true
            window.__mmgisAgentChatAppend = wrapped
        }
        window.__liveChatLines.length = 0
    })
    await p.page.fill('#agentChatInput', text)
    await p.page.click('#agentChatSend')
    await p.page.waitForFunction(() => !document.querySelector('#agentChatSend[data-loading]'), null, { timeout: 240000 })
    await settle(p.page)
    await p.page.unroute('**/api/agent**', handler)
    return p.page.evaluate(() => window.__liveChatLines.slice())
}

async function runInMcp(p, tool, args) {
    const res = await client.callTool({ name: tool, arguments: { ...args, session_id: p.sessionId } })
    await settle(p.page)
    return { isError: !!res.isError, sc: res.structuredContent }
}

const maskNumbers = (lines) => (lines || []).map((l) => l.replace(/\d[\d,.]*/g, '#'))

function stateWithout(state, keys) {
    const copy = JSON.parse(JSON.stringify(state))
    for (const k of keys) delete copy[k]
    return copy
}

// [capability, tool, args, options]
//   output: 'exact' | 'masked' (synthetic values) | 'none'
//   status: expected MCP status (default 'succeeded'); errorCode for failures
const SEQUENCE = [
    ['Layer discovery: list layers', 'list_layers', {}, { output: 'exact' }],
    ['Layer discovery: analyzable layers', 'list_analyzable_layers', {}, { output: 'exact' }],
    ['Layer metadata: describe layer', 'describe_layer', { name: SWOT }, { output: 'exact' }],
    ['Layer control: visibility', 'toggle_layer', { name: SWOT, visible: true }, { output: 'exact' }],
    ['Layer control: opacity', 'set_layer_opacity', { name: COUNTRIES, opacity: 0.5 }, { output: 'exact' }],
    ['Map navigation: center/zoom', 'zoom_to', { center: [-150, 72], zoom: 4 }, { output: 'exact' }],
    ['Map navigation: bbox', 'zoom_to', { bbox: [-170, 65, -130, 80] }, { output: 'exact' }],
    ['Time selection', 'set_time', { time: '2024-03-15T00:00:00Z', layers: [SWOT] }, { output: 'exact' }],
    ['Threshold highlighting', 'threshold_highlight', { layer_name: SWOT, variable: 'freeboard', operator: '>', value: 0.3 }, { output: 'exact' }],
    ['Highlight opacity', 'highlight_opacity', { delta: -0.3 }, { output: 'exact' }],
    ['Highlight hide', 'highlight_toggle', {}, { output: 'exact' }],
    ['Highlight show', 'highlight_toggle', {}, { output: 'exact' }],
    ['Highlight clear', 'highlight_clear', {}, { output: 'exact' }],
    ['Statistics: regional mean (server)', 'calculate_layer_mean', { layer_name: SWOT, geographical_area: 'Beaufort Sea' }, { output: 'exact' }],
    ['Comparison: layer difference (server)', 'calculate_layer_difference', { layer_a: SWOT, layer_b: ICESAT }, { output: 'exact' }],
    ['Statistics: multi-layer + correlation', 'multilayer_statistics', { layer_names: [SWOT, ICESAT] }, { output: 'exact' }],
    ['Analysis: temporal trends', 'temporal_trends', { layer_name: SWOT, time_start: '2023-10-01', time_end: '2024-04-01', interval: 'monthly' }, { output: 'exact' }],
    ['Spatial analysis: autocorrelation/hotspots', 'spatial_statistics', { layer_name: SWOT }, { output: 'exact' }],
    ['Comparison: change detection', 'change_detection', { layer_name: SWOT, before_time: '2023-11-01', after_time: '2024-03-01' }, { output: 'exact' }],
    ['Anomaly detection (simulated handler)', 'detect_anomalies', { layer_name: SWOT }, { output: 'exact' }],
    ['Export (synthetic handler)', 'data_export', { layer_name: SWOT, format: 'csv', auto_download: false }, { output: 'masked' }],
    ['Layer information (Copilot backend)', 'layer_information', { layer_name: SWOT }, { output: 'none', status: 'failed' }],
    ['Integration: Analysis tool', 'run_analysis', { layer_name: SWOT, chart_type: 'histogram', start_date: '2024-01-01', end_date: '2024-03-01' }, { output: 'exact' }],
    ['Integration: Animation tool (not in mission)', 'open_animation_tool', { layer_name: SWOT, start_date: '2023-10-01', end_date: '2024-03-01' }, { output: 'exact', status: 'failed', errorCode: 'CAPABILITY_UNAVAILABLE' }],
    ['Animation: time series', 'time_series_animation', { layer_name: SWOT, time_start: '2023-10-01', time_end: '2024-03-01', interval: 'monthly', auto_play: false }, { output: 'exact' }],
]

test.describe('Copilot MCP live verification @live', () => {
    test.skip(!LIVE, 'Live test: set COPILOT_MCP_LIVE=1, MMGIS_USER, MMGIS_PASSWORD and MMGIS_MCP_TOKEN (see README).')

    test.beforeAll(async ({ browser }, testInfo) => {
        testInfo.setTimeout(10 * 60 * 1000)
        expect(USER && PASSWORD && TOKEN, 'MMGIS_USER, MMGIS_PASSWORD and MMGIS_MCP_TOKEN are required').toBeTruthy()
        context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
        await login(context, USER, PASSWORD)
        client = await connect({ Authorization: `Bearer ${TOKEN}` })
        chat = await openMission(MISSION, 'chat')
        mcp = await openMission(MISSION, 'mcp')
        idle = await openMission(MISSION, 'idle')
        other = await openMission(MISSION2, 'other-mission')
    })

    test.afterAll(async () => {
        report.finished_at = new Date().toISOString()
        if (REPORT) {
            fs.mkdirSync(path.dirname(REPORT), { recursive: true })
            fs.writeFileSync(REPORT, JSON.stringify(report, null, 2))
        }
        if (client) await client.close()
        if (context) await context.close()
    })

    test('discovery and session routing', async () => {
        const { tools } = await client.listTools()
        const registry = await (await context.request.get(`${API}/api/agent/tools`)).json()
        const registryNames = registry.tools.map((t) => t.name)
        for (const name of registryNames) expect(tools.map((t) => t.name)).toContain(name)
        const sessions = (await client.callTool({ name: 'mmgis_list_sessions', arguments: {} })).structuredContent
        const ids = sessions.sessions.map((s) => s.session_id)
        for (const p of [chat, mcp, idle, other]) expect(ids).toContain(p.sessionId)
        const ambiguous = await client.callTool({ name: 'list_layers', arguments: { mission: MISSION } })
        expect(ambiguous.structuredContent.error.code).toBe('AMBIGUOUS_BROWSER_SESSION')
        record({ capability: 'MCP discovery', tool: 'tools/list', status: 'verified', evidence: `${tools.length} tools; all ${registryNames.length} Copilot registry tools present` })
        record({ capability: 'Browser-session routing', tool: 'mmgis_list_sessions', status: 'verified', evidence: `${ids.length} sessions listed; ambiguous call rejected without executing` })
    })

    test('server-side Copilot operations return what the Copilot backend endpoints return', async () => {
        const direct = async (url) => {
            const res = await context.request.get(`${API}${url}`)
            return { status: res.status(), body: await res.json().catch(() => null) }
        }
        const call = async (name, args) => {
            const r = await client.callTool({ name, arguments: args })
            return { isError: !!r.isError, sc: r.structuredContent }
        }
        const m = encodeURIComponent(MISSION)
        const checks = [
            ['Copilot tool registry', 'copilot_tool_registry', {}, '/api/agent/tools', (sc, d) => expect(sc.tools.map((t) => t.name)).toEqual(d.body.tools.map((t) => t.name))],
            ['Example queries', 'copilot_demo_queries', {}, '/api/agent/copilot/demo-queries', (sc, d) => expect(sc.queries).toEqual(d.body.queries)],
            ['Analytics layer catalog', 'copilot_analytics_layers', { mission: MISSION }, `/api/agent/analytics/layers?mission=${m}`, (sc, d) => expect(sc.layers).toEqual(d.body.layers)],
            ['Raster statistics (server)', 'copilot_raster_statistics', { mission: MISSION, layer_name: SSHA }, `/api/agent/analytics/statistics?mission=${m}&layer_name=${encodeURIComponent(SSHA)}`, (sc, d) => expect(sc.statistics).toEqual(d.body)],
            ['Raster statistics in a bbox (server)', 'copilot_raster_statistics', { mission: MISSION, layer_name: SWOT, bbox: [-160, 70, -120, 76] }, `/api/agent/analytics/statistics?mission=${m}&layer_name=${encodeURIComponent(SWOT)}&lon_min=-160&lat_min=70&lon_max=-120&lat_max=76`, (sc, d) => expect(sc.statistics).toEqual(d.body)],
            ['Raster difference (server)', 'copilot_raster_difference', { mission: MISSION, layer_a: SWOT, layer_b: ICESAT, time: '2024-03-15' }, `/api/agent/analytics/difference?mission=${m}&layer_a=${encodeURIComponent(SWOT)}&layer_b=${encodeURIComponent(ICESAT)}&time=2024-03-15`, (sc, d) => expect(sc.difference).toEqual(d.body)],
            ['COG resolution', 'copilot_resolve_cog', { mission: MISSION, layer_name: SSHA }, `/api/agent/analytics/resolve-cog?mission=${m}&layer_name=${encodeURIComponent(SSHA)}`, (sc, d) => expect(stateWithout(sc, ['status'])).toEqual(d.body)],
            ['Conversations', 'copilot_conversations', { action: 'list', mission: MISSION }, `/api/agent/conversations?mission=${m}`, (sc, d) => expect(sc.conversations).toEqual(d.body.conversations || [])],
        ]
        for (const [capability, tool, args, url, compare] of checks) {
            const [r, d] = await Promise.all([call(tool, args), direct(url)])
            let ok = true
            let note = ''
            try {
                expect(d.status).toBe(200)
                expect(r.isError).toBe(false)
                compare(r.sc, d)
            } catch (e) {
                ok = false
                note = String(e.message).split('\n')[0]
            }
            expect.soft(ok, `${tool}: ${note}`).toBe(true)
            record({ capability, tool, status: ok ? 'verified' : 'failed', evidence: ok ? `equals GET ${url.split('?')[0]}` : note })
        }
        // Copilot backend operations that fail upstream fail identically through MCP.
        for (const [capability, tool, args, url] of [
            ['Layer reference info', 'copilot_layer_info', { mission: MISSION }, `/api/agent/layer-info?mission=${m}`],
            ['Region resolver', 'copilot_resolve_region', { name: 'Beaufort Sea' }, `/api/agent/regions/resolve?name=Beaufort%20Sea`],
        ]) {
            const [r, d] = await Promise.all([call(tool, args), direct(url)])
            const same = d.status === 200 ? !r.isError : r.isError && r.sc.error.code === 'UPSTREAM_ERROR' && r.sc.error.details.http_status === d.status
            expect.soft(same, `${tool} mirrors HTTP ${d.status}`).toBe(true)
            record({ capability, tool, status: d.status === 200 ? 'verified' : 'verified-upstream-unavailable', evidence: `MCP ${r.isError ? r.sc.error.code : 'success'} mirrors Copilot endpoint HTTP ${d.status}${d.body && (d.body.code || d.body.error) ? ` (${d.body.code || d.body.error})` : ''}` })
        }
    })

    test('every Copilot registry tool: MCP in one session is equivalent to the Copilot chat in another', async () => {
        test.setTimeout(40 * 60 * 1000)
        const idleBefore = await readState(idle)
        const otherBefore = await readState(other)
        const start = [await readState(chat), await readState(mcp)]
        expect(stateWithout(start[1], [])).toEqual(stateWithout(start[0], []))
        for (const [capability, tool, args, opts] of SEQUENCE) {
            const before = await readState(mcp)
            const chatLines = await runInChat(chat, [{ tool, args }])
            const result = await runInMcp(mcp, tool, args)
            const [chatState, mcpState] = [await readState(chat), await readState(mcp)]
            const expectedStatus = opts.status || 'succeeded'
            const problems = []
            if (result.sc.status !== expectedStatus) problems.push(`MCP status ${result.sc.status} (expected ${expectedStatus})${result.sc.error ? `: ${result.sc.error.code} ${result.sc.error.message}` : ''}`)
            if (opts.errorCode && (!result.sc.error || result.sc.error.code !== opts.errorCode)) problems.push(`error code ${result.sc.error && result.sc.error.code} (expected ${opts.errorCode})`)
            if (JSON.stringify(chatState) !== JSON.stringify(mcpState)) {
                const diff = Object.keys(mcpState).filter((k) => JSON.stringify(mcpState[k]) !== JSON.stringify(chatState[k]))
                problems.push(`resulting state differs from the Copilot chat in: ${diff.join(', ')}`)
            }
            const mcpLines = result.sc.output || []
            if (opts.output === 'exact' && JSON.stringify(mcpLines) !== JSON.stringify(chatLines)) problems.push('output differs from the Copilot chat output')
            if (opts.output === 'masked' && JSON.stringify(maskNumbers(mcpLines)) !== JSON.stringify(maskNumbers(chatLines))) problems.push('output structure differs from the Copilot chat output')
            const verification = result.sc.verification || {}
            expect.soft(problems, `${tool} ${JSON.stringify(args)}`).toEqual([])
            record({
                capability,
                tool,
                args,
                status: problems.length ? 'failed' : 'verified',
                mcp_status: result.sc.status,
                error_code: result.sc.error ? result.sc.error.code : null,
                state_verified: verification.verified === undefined ? null : verification.verified,
                checks: verification.checks || [],
                notes: verification.notes || [],
                equivalent_to_chat: { state: JSON.stringify(chatState) === JSON.stringify(mcpState), output: opts.output === 'none' ? null : !problems.some((p) => p.startsWith('output')) },
                changed_layers: changedLayers(before, mcpState).map((id) => mcpState.layers[id].name),
                output_head: mcpLines.join('\n').slice(0, 300),
                problems,
            })
        }
        // MCP commands went only to the targeted session.
        const idleAfter = await readState(idle)
        const otherAfter = await readState(other)
        expect(idleAfter, 'idle session of the same mission unchanged').toEqual(idleBefore)
        expect(otherAfter, 'session of another mission unchanged').toEqual(otherBefore)
        record({ capability: 'Isolation: other session, same mission', tool: '(all)', status: 'verified', evidence: `${SEQUENCE.length} MCP calls; idle ${MISSION} session state unchanged` })
        record({ capability: 'Isolation: other mission', tool: '(all)', status: 'verified', evidence: `${MISSION2} session state unchanged` })
    })

    test('copilot_ask local commands and undo are equivalent to the Copilot chat', async () => {
        const reload = async () => {
            chat = await navigate(chat, MISSION)
            mcp = await navigate(mcp, MISSION)
        }
        await reload()
        for (const [capability, message] of [
            ['Local command: MMGIS overview', 'What is MMGIS?'],
            ['Local command: preset region zoom', 'zoom to point barrow'],
            ['Local command: time slider', 'set the time slider to March 2024'],
        ]) {
            await runInChat(chat, null, message)
            const r = await client.callTool({ name: 'copilot_ask', arguments: { message, session_id: mcp.sessionId } })
            await settle(mcp.page)
            const sc = r.structuredContent
            const [cs, ms] = [await readState(chat), await readState(mcp)]
            const problems = []
            if (sc.status !== 'succeeded' || !sc.handled_locally) problems.push(`copilot_ask ${sc.status} handled_locally=${sc.handled_locally}`)
            if (JSON.stringify(cs) !== JSON.stringify(ms)) problems.push('state differs from the Copilot chat')
            const transcript = await chat.page.$eval('#agentChatTranscript', (el) => el.innerText)
            if (!transcript.replace(/\s+/g, ' ').includes(String(sc.reply || '').split('\n')[0].replace(/\s+/g, ' '))) problems.push('reply differs from the Copilot chat reply')
            expect.soft(problems, message).toEqual([])
            record({ capability, tool: 'copilot_ask', args: { message }, status: problems.length ? 'failed' : 'verified', reply: sc.reply, problems })
        }

        // Undo: same toggles in both, then 'undo last' (chat) vs mmgis_undo_last_action / copilot_ask (MCP).
        await reload()
        const start = await readState(mcp)
        for (const visible of [true, false]) {
            await runInChat(chat, [{ tool: 'toggle_layer', args: { name: ICESAT, visible } }])
            await runInMcp(mcp, 'toggle_layer', { name: ICESAT, visible })
        }
        await runInChat(chat, [{ tool: 'zoom_to', args: { center: [-140, 75], zoom: 3 } }])
        await runInMcp(mcp, 'zoom_to', { center: [-140, 75], zoom: 3 })
        const undoSteps = [
            ['mmgis_undo_last_action', {}],
            ['copilot_ask', { message: 'undo last' }],
            ['mmgis_undo_last_action', {}],
        ]
        const problems = []
        for (const [tool, args] of undoSteps) {
            await runInChat(chat, null, 'undo last')
            const r = await runInMcp(mcp, tool, args)
            if (r.sc.status !== 'succeeded' || (r.sc.verification && r.sc.verification.verified === false)) problems.push(`${tool}: ${r.sc.status}`)
            if (JSON.stringify(await readState(chat)) !== JSON.stringify(await readState(mcp))) problems.push(`${tool}: state differs from the chat after 'undo last'`)
        }
        const end = await readState(mcp)
        if (JSON.stringify(end) !== JSON.stringify(start)) problems.push('three undos did not restore the starting state')
        const empty = await runInMcp(mcp, 'mmgis_undo_last_action', {})
        if (empty.sc.status !== 'no_effect') problems.push(`empty undo stack returned ${empty.sc.status}`)
        expect.soft(problems, 'undo').toEqual([])
        record({ capability: 'Undo last action', tool: 'mmgis_undo_last_action / copilot_ask "undo last"', status: problems.length ? 'failed' : 'verified', problems })
    })

    test('MCP calls are confined to their user: another user cannot see or drive these sessions', async () => {
        test.skip(!USER2 || !PASSWORD2, 'Set MMGIS_USER2/MMGIS_PASSWORD2 (a second, non-admin account) for the cross-user check.')
        const ctx2 = await context.browser().newContext()
        try {
            await login(ctx2, USER2, PASSWORD2)
            const cookie = (await ctx2.cookies(API)).map((c) => `${c.name}=${c.value}`).join('; ')
            const c2 = await connect({ Cookie: cookie })
            const list = (await c2.callTool({ name: 'mmgis_list_sessions', arguments: {} })).structuredContent
            const before = await readState(mcp)
            const foreign = (await c2.callTool({ name: 'toggle_layer', arguments: { name: ICESAT, visible: true, session_id: mcp.sessionId } })).structuredContent
            const after = await readState(mcp)
            await c2.close()
            const problems = []
            if (list.user !== USER2) problems.push(`list_sessions user ${list.user}`)
            if (list.sessions.some((s) => [chat, mcp, idle, other].some((p) => p.sessionId === s.session_id))) problems.push('another user can list these sessions')
            if (!foreign.error || foreign.error.code !== 'SESSION_NOT_FOUND') problems.push(`foreign session call returned ${foreign.status}`)
            if (JSON.stringify(before) !== JSON.stringify(after)) problems.push('foreign call changed the session')
            expect(problems).toEqual([])
            record({ capability: 'Isolation: other user', tool: 'mmgis_list_sessions / toggle_layer', status: 'verified', evidence: `${USER2} sees ${list.sessions.length} sessions; targeting ${USER}'s session returns SESSION_NOT_FOUND; map unchanged` })
        } finally {
            await ctx2.close()
        }
    })

    test(`${MISSION2}: Animation tool integration and Web Mercator navigation are equivalent to the chat`, async () => {
        chat = await navigate(chat, MISSION2)
        mcp = await navigate(mcp, MISSION2)
        for (const [capability, tool, args] of [
            ['Integration: Animation tool', 'open_animation_tool', { layer_name: 'EMIT Methane Mosaicked', start_date: '2023-08-01', end_date: '2023-08-31' }],
            ['Map navigation (Web Mercator)', 'zoom_to', { bbox: [-122.6, 37.6, -122.3, 37.9] }],
        ]) {
            const chatLines = await runInChat(chat, [{ tool, args }])
            const r = await runInMcp(mcp, tool, args)
            const [cs, ms] = [await readState(chat), await readState(mcp)]
            const problems = []
            if (r.sc.status !== 'succeeded') problems.push(`MCP status ${r.sc.status}${r.sc.error ? ` ${r.sc.error.code}: ${r.sc.error.message}` : ''}`)
            if (JSON.stringify(cs) !== JSON.stringify(ms)) problems.push('resulting state differs from the Copilot chat')
            if (JSON.stringify(chatLines) !== JSON.stringify(r.sc.output || [])) problems.push('output differs from the Copilot chat output')
            expect.soft(problems, tool).toEqual([])
            record({ capability, tool, args, mission: MISSION2, status: problems.length ? 'failed' : 'verified', mcp_status: r.sc.status, state_verified: r.sc.verification && r.sc.verification.verified, active_tool: ms.active_tool, problems })
        }
    })

    test('a browser that disappears without unregistering is dropped from the session list (liveness)', async ({ browser }) => {
        test.setTimeout(4 * 60 * 1000)
        const extra = await browser.browserType().launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
        let sessionId
        try {
            const ctx = await extra.newContext({ viewport: { width: 1280, height: 800 } })
            await login(ctx, USER, PASSWORD)
            const page = await ctx.newPage()
            await page.goto(`${APP}/?mission=${encodeURIComponent(MISSION)}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
            await page.waitForFunction(() => window.mmgisCopilotMCPBridge && window.mmgisCopilotMCPBridge.sessionId && window.mmgisCopilotMCPBridge.state === 'connected', null, { timeout: 120000 })
            sessionId = await page.evaluate(() => window.mmgisCopilotMCPBridge.sessionId)
        } finally {
            await extra.close() // kills the browser: no pagehide/unregister reaches the server
        }
        const listed = async () => (await client.callTool({ name: 'mmgis_list_sessions', arguments: {} })).structuredContent.sessions.some((s) => s.session_id === sessionId)
        expect(await listed()).toBe(true)
        const closedAt = Date.now()
        let gone = false
        while (!gone && Date.now() - closedAt < 120000) {
            await new Promise((r) => setTimeout(r, 5000))
            gone = !(await listed())
        }
        const seconds = Math.round((Date.now() - closedAt) / 1000)
        expect(gone, 'stale session removed').toBe(true)
        const call = await client.callTool({ name: 'list_layers', arguments: { session_id: sessionId } })
        expect(call.structuredContent.error.code).toBe('SESSION_NOT_FOUND')
        record({ capability: 'Liveness: vanished browser', tool: 'mmgis_list_sessions', status: 'verified', evidence: `killed browser's session removed after ~${seconds}s (behind the dev-server proxy); later calls get SESSION_NOT_FOUND` })
    })

    test('copilot_ask planner path (needs the Agent LLM provider)', async () => {
        const r = await client.callTool({ name: 'copilot_ask', arguments: { message: 'What layers are available in this mission?', session_id: mcp.sessionId } })
        const sc = r.structuredContent
        if (r.isError && sc.error.code === 'UPSTREAM_ERROR') {
            record({ capability: 'Natural-language planning (LLM)', tool: 'copilot_ask', status: 'blocked', evidence: sc.error.message })
            test.info().annotations.push({ type: 'blocked', description: sc.error.message })
            return
        }
        expect(sc.status === 'succeeded' || sc.status === 'partially_failed').toBe(true)
        record({ capability: 'Natural-language planning (LLM)', tool: 'copilot_ask', status: 'verified', evidence: `${(sc.actions || []).length} planned actions executed` })
    })
})
