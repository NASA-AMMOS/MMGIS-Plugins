// CopilotMCPBridge — connects this MMGIS page to the CopilotMCP backend plugin
// so MCP clients can run the Copilot's tools in this browser session.
//
// Dormant unless the backend reports MCP enabled (WITH_COPILOT_MCP=true) and
// the user is logged in. The session is bound to this login and mission; a
// small indicator shows the connection and lets the user pause it.

import L_ from '@basics/Layers_/Layers_'
import { executeCommand } from './executor'
import './CopilotMCPBridge.css'

const VERSION = '0.1.0'
const SECRET_HEADER = 'X-Copilot-MCP-Secret'
const INDICATOR_ID = 'mmgisCopilotMcpIndicator'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function apiUrl(path) {
    const root = window.mmgisglobal && window.mmgisglobal.ROOT_PATH ? `${window.mmgisglobal.ROOT_PATH}/` : ''
    return `${root}api/copilot-mcp/${path}`
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options })
    let body = null
    try {
        body = await res.json()
    } catch (_) {
        body = null
    }
    return { status: res.status, body }
}

function currentMission() {
    if (L_ && typeof L_.mission === 'string' && L_.mission) return L_.mission
    try {
        return new URLSearchParams(window.location.search).get('mission')
    } catch (_) {
        return null
    }
}

const bridge = {
    config: null,
    session: null,
    running: false,
    paused: false,
    state: 'idle',
    detail: '',
    loopId: 0,

    publish() {
        window.mmgisCopilotMCPBridge = {
            version: VERSION,
            state: this.state,
            detail: this.detail,
            sessionId: this.session ? this.session.id : null,
            mission: this.session ? this.session.mission : null,
            user: this.session ? this.session.user : null,
        }
        if (this.config && this.config.showIndicator) this.renderIndicator()
    },

    setState(state, detail = '') {
        this.state = state
        this.detail = detail
        this.publish()
    },

    renderIndicator() {
        let el = document.getElementById(INDICATOR_ID)
        if (!el) {
            el = document.createElement('button')
            el.id = INDICATOR_ID
            el.type = 'button'
            el.setAttribute('aria-live', 'polite')
            el.addEventListener('click', () => this.togglePause())
            document.body.appendChild(el)
        }
        const labels = {
            idle: 'MCP',
            connecting: 'MCP · connecting',
            connected: 'MCP · connected',
            busy: `MCP · running ${this.detail}`,
            paused: 'MCP · paused',
            error: 'MCP · reconnecting',
        }
        el.className = `mmgis-copilot-mcp-indicator is-${this.state}`
        el.textContent = labels[this.state] || 'MCP'
        el.title = this.session
            ? `Copilot MCP bridge — session ${this.session.id}, mission ${this.session.mission}, user ${this.session.user}. Click to ${this.paused ? 'resume' : 'pause'} MCP control of this map.`
            : `Copilot MCP bridge — click to ${this.paused ? 'resume' : 'pause'}.`
        el.setAttribute('aria-pressed', this.paused ? 'true' : 'false')
    },

    async start(config) {
        this.config = config
        const status = await fetchJson(apiUrl('status')).catch(() => null)
        if (!status || !status.body || status.body.enabled !== true) return // MCP disabled: stay dormant
        this.publish()
        if (!status.body.loggedIn) {
            this.setState('idle', 'waiting for login')
            this.waitForLogin()
            return
        }
        if (!config.autoConnect) {
            this.paused = true
            this.setState('paused')
            return
        }
        this.connect()
    },

    waitForLogin() {
        const retry = async () => {
            const status = await fetchJson(apiUrl('status')).catch(() => null)
            if (status && status.body && status.body.loggedIn) {
                document.removeEventListener('mmgis:loginchange', retry)
                clearInterval(timer)
                if (this.config.autoConnect && !this.paused) this.connect()
                else this.setState('paused')
            }
        }
        const timer = setInterval(retry, 15000)
        document.addEventListener('mmgis:loginchange', retry)
    },

    async register() {
        const mission = currentMission()
        if (!mission) throw new Error('No mission is loaded.')
        const res = await fetchJson(apiUrl('bridge/register'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mission,
                page: { title: document.title, href: window.location.href },
                client: { version: VERSION },
            }),
        })
        if (!res.body || res.body.status !== 'success' || !res.body.session) {
            throw new Error((res.body && res.body.message) || `Registration failed (HTTP ${res.status}).`)
        }
        this.session = res.body.session
    },

    async connect() {
        if (this.running) return
        this.running = true
        this.paused = false
        const loopId = ++this.loopId
        let backoff = 1000
        this.setState('connecting')
        while (this.running && loopId === this.loopId) {
            try {
                if (!this.session) await this.register()
                this.setState('connected')
                const res = await fetchJson(apiUrl(`bridge/poll?session_id=${encodeURIComponent(this.session.id)}`), {
                    headers: { [SECRET_HEADER]: this.session.secret },
                })
                if (!this.running || loopId !== this.loopId) break
                if (res.status === 401 || res.status === 403 || res.status === 404) {
                    this.session = null // expired or login changed: register again
                    continue
                }
                if (!res.body || res.body.status !== 'success') throw new Error((res.body && res.body.message) || `Poll failed (HTTP ${res.status}).`)
                backoff = 1000
                const commands = Array.isArray(res.body.commands) ? res.body.commands : []
                if (!commands.length) continue
                // Run only what the server confirms; it may have withdrawn a command.
                const accepted = await this.acknowledge(commands.map((c) => c.id))
                for (const command of commands) {
                    if (!accepted.has(command.id)) continue
                    this.setState('busy', command.tool || command.kind)
                    const result = await executeCommand(command, this.config)
                    await this.postResult(command.id, result)
                }
            } catch (err) {
                if (!this.running || loopId !== this.loopId) break
                this.setState('error', err && err.message)
                await sleep(backoff)
                backoff = Math.min(backoff * 2, 15000)
            }
        }
    },

    async acknowledge(commandIds) {
        const res = await fetchJson(apiUrl('bridge/ack'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: this.session.secret },
            body: JSON.stringify({ session_id: this.session.id, command_ids: commandIds }),
        })
        if (!res.body || res.body.status !== 'success') throw new Error((res.body && res.body.message) || `Acknowledge failed (HTTP ${res.status}).`)
        return new Set(Array.isArray(res.body.accepted) ? res.body.accepted : [])
    },

    async postResult(commandId, result) {
        if (!this.session) return
        await fetchJson(apiUrl('bridge/result'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: this.session.secret },
            body: JSON.stringify({ session_id: this.session.id, command_id: commandId, payload: result }),
        }).catch(() => null)
    },

    disconnect(keepalive = false) {
        this.running = false
        this.loopId++
        const session = this.session
        this.session = null
        if (!session) return
        fetch(apiUrl('bridge/unregister'), {
            method: 'POST',
            credentials: 'same-origin',
            keepalive,
            headers: { 'Content-Type': 'application/json', [SECRET_HEADER]: session.secret },
            body: JSON.stringify({ session_id: session.id }),
        }).catch(() => null)
    },

    togglePause() {
        if (this.paused) {
            this.connect()
        } else {
            this.paused = true
            this.disconnect()
            this.setState('paused')
        }
    },
}

const CopilotMCPBridge = {
    init(vars = {}) {
        const config = {
            autoConnect: vars.autoConnect !== false,
            showIndicator: vars.showIndicator !== false,
            mirrorToCopilotPanel: vars.mirrorToCopilotPanel === true,
        }
        window.addEventListener('pagehide', () => bridge.disconnect(true))
        bridge.start(config)
    },
}

export default CopilotMCPBridge
