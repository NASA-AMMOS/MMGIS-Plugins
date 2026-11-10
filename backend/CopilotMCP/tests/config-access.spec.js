// @unit tests for Copilot MCP configuration, request gating and registry schema helpers.
import { test, expect } from '@playwright/test'

const path = require('path')
const { execFileSync } = require('child_process')
const { loadConfig, ENVS } = require('../lib/config')
const { requestIsLocal, localOnly, requireSignedIn } = require('../lib/access')
const { withRoutingProperties, splitRouting, loadFileRegistry } = require('../lib/registry')
const pluginManifest = require('../plugin.json')

const PLUGIN_DIR = path.join(__dirname, '..')

function fakeReq({ remote = '127.0.0.1', headers = {}, body = undefined } = {}) {
    return { socket: { remoteAddress: remote }, headers, body }
}

function fakeRes() {
    const res = { statusCode: 200, headers: {}, body: undefined }
    res.status = (code) => {
        res.statusCode = code
        return res
    }
    res.set = (k, v) => {
        res.headers[k.toLowerCase()] = v
        return res
    }
    res.json = (body) => {
        res.body = body
        return res
    }
    res.send = res.json
    res.render = () => res
    res.end = () => res
    return res
}

test.describe('Copilot MCP configuration @unit', () => {
    test('MCP support is disabled and local-only by default', () => {
        const cfg = loadConfig({})
        expect(cfg.enabled).toBe(false)
        expect(cfg.allowRemote).toBe(false)
        expect(cfg.basePath).toBe('/api/copilot-mcp')
        expect(loadConfig({ WITH_COPILOT_MCP: 'TRUE' }).enabled).toBe(true)
        expect(loadConfig({ WITH_COPILOT_MCP: 'yes' }).enabled).toBe(false)
    })

    test('numeric settings are clamped to safe ranges', () => {
        const cfg = loadConfig({
            COPILOT_MCP_POLL_TIMEOUT_MS: '999999',
            COPILOT_MCP_DELIVERY_TIMEOUT_MS: '1',
            COPILOT_MCP_LIVENESS_GRACE_MS: 'abc',
            COPILOT_MCP_MAX_SESSIONS_PER_USER: '0',
            ROOT_PATH: '/mmgis/',
            PORT: '8890',
        })
        expect(cfg.pollTimeoutMs).toBe(55000)
        expect(cfg.deliveryTimeoutMs).toBe(1000)
        expect(cfg.livenessGraceMs).toBe(20000)
        expect(cfg.maxSessionsPerUser).toBe(1)
        expect(cfg.rootPath).toBe('/mmgis')
        expect(cfg.port).toBe(8890)
    })

    test('every environment variable is documented in plugin.json', () => {
        expect(Object.keys(pluginManifest.envs).sort()).toEqual(ENVS.map((e) => e.name).sort())
    })

    test('plugin.json declares the MCP SDK and the plugins it depends on', () => {
        expect(pluginManifest.dependencies).toEqual({ npm: { '@modelcontextprotocol/sdk': '1.32.2' } })
        expect(pluginManifest.pluginDependencies).toEqual(['NASA-AMMOS--MMGIS-Plugins/backend/Agent'])
        const bridge = require('../../../components/CopilotMCPBridge/plugin.json')
        expect(bridge.display_name).toBe('MMGIS MCP Bridge')
        expect(bridge.displayName).toBeUndefined()
        expect(bridge.pluginDependencies).toEqual(['NASA-AMMOS--MMGIS-Plugins/backend/CopilotMCP', 'NASA-AMMOS--MMGIS-Plugins/tools/AgentChat'])
    })

    test('the plugin mounts nothing and loads no MCP SDK unless WITH_COPILOT_MCP=true', () => {
        const probe = (value) =>
            JSON.parse(
                execFileSync(
                    process.execPath,
                    ['-e', `const p=require('./plugin.js');console.log(JSON.stringify({keys:Object.keys(p).sort(),sdk:Object.keys(require.cache).some((k)=>k.includes('@modelcontextprotocol'))}))`],
                    { cwd: PLUGIN_DIR, env: { ...process.env, WITH_COPILOT_MCP: value }, encoding: 'utf8' }
                )
                    .trim()
                    .split('\n')
                    .pop()
            )
        expect(probe('')).toEqual({ keys: ['envs'], sdk: false })
        expect(probe('false')).toEqual({ keys: ['envs'], sdk: false })
        expect(probe('true')).toEqual({ keys: ['envs', 'onceInit', 'onceStarted'], sdk: false })
    })
})

test.describe('Copilot MCP request gating @unit', () => {
    test('requestIsLocal accepts loopback only and rejects forwarded or rebound requests', () => {
        expect(requestIsLocal(fakeReq({ headers: { host: 'localhost:8888' } }))).toBe(true)
        expect(requestIsLocal(fakeReq({ remote: '::ffff:127.0.0.1', headers: { host: '127.0.0.1:8888' } }))).toBe(true)
        expect(requestIsLocal(fakeReq({ remote: '::1', headers: { host: '[::1]:8888' } }))).toBe(true)
        expect(requestIsLocal(fakeReq({ remote: '10.1.2.3', headers: { host: 'localhost' } }))).toBe(false)
        expect(requestIsLocal(fakeReq({ headers: { host: 'localhost', 'x-forwarded-for': '203.0.113.9' } }))).toBe(false)
        expect(requestIsLocal(fakeReq({ headers: { host: 'evil.example' } }))).toBe(false) // DNS rebinding
        expect(requestIsLocal(fakeReq({ headers: { host: 'localhost', origin: 'https://evil.example' } }))).toBe(false)
        expect(requestIsLocal(fakeReq({ headers: { host: 'localhost', origin: 'http://localhost:8889' } }))).toBe(true)
    })

    test('localOnly answers remote MCP requests with a JSON-RPC 403 unless remote access is enabled', () => {
        const req = fakeReq({ remote: '192.168.1.5', headers: { host: 'mmgis.local' }, body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } })
        const res = fakeRes()
        let nextCalled = false
        localOnly({ allowRemote: false }, { jsonRpc: true })(req, res, () => (nextCalled = true))
        expect(nextCalled).toBe(false)
        expect(res.statusCode).toBe(403)
        expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32001 } })
        localOnly({ allowRemote: true }, { jsonRpc: true })(req, fakeRes(), () => (nextCalled = true))
        expect(nextCalled).toBe(true)
    })

    test('requireSignedIn answers guests and invalid tokens with HTTP 401 (a JSON-RPC error on the MCP endpoint)', async () => {
        const sFor = (principal) => ({ ensurePrincipal: async (req) => (req.principal = principal) })
        const run = (principal, opts) =>
            new Promise((resolve) => {
                const res = fakeRes()
                const origJson = res.json
                res.json = (body) => {
                    origJson(body)
                    resolve({ res, passed: false })
                    return res
                }
                requireSignedIn(sFor(principal), opts)(fakeReq({ body: { jsonrpc: '2.0', id: 1 } }), res, () => resolve({ res, passed: true }))
            })

        const guest = await run({ kind: 'anonymous', authenticated: false }, { jsonRpc: true })
        expect(guest.passed).toBe(false)
        expect(guest.res.statusCode).toBe(401)
        expect(guest.res.headers['www-authenticate']).toContain('Bearer')
        expect(guest.res.body).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32001 } })

        const invalid = await run({ kind: 'invalid_token', authenticated: false }, { jsonRpc: true })
        expect(invalid.res.statusCode).toBe(401)
        expect(invalid.res.headers['www-authenticate']).toContain('invalid_token')

        const plain = await run({ kind: 'anonymous', authenticated: false })
        expect(plain.res.body).toMatchObject({ status: 'failure' })

        expect((await run({ kind: 'token', authenticated: true, username: 'alice' })).passed).toBe(true)
        expect((await run({ kind: 'user', authenticated: true, username: 'alice' })).passed).toBe(true)
    })
})

test.describe('Copilot registry schema helpers @unit', () => {
    test('every registry tool advertises optional mission/session_id routing, including oneOf branches', () => {
        const tools = loadFileRegistry().tools
        expect(tools.length).toBe(23)
        for (const tool of tools) {
            const schema = withRoutingProperties(tool.parameters)
            expect(schema.properties.session_id).toBeTruthy()
            expect(schema.properties.mission).toBeTruthy()
            expect(schema.required || []).not.toContain('session_id')
            for (const branch of schema.oneOf || []) {
                expect(branch.properties.session_id).toBeTruthy()
            }
            // The registry schema itself is not modified.
            expect((tool.parameters.properties || {}).session_id).toBeUndefined()
        }
    })

    test('splitRouting separates routing fields from the Copilot tool arguments', () => {
        expect(splitRouting({ name: 'A', visible: true, mission: ' frozon ', session_id: 'abc' })).toEqual({
            routing: { mission: 'frozon', sessionId: 'abc' },
            toolArgs: { name: 'A', visible: true },
        })
        expect(splitRouting({ name: 'A', mission: '' })).toEqual({ routing: { mission: null, sessionId: null }, toolArgs: { name: 'A' } })
    })
})
