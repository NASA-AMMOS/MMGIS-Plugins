/* Local fast-path commands of the MMGIS Copilot (no planner call): MMGIS
   overview, preset region zoom and time-slider changes. Shared by the
   AgentChat tool and the CopilotMCPBridge component. */

import { fast_visible_layers_time as fastVisibleLayersTime } from './renderers'
import {
    detectMmgisOverviewIntent,
    handleMmgisOverviewIntent,
    detectZoomRegionIntent,
    handleZoomRegionIntent,
    detectFastTimeIntent,
} from './agentActions'

export async function tryLocalCopilotCommand(message) {
    const overview = detectMmgisOverviewIntent(message)
    if (overview) return handleMmgisOverviewIntent()

    const zoomIntent = detectZoomRegionIntent(message)
    if (zoomIntent) {
        const handled = handleZoomRegionIntent(zoomIntent)
        if (handled) return handled
    }

    const intent = detectFastTimeIntent(message)
    if (!intent) return null
    try {
        const payload = { time_query: intent.query }
        if (intent.special) payload.special = intent.special
        const result = await fastVisibleLayersTime(payload)
        const reply =
            result?.lines?.length && Array.isArray(result.lines)
                ? result.lines.join('\n')
                : 'Time updated.'
        return { reply }
    } catch (err) {
        return {
            reply:
                err?.message ||
                'Unable to process that time command locally. Please try again.',
        }
    }
}
