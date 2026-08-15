// Never let an assistant bubble render as silent blank space. The backend
// (provider.js: resolveReplyText) and the local intent handlers in
// AgentChatTool.js are expected to always produce a readable reply, but
// this is the last line of defense if that guarantee is ever violated by a
// future change or an unexpected provider response shape.
export const EMPTY_ASSISTANT_REPLY_MESSAGE =
    "Copilot didn't return a response for that. Please try rephrasing or try again."

export function resolveAssistantReply(rawReply, rawText) {
    const reply = (rawReply || '').trim()
    if (reply) return reply
    const text = (rawText || '').trim()
    if (text) return text
    return EMPTY_ASSISTANT_REPLY_MESSAGE
}
