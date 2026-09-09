/* global globalThis */

export const AGENT_REQUEST_CANCELLED = 'AGENT_REQUEST_CANCELLED'

export function createAgentCancellationError() {
    const error = new Error('The AgentChat request was cancelled.')
    error.code = AGENT_REQUEST_CANCELLED
    return error
}

export function isAgentCancellationError(error) {
    return (
        error?.code === AGENT_REQUEST_CANCELLED || error?.name === 'AbortError'
    )
}

export function closeAgentChatThroughController(controller, fallback) {
    if (controller && typeof controller.closeTool === 'function') {
        controller.closeTool('AgentChat')
        return true
    }
    if (typeof fallback === 'function') fallback()
    return false
}

export function createAgentLifecycle({
    createAbortController = () =>
        typeof globalThis.AbortController === 'function'
            ? new globalThis.AbortController()
            : null,
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
    let disposed = false
    let generation = 0
    let activeRequest = null
    let registrySocket = null
    let registrySocketListener = null
    let registryRetryTimer = null

    function isRequestActive(id) {
        return !disposed && activeRequest?.id === id
    }

    function assertRequestActive(id) {
        if (!isRequestActive(id)) throw createAgentCancellationError()
    }

    function abortActiveRequest() {
        try {
            activeRequest?.controller?.abort()
        } catch (_) {}
        activeRequest = null
    }

    function beginRequest() {
        if (disposed) throw createAgentCancellationError()
        abortActiveRequest()
        const id = ++generation
        activeRequest = {
            id,
            controller: createAbortController(),
        }
        return {
            id,
            signal: activeRequest.controller?.signal,
        }
    }

    function requestSignal(id) {
        assertRequestActive(id)
        return activeRequest.controller?.signal
    }

    async function runRequest(id, operation) {
        assertRequestActive(id)
        const result = await operation(requestSignal(id))
        assertRequestActive(id)
        return result
    }

    function finishRequest(id) {
        if (!isRequestActive(id)) return false
        activeRequest = null
        return true
    }

    function clearRegistryRetry() {
        if (registryRetryTimer == null) return
        clearTimer(registryRetryTimer)
        registryRetryTimer = null
    }

    function detachRegistry() {
        clearRegistryRetry()
        if (
            registrySocket &&
            registrySocketListener &&
            typeof registrySocket.removeEventListener === 'function'
        ) {
            registrySocket.removeEventListener(
                'message',
                registrySocketListener
            )
        }
        registrySocket = null
        registrySocketListener = null
    }

    function attachRegistrySocket(socket, listener) {
        detachRegistry()
        if (
            disposed ||
            !socket ||
            typeof socket.addEventListener !== 'function' ||
            typeof listener !== 'function'
        ) {
            return false
        }
        registrySocket = socket
        registrySocketListener = listener
        registrySocket.addEventListener('message', registrySocketListener)
        return true
    }

    function scheduleRegistryRetry(callback, delay = 3000) {
        clearRegistryRetry()
        if (disposed || typeof callback !== 'function') return null
        registryRetryTimer = setTimer(() => {
            registryRetryTimer = null
            if (!disposed) callback()
        }, delay)
        return registryRetryTimer
    }

    function dispose() {
        if (disposed) return
        disposed = true
        abortActiveRequest()
        detachRegistry()
    }

    return {
        beginRequest,
        requestSignal,
        runRequest,
        isRequestActive,
        assertRequestActive,
        finishRequest,
        attachRegistrySocket,
        scheduleRegistryRetry,
        detachRegistry,
        dispose,
        isDisposed: () => disposed,
    }
}
