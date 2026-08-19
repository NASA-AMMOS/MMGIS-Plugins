import { test, expect } from '@playwright/test'
import {
    AGENT_REQUEST_CANCELLED,
    closeAgentChatThroughController,
    createAgentLifecycle,
} from '../agentLifecycle'

function fakeSocket() {
    const listeners = new Set()
    return {
        listeners,
        addEventListener(type, listener) {
            if (type === 'message') listeners.add(listener)
        },
        removeEventListener(type, listener) {
            if (type === 'message') listeners.delete(listener)
        },
    }
}

test.describe('@unit AgentChat lifecycle', () => {
    test('routes close requests through ToolController with a legacy fallback', () => {
        const closed = []
        let fallbackCalls = 0
        expect(
            closeAgentChatThroughController(
                { closeTool: (name) => closed.push(name) },
                () => {
                    fallbackCalls += 1
                }
            )
        ).toBe(true)
        expect(closed).toEqual(['AgentChat'])
        expect(fallbackCalls).toBe(0)

        expect(
            closeAgentChatThroughController(null, () => {
                fallbackCalls += 1
            })
        ).toBe(false)
        expect(fallbackCalls).toBe(1)
    })

    test('disposal aborts the turn and removes registry listener and retry timer', () => {
        const timers = new Map()
        const socket = fakeSocket()
        let nextTimer = 1
        let retryCalls = 0
        const lifecycle = createAgentLifecycle({
            setTimer(callback) {
                const id = nextTimer++
                timers.set(id, callback)
                return id
            },
            clearTimer(id) {
                timers.delete(id)
            },
        })
        const request = lifecycle.beginRequest()
        lifecycle.attachRegistrySocket(socket, () => {})
        lifecycle.scheduleRegistryRetry(() => {
            retryCalls += 1
        })

        expect(request.signal?.aborted).toBe(false)
        expect(socket.listeners.size).toBe(1)
        expect(timers.size).toBe(1)

        lifecycle.dispose()

        expect(request.signal?.aborted).toBe(true)
        expect(socket.listeners.size).toBe(0)
        expect(timers.size).toBe(0)
        expect(retryCalls).toBe(0)
    })

    test('stale generations cannot start or complete action work', async () => {
        const lifecycle = createAgentLifecycle()
        const first = lifecycle.beginRequest()
        const second = lifecycle.beginRequest()
        let staleOperationCalls = 0

        expect(first.signal?.aborted).toBe(true)
        await expect(
            lifecycle.runRequest(first.id, async () => {
                staleOperationCalls += 1
            })
        ).rejects.toMatchObject({ code: AGENT_REQUEST_CANCELLED })
        expect(staleOperationCalls).toBe(0)

        let releaseOperation
        const inFlight = lifecycle.runRequest(
            second.id,
            () =>
                new Promise((resolve) => {
                    releaseOperation = resolve
                })
        )
        lifecycle.dispose()
        releaseOperation('late result')

        await expect(inFlight).rejects.toMatchObject({
            code: AGENT_REQUEST_CANCELLED,
        })
        await expect(
            lifecycle.runRequest(second.id, async () => 'must not run')
        ).rejects.toMatchObject({ code: AGENT_REQUEST_CANCELLED })
    })
})
