// Test harness for the Copilot MCP plugin: an Express app with stand-ins for
// MMGIS's permission API (ensurePrincipal, authorize, resolvers, can,
// missionNamesWith, registerRouter) and the Agent plugin's HTTP API, the real
// CopilotMCP routes mounted on it, simulated CopilotMCPBridge pages and MCP
// SDK clients.

const path = require('path')
const http = require('http')
const express = require('express')
const { loadConfig } = require('../../lib/config')
const { mountCopilotMcp } = require('../../lib/mount')
const { loadFileRegistry } = require('../../lib/registry')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')

// Same Ajv (version and options) as the Agent plugin's registryManager.
const Ajv = require(require.resolve('ajv', { paths: [path.join(__dirname, '..', '..', '..', 'Agent')] }))

// Long-term tokens. scopes/missions follow MMGIS: null = everything the
// creator holds; an array limits the token.
const TOKENS = {
    'tok-alice': { user: 'alice' },
    'tok-bob': { user: 'bob' },
    'tok-alice-frozon-view': { user: 'alice', scopes: ['site.view', 'mission.view'], missions: ['frozon'] },
    'tok-alice-reference-read': {
        user: 'alice',
        scopes: ['site.view', 'mission.view', 'data.geodatasets.read', 'data.datasets.read', 'data.stac.read'],
        missions: ['Reference-Mission'],
    },
}
const VIEWABLE = { alice: ['frozon', 'Reference-Mission'], bob: ['frozon'] }
const MISSIONS = ['frozon', 'Reference-Mission', 'Secret-Mission']
const READ_CAPS = ['site.view', 'mission.view', 'data.geodatasets.read', 'data.datasets.read', 'data.stac.read']

// req.principal as MMGIS resolves it: a token, a session user ("x-test-user",
// with "x-test-session" as the Express session id) or an anonymous guest.
function resolvePrincipal(req) {
    req.sessionID = req.headers['x-test-session'] || null
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    if (m) {
        const t = TOKENS[m[1]]
        if (!t) return { kind: 'invalid_token', authenticated: false }
        return { kind: 'token', authenticated: true, username: t.user, token: { scopes: t.scopes || null, missions: t.missions || null } }
    }
    const user = req.headers['x-test-user']
    if (user) return { kind: 'user', authenticated: true, username: user }
    return { kind: 'anonymous', authenticated: false, username: null }
}

// The rules of MMGIS's policy.can() that these tests rely on.
function can(principal, cap, resource) {
    if (!principal || principal.kind === 'invalid_token') return false
    if (!principal.authenticated) return cap === 'site.view'
    const token = principal.token
    if (token && Array.isArray(token.scopes) && !token.scopes.includes(cap)) return false
    const mission = resource && resource.missionName
    if (token && Array.isArray(token.missions) && mission && !token.missions.includes(mission)) return false
    if (!READ_CAPS.includes(cap)) return false
    if (cap === 'mission.view') return !!mission && (VIEWABLE[principal.username] || []).includes(mission)
    return true
}

function createPermissionApi() {
    const ensurePrincipal = (req) => Promise.resolve(req.principal || (req.principal = resolvePrincipal(req)))
    const declared = []
    const tag = (mw, access) => Object.assign(mw, { __access: access })
    function authorize(cap, resolver) {
        const mw = async (req, res, next) => {
            const principal = await ensurePrincipal(req)
            if (principal.kind === 'invalid_token') return res.status(403).send({ status: 'failure', message: 'Unauthorized Token!' })
            const resource = resolver ? await resolver(req) : undefined
            if (resource === null || !can(principal, cap, resource || null)) return res.status(403).send({ status: 'failure', message: 'Unauthorized' })
            req.access = { capability: cap, resource }
            next()
        }
        return tag(mw, { capability: cap, resolver: resolver ? resolver.description || 'custom' : '-' })
    }
    authorize.public = (reason) => tag((req, res, next) => next(), { capability: 'public', resolver: reason })
    authorize.inHandler = (cap, reason) => tag(authorize(cap), { capability: cap, resolver: `in handler: ${reason}` })
    const resolvers = {
        mission(pick) {
            const fn = async (req) => {
                const name = typeof pick === 'function' ? pick(req) : undefined
                return typeof name === 'string' && MISSIONS.includes(name) ? { mission: `uuid-${name}`, missionName: name } : null
            }
            fn.description = 'mission(fn)'
            return fn
        },
    }
    return {
        ensurePrincipal,
        authorize,
        resolvers,
        can: async (req, cap, resource) => can(await ensurePrincipal(req), cap, resource),
        missionNamesWith: async (req, cap) => {
            const principal = await ensurePrincipal(req)
            return MISSIONS.filter((name) => can(principal, cap, { mission: `uuid-${name}`, missionName: name }))
        },
        registerRouter: (prefix, router) => {
            declared.push({ prefix, router })
            return router
        },
        declared,
    }
}

// Every route of every registered router, with its declared permission.
function routeTable(declared) {
    const rows = []
    for (const { prefix, router } of declared) {
        for (const layer of router.stack || []) {
            if (!layer.route) continue
            const access = (layer.route.stack || []).map((l) => l.handle && l.handle.__access).filter(Boolean)
            rows.push({
                path: prefix + layer.route.path,
                methods: Object.keys(layer.route.methods),
                capability: access.map((a) => a.capability).join(' + ') || null,
            })
        }
    }
    return rows
}

function createFakeMmgis(cfgOverrides = {}) {
    const app = express()
    app.use(express.json({ limit: '5mb' }))
    const permissions = createPermissionApi()
    const s = {
        app,
        ROOT_PATH: '',
        ...permissions,
        checkHeadersCodeInjection: (req, res, next) => next(),
        setContentType: (req, res, next) => next(),
    }
    // Stand-in for the signed-in gate in front of the Agent plugin's /api/agent routes.
    const signedIn = async (req, res, next) => {
        const principal = await permissions.ensurePrincipal(req)
        if (!principal.authenticated) return res.send({ status: 'failure', message: 'User is not logged in.' })
        req.user = principal.username
        next()
    }

    const registry = loadFileRegistry()
    const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true, useDefaults: true })
    const validators = {}
    for (const t of registry.tools) validators[t.name] = ajv.compile(t.parameters || { type: 'object' })
    app.locals.agentToolRegistry = { tools: registry.tools }
    app.locals.agentAjv = ajv
    app.locals.agentToolValidators = validators

    const upstream = { plannerRequests: [], requests: [] }
    const gate = [signedIn]
    app.use((req, _res, next) => {
        upstream.requests.push({ method: req.method, url: req.originalUrl, authorization: req.headers.authorization || null })
        next()
    })
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
        routes: () => routeTable(permissions.declared),
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
    // A logged-in MMGIS page: an Express session of `user`.
    constructor(baseUrl, { user = 'alice', mission = 'frozon', httpSession = null, handler = null, ack = true } = {}) {
        Object.assign(this, { baseUrl, user, mission, httpSession: httpSession || `http-${user}`, ack })
        this.handler = handler || defaultHandler(this)
        this.executed = []
        this.received = []
        this.running = false
        this.session = null
        this.aborter = null
    }

    headers(extra = {}) {
        return { 'x-test-user': this.user, 'x-test-session': this.httpSession, 'Content-Type': 'application/json', ...extra }
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
