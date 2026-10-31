// @unit tests for Copilot MCP configuration, request gating and registry schema helpers.
import { test, expect } from '@playwright/test'

const path = require('path')
const { execFileSync } = require('child_process')
const { loadConfig, ENVS } = require('../lib/config')
const { requestIsLocal, localOnly, jsonRpcGate } = require('../lib/access')
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
        expect(pluginManifest.dependencies).toEqual({}) // SDK is plugin-local (package.json), never hoisted into MMGIS
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

    test('jsonRpcGate turns MMGIS auth failures (HTTP 200 + status failure, login page) into HTTP 401 JSON-RPC errors', () => {
        const deny = (req, res) => res.send({ status: 'failure', message: 'User is not logged in.' })
        const res = fakeRes()
        jsonRpcGate(deny)(fakeReq({ body: { jsonrpc: '2.0', id: 1 } }), res, () => {
            throw new Error('must not continue')
        })
        expect(res.statusCode).toBe(401)
        expect(res.headers['www-authenticate']).toContain('Bearer')
        expect(res.body.error.message).toContain('User is not logged in.')

        const renderLogin = (req, res) => res.render('login')
        const res2 = fakeRes()
        jsonRpcGate(renderLogin)(fakeReq(), res2, () => {})
        expect(res2.statusCode).toBe(401)

        let passed = false
        const allow = (req, res, next) => next()
        const res3 = fakeRes()
        jsonRpcGate(allow)(fakeReq(), res3, () => (passed = true))
        expect(passed).toBe(true)
        expect(res3.send).not.toBe(undefined)
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
