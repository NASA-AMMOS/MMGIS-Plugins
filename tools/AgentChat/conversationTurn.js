export async function runConversationTurn({
    originalMessage,
    requestInitial,
    executeActions,
    requestContinuation,
    resolveFinalText,
    onInitialResponse = null,
    onResponse = null,
    maxRounds = 4,
} = {}) {
    if (typeof requestInitial !== 'function')
        throw new TypeError('requestInitial is required.')
    if (typeof executeActions !== 'function')
        throw new TypeError('executeActions is required.')
    if (typeof requestContinuation !== 'function')
        throw new TypeError('requestContinuation is required.')
    if (typeof resolveFinalText !== 'function')
        throw new TypeError('resolveFinalText is required.')

    let response = await requestInitial(originalMessage)
    const initialResponse = response
    let finalResponse = response
    const allResults = []
    const allActions = []
    const performed = []
    let continuationError = null
    if (typeof onInitialResponse === 'function') onInitialResponse(response)

    for (let round = 0; round < maxRounds; round += 1) {
        const actions = Array.isArray(response?.actions) ? response.actions : []
        if (!actions.length) break
        allActions.push(...actions)
        const roundResults = await executeActions(actions, response)
        const normalizedResults = Array.isArray(roundResults)
            ? roundResults
            : []
        allResults.push(...normalizedResults)
        performed.push(
            ...normalizedResults
                .filter((result) => result?.ok === true)
                .map((result) => ({
                    tool: result.tool,
                    callId: result.callId,
                    message: result.message,
                }))
        )
        try {
            response = await requestContinuation(
                response,
                normalizedResults,
                originalMessage
            )
            finalResponse = response
            if (typeof onResponse === 'function') onResponse(response)
        } catch (error) {
            continuationError = error
            response = {}
            finalResponse = {}
            break
        }
    }

    const exhausted =
        Array.isArray(response?.actions) && response.actions.length > 0
    if (exhausted) {
        allResults.push({
            tool: 'agent_continuation',
            callId: null,
            ok: false,
            message:
                'Copilot stopped after the maximum number of action rounds. The completed actions are shown above.',
            data: null,
            error: {
                code: 'MAX_TOOL_ROUNDS',
                message:
                    'Copilot stopped after the maximum number of action rounds. The completed actions are shown above.',
            },
        })
    }

    return {
        initialResponse,
        finalResponse,
        actions: allActions,
        toolResults: allResults,
        performed,
        continuationError,
        exhausted,
        finalText: resolveFinalText(finalResponse, allResults),
    }
}
