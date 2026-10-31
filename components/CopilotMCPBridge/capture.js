// Captures what a Copilot handler emits while the bridge runs it: the text it
// writes through appendLine() (window.__mmgisAgentChatAppend) and the JSON of
// the /api/agent/* and TiTiler info requests it makes. Both hooks are removed
// when the command finishes.
//
// Output is not copied into the Copilot chat (it would become persistent chat
// history) unless `mirror` is set, or the chat itself is busy executing, in
// which case lines are also forwarded so the chat never loses its own output.

const AGENT_API = /\/api\/agent(\/|\?|$)/
const TITILER_INFO = /\/titiler\/cog\/(info|info\.geojson|statistics)(\?|$)/
const MAX_BODY_CHARS = 200000

function copilotBusy() {
    return !!document.querySelector('#agentChatSend[data-loading]')
}

function relativeUrl(url) {
    try {
        const u = new URL(url, window.location.href)
        return `${u.pathname}${u.search}`
    } catch (_) {
        return String(url)
    }
}

export function startCapture({ mirror = false } = {}) {
    const lines = []
    const apiCalls = []
    const previousAppend = window.__mmgisAgentChatAppend
    const hadAppend = Object.prototype.hasOwnProperty.call(window, '__mmgisAgentChatAppend')

    const appendHook = (text) => {
        if (text == null || text === '') return
        lines.push(String(text))
        if (typeof previousAppend === 'function' && (mirror || copilotBusy())) {
            try {
                previousAppend(text)
            } catch (_) {}
        }
    }
    window.__mmgisAgentChatAppend = appendHook

    const originalFetch = window.fetch
    const fetchHook = async function (input, init) {
        const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input)
        const response = await originalFetch.apply(this, arguments)
        if (AGENT_API.test(url) || TITILER_INFO.test(url)) {
            const entry = {
                method: ((init && init.method) || (input && input.method) || 'GET').toUpperCase(),
                url: relativeUrl(url),
                status: response.status,
            }
            try {
                const text = await response.clone().text()
                entry.body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…[truncated]` : JSON.parse(text)
            } catch (_) {}
            apiCalls.push(entry)
        }
        return response
    }
    window.fetch = fetchHook

    return {
        lines,
        apiCalls,
        stop() {
            if (window.__mmgisAgentChatAppend === appendHook) {
                if (hadAppend && typeof previousAppend === 'function') window.__mmgisAgentChatAppend = previousAppend
                else delete window.__mmgisAgentChatAppend
            }
            if (window.fetch === fetchHook) window.fetch = originalFetch
        },
    }
}

// Waits (bounded) until the Copilot chat is not planning or executing, so the
// two never interleave on the same map.
export async function waitForCopilotIdle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (copilotBusy() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
    }
}
