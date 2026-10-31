// Test harness for the Copilot MCP plugin: an Express app with stand-ins for
// MMGIS's auth middleware and the Agent plugin's HTTP API, the real CopilotMCP
// routes mounted on it, simulated CopilotMCPBridge pages and MCP SDK clients.

const path = require('path')
const http = require('http')
const { requireFromMmgis } = require('../../lib/host')
const { loadConfig } = require('../../lib/config')
const { mountCopilotMcp } = require('../../lib/mount')
const { loadFileRegistry } = require('../../lib/registry')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

const express = requireFromMmgis('express')
// Same Ajv (version and options) as the Agent plugin's registryManager.
const Ajv = require(require.resolve('ajv', { paths: [path.join(__dirname, '..', '..', '..', 'Agent')] }))

const TOKENS = { 'tok-alice': 'alice', 'tok-bob': 'bob', 'tok-guest': 'guest' }
const VIEWABLE = { alice: ['frozon', 'Reference-Mission'], bob: ['frozon'], guest: [] }

function authenticate(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (m && TOKENS[m[1]]) {
        req.user = TOKENS[m[1]]
        req.isLongTermToken = true
    }
    req.sessionID = req.headers['x-test-session'] || null
}

function createFakeMmgis(cfgOverrides = {}) {
    const app = express()
    app.use(express.json({ limit: '5mb' }))
    const s = {
        app,
        ROOT_PATH: '',
        ensureUser: () => (req, res, next) => {
            authenticate(req)
            if (!req.user) return res.send({ status: 'failure', message: 'User is not logged in.' })
            next()
        },
        stopGuests: (req, res, next) => {
            if (req.user === 'guest') return res.send({ status: 'failure', message: 'Guests may not use this endpoint.' })
            next()
        },
        checkHeadersCodeInjection: (req, res, next) => next(),
        setContentType: (req, res, next) => next(),
    }

    const registry = loadFileRegistry()
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true })
    const validators = {}
    for (const t of registry.tools) validators[t.name] = ajv.compile(t.parameters || { type: 'object' })
    app.locals.agentToolRegistry = { tools: registry.tools }
    app.locals.agentAjv = ajv
    app.locals.agentToolValidators = validators

    const upstream = { plannerRequests: [], requests: [] }
    const gate = [s.ensureUser(), s.stopGuests]
    app.use((req, _res, next) => {
        upstream.requests.push({ method: req.method, url: req.originalUrl, authorization: req.headers.authorization || null })
        next()
    })
    app.get('/api/configure/missions', s.ensureUser(), (req, res) => res.json({ status: 'success', missions: VIEWABLE[req.user] || [] }))
    app.get('/api/agent/tools', gate, (_req, res) => res.json({ tools: registry.tools }))
    app.get('/api/agent/copilot/demo-queries', gate, (_req, res) => res.json({ queries: ['What layers are available in this mission?', 'Zoom to the Arctic region'] }))
    app.get('/api/agent/regions/resolve', gate, (req, res) => {
        if (/beaufort/i.test(req.query.name || '')) return res.json({ label: 'Beaufort Sea', bbox: [-160, 70, -120, 76] })
        res.status(404).json({ error: `Unable to resolve geographical area '${req.query.name}'.` })
    })
    app.get('/api/agent/analytics/statistics', gate, (req, res) => {
        if (req.query.layer_name === 'Land Mask') return res.status(422).json({ error: 'external tile service', layer_name: 'Land Mask' })
        const bbox = req.query.lon_min ? ['lon_min', 'lat_min', 'lon_max', 'lat_max'].map((k) => Number(req.query[k])) : null
        res.json({ layer_name: req.query.layer_name, mission: req.query.mission, mean: 0.0788, std: 0.0372, bbox, source: 'local-raster' })
    })
    app.post('/api/agent', gate, (req, res) => {
        upstream.plannerRequests.push({ mission: req.query.mission, body: req.body, user: req.user })
        if (/boom/.test(req.body.message)) return res.status(500).json({ error: 'Agent planning failed.' })
        res.json({
            reply: 'Turning on SWOT freeboard and zooming in.',
            text: 'Turning on SWOT freeboard and zooming in.',
            conversationId: 'conv-1',
            actions: [
                { tool: 'toggle_layer', args: { name: 'SWOT freeboard', visible: true } },
                { tool: 'zoom_to', args: { center: [-150, 72], zoom: 4 } },
            ],
        })
    })

    const cfg = {
        ...loadConfig({ WITH_COPILOT_MCP: 'true' }),
        pollTimeoutMs: 1000,
        deliveryTimeoutMs: 1500,
        resultTimeoutMs: 5000,
        livenessGraceMs: 20000,
        ...cfgOverrides,
    }
    const mounted = mountCopilotMcp(s, cfg)
    const server = http.createServer(app)
    return {
        app,
        cfg,
        mounted,
        upstream,
        async start() {
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
            cfg.port = server.address().port // loopback calls go to this server
            mounted.start()
            return `http://127.0.0.1:${cfg.port}`
        },
        async stop() {
            mounted.stop()
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            await new Promise((resolve) => server.close(resolve))
        },
    }
}

// What the CopilotMCPBridge component reports for a command, simplified.
function defaultHandler(page) {
    return async (command) => {
        switch (command.kind) {
            case 'copilot_action':
                return {
                    ok: true,
                    status: 'succeeded',
                    output: [`${command.tool} ran in ${page.mission}`],
                    returnValue: { tool: command.tool, args: command.args },
                    verification: { verified: true, checks: [{ check: 'simulated', expected: true, actual: true, ok: true }], notes: [] },
                    effects: {},
                    state: { mission: page.mission },
                    resolvedArgs: command.args,
                    layerMatches: [],
                }
            case 'get_state':
                return { ok: true, status: 'succeeded', returnValue: { mission: page.mission }, state: { mission: page.mission } }
            case 'local_command':
                return /^what is mmgis\??$/i.test(command.message)
                    ? { ok: true, status: 'succeeded', handled: true, reply: 'MMGIS (Multi-Mission Geographic Information System) ...', effects: {}, state: {} }
                    : { ok: true, status: 'succeeded', handled: false }
            case 'agent_context':
                return { ok: true, status: 'succeeded', context: { layers: [{ name: 'SWOT freeboard', visible: false }] } }
            case 'undo':
                return { ok: false, status: 'no_effect', error: { code: 'EXECUTION_FAILED', message: 'Nothing to undo.' }, output: ['Nothing to undo.'] }
            default:
                return { ok: false, status: 'failed', error: { code: 'CAPABILITY_UNAVAILABLE', message: 'unsupported' } }
        }
    }
}

// A simulated MMGIS page running the bridge protocol: register, long-poll,
// acknowledge, execute, report.
class FakePage {
    constructor(baseUrl, { token = 'tok-alice', mission = 'frozon', httpSession = 'http-alice', handler = null, ack = true } = {}) {
        Object.assign(this, { baseUrl, token, mission, httpSession, ack })
        this.handler = handler || defaultHandler(this)
        this.executed = []
        this.received = []
        this.running = false
        this.session = null
        this.aborter = null
    }

    headers(extra = {}) {
        return { Authorization: `Bearer ${this.token}`, 'x-test-session': this.httpSession, 'Content-Type': 'application/json', ...extra }
    }

    async call(method, route, body, extraHeaders = {}, signal = undefined) {
        const res = await fetch(`${this.baseUrl}/api/copilot-mcp/${route}`, {
            method,
            headers: this.headers(extraHeaders),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
        })
        return { status: res.status, body: await res.json().catch(() => null) }
    }

    secretHeader() {
        return { 'X-Copilot-MCP-Secret': this.session.secret }
    }

    async register() {
        const res = await this.call('POST', 'bridge/register', { mission: this.mission, page: { title: `MMGIS - ${this.mission}` } })
        if (res.body && res.body.session) this.session = res.body.session
        return res
    }

    get id() {
        return this.session && this.session.id
    }

    async pollOnce(signal) {
        const res = await this.call('GET', `bridge/poll?session_id=${encodeURIComponent(this.id)}`, undefined, this.secretHeader(), signal)
        const commands = (res.body && res.body.commands) || []
        this.received.push(...commands)
        return commands
    }

    async acknowledge(ids) {
        const res = await this.call('POST', 'bridge/ack', { session_id: this.id, command_ids: ids }, this.secretHeader())
        return new Set((res.body && res.body.accepted) || [])
    }

    async report(commandId, payload) {
        return this.call('POST', 'bridge/result', { session_id: this.id, command_id: commandId, payload }, this.secretHeader())
    }

    start() {
        this.running = true
        this.aborter = new AbortController()
        this.loop = (async () => {
            while (this.running) {
                let commands
                try {
                    commands = await this.pollOnce(this.aborter.signal)
                } catch (_) {
                    break
                }
                if (!commands.length) continue
                if (!this.ack) {
                    await new Promise((r) => setTimeout(r, 100))
                    continue
                }
                const accepted = await this.acknowledge(commands.map((c) => c.id))
                for (const command of commands) {
                    if (!accepted.has(command.id)) continue
                    this.executed.push(command)
                    await this.report(command.id, await this.handler(command))
                }
            }
        })()
        return this
    }

    async stop({ unregister = true } = {}) {
        this.running = false
        if (unregister && this.session) {
            await this.call('POST', 'bridge/unregister', { session_id: this.id }, this.secretHeader()).catch(() => {})
        }
        if (this.aborter) this.aborter.abort()
        await this.loop
    }
}

async function connectClient(baseUrl, token = 'tok-alice') {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/copilot-mcp/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'copilot-mcp-test', version: '0.0.0' })
    await client.connect(transport)
    return client
}

// Raw HTTP request with full header control (fetch does not allow Host overrides).
function rawRequest(baseUrl, { method = 'POST', path: urlPath = '/api/copilot-mcp/mcp', headers = {}, body = null } = {}) {
    const url = new URL(baseUrl)
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : Buffer.from(JSON.stringify(body))
        const req = http.request(
            {
                host: url.hostname,
                port: url.port,
                method,
                path: urlPath,
                headers: {
                    accept: 'application/json, text/event-stream',
                    ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
                    ...headers,
                },
            },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8')
                    let json = null
                    try {
                        json = JSON.parse(text)
                    } catch (_) {}
                    resolve({ status: res.statusCode, headers: res.headers, json, text })
                })
            }
        )
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

module.exports = { createFakeMmgis, FakePage, connectClient, rawRequest, TOKENS, VIEWABLE }
