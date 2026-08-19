/* MMGIS Copilot - Floating Chat Tool (plain HTML)
   - Resizable, draggable, closable overlay that never blocks MMGIS UI.
   - No external UI libraries or asset loading.
   - Citations and trace use <details> only.
   - Same backend contract (/api/agent, /api/agent/tools).
*/

import L_ from '@basics/Layers_/Layers_'
import TimeControl from '@basics/TimeControl_/TimeControl'
import * as d3 from 'd3'
import RENDERERS from './renderers'
import { getLayerTimeMetadata, formatLayerTimeAnnouncement } from './timeUtils'
import { normalizeLayerText } from './layerResolver'
import {
    finalizePreparedAction,
    prepareActionLayerArguments,
} from './actionArgumentPolicy'
import { safeCitationUrl } from './safeUrl'
import { runConversationTurn } from './conversationTurn'
import { scopedAgentStorageKey, discardUnscopedAgentState } from './storageKeys'
import { getCurrentMission } from './rendererUtils'
import {
    getConfiguredDemoQueries,
    getCopilotSuggestionPool as buildSuggestionPool,
    buildContextualSuggestions,
    getSuggestionChipRange,
    sanitizeDemoQueries,
} from './suggestions'
import {
    assessLayerAnalysisCompatibility,
    buildAnalysisCatalog,
} from './analysisCompatibility'
import {
    buildAgentApiUrl,
    normalizeAgentResponse,
    createToolResult,
    normalizeRendererResult,
    resolveFinalAssistantText,
    userFacingAgentError,
    sanitizeErrorMessage,
    sanitizeToolData,
    buildAgentHistory,
} from './agentProtocol'
import {
    listRegisteredCopilotActions,
    executeRegisteredCopilotAction,
    isSafeMmgisApiMethod,
    mergeToolRegistries,
    toRuntimeCapabilityDescriptor,
    verifyMmgisFacadeResult,
} from './runtimeActions'
import './AgentChatTool.css'

function agentApiUrl(path = '') {
    return buildAgentApiUrl({
        configuredBase: AgentChatTool.agentApiBase,
        rootPath: window.mmgisglobal?.ROOT_PATH || '',
        path,
        mission: getCurrentMission(),
    })
}
const HISTORY_KEY = 'mmgis.agent.chat.history.v1'
const CONVERSATION_ID_KEY = 'mmgis.agent.chat.conversationId'
const TRACE_PREF_KEY = 'mmgis.agent.chat.showDebug'
const DEMO_INDEX_KEY = 'mmgis_copilot_demo_index'
const OVERLAY_ID = 'mmgis-agentchat-overlay'
const PANEL_ID = 'mmgis-agentchat-panel'
const TOPBAR_LAUNCHER_ID = 'mmgisCopilotTopbarButton'
const TOPBAR_WRAPPER_ID = 'mmgisCopilotTopbarWrapper'
const DEFAULT_DEMO_QUERIES = getConfiguredDemoQueries()
const COPILOT_SUGGESTION_CHIP_RANGE = getSuggestionChipRange()
const MAX_TOOL_ROUNDS = 4

// IMPORTANT: declare before any reference (avoid TDZ)

const AgentChatTool = {
    height: 0,
    width: 'full',
    MMGISInterface: null,
    made: false,
    displayOnStart: false,
    agentApiBase: '',
    initialize: function () {
        // Read by core's ToolController_ displayOnStart loop, which auto-opens
        // separated tools (including "custom") when this is true.
        const vars = L_.getToolVars('agentchat')
        this.displayOnStart = vars != null && vars.displayOnStart === true
        this.agentApiBase =
            typeof vars?.agentApiUrl === 'string' ? vars.agentApiUrl.trim() : ''
        hideToolbarButtons()
        ensureTopbarLauncher()
    },
    make() {
        this.MMGISInterface = new interfaceWithMMGIS()
        this.made = true
        hideToolbarButtons()
        ensureTopbarLauncher()
    },
    destroy() {
        if (this.MMGISInterface) this.MMGISInterface.separateFromMMGIS()
        this.made = false
        // Remove active class from the button when closing from inside the tool
        try {
            const btn = document.querySelector('#toolButtonSeparated_AgentChat')
            if (btn) btn.classList.remove('active')
        } catch (_) {}
    },
    getUrlString() {
        return ''
    },
}

function interfaceWithMMGIS() {
    this.separateFromMMGIS = function () {
        cleanup()
    }

    // Keep #tools minimized so we don’t fight its panel.
    try {
        d3.select('#tools').selectAll('*').remove()
        if (window.ToolController_) {
            window.ToolController_.setToolHeight(0)
            window.ToolController_.setToolWidth('full')
            const ui = window.ToolController_.UserInterface
            if (ui && typeof ui.closeToolPanel === 'function')
                ui.closeToolPanel()
        }
    } catch (_) {}

    const state = {
        toolRegistry: null,
        staticToolRegistry: null,
        runtimeActions: [],
        history: loadHistory(),
        transcriptEl: null,
        inputEl: null,
        sendBtn: null,
        minimized: false,
        keyHandlersAttached: false,
        lastFocusedEl: null,
        layerIndex: [],
        showDebugTraces: loadTracePreference(),
        isThinking: false,
        requestCounter: 0,
        activeRequestId: null,
        welcomeSuggestions: null,
        currentPlaceholder: null,
        lastInputHadText: false,
        layerVisibilityListener: null,
        demoQueries: DEFAULT_DEMO_QUERIES.slice(),
        demoIndex: loadDemoIndex(DEFAULT_DEMO_QUERIES.length),
        lastUserQuery: '',
        conversationId: loadConversationId(),
        storageMission: getCurrentMission() || '',
    }
    discardUnscopedAgentState(localStorage, [HISTORY_KEY, CONVERSATION_ID_KEY])

    function getCopilotSuggestionPool() {
        refreshLayerIndex()
        return buildSuggestionPool(state.layerIndex, {
            onState: L_?.layers?.on || null,
            tools: state.toolRegistry?.tools || [],
        })
    }
    window.mmgisAgentChat = window.mmgisAgentChat || {}
    window.mmgisAgentChat.getAgentApiUrl = agentApiUrl
    window.mmgisAgentChat.getToolRegistry = () => state.toolRegistry
    window.mmgisAgentChat.logLocalAnalytics = function (message) {
        const text = String(message)
        if (state.showDebugTraces) {
            console.info('[AgentChat][LocalAnalytics]', text)
        } else {
            console.debug('[AgentChat][LocalAnalytics]', text)
        }
    }
    const undoStack = []

    window.mmgisAgentChatSetDebug = function (enabled) {
        state.showDebugTraces = !!enabled
        try {
            localStorage.setItem(
                TRACE_PREF_KEY,
                state.showDebugTraces ? 'true' : 'false'
            )
        } catch (_) {}
        renderMessages()
    }

    function normalizeName(value) {
        return normalizeLayerText(value)
    }

    function toNumber(value) {
        const n = Number(value)
        return Number.isFinite(n) ? n : null
    }

    function latLngBoundsToBbox(bounds) {
        if (!bounds) return null
        const sw =
            typeof bounds.getSouthWest === 'function'
                ? bounds.getSouthWest()
                : bounds._southWest
        const ne =
            typeof bounds.getNorthEast === 'function'
                ? bounds.getNorthEast()
                : bounds._northEast
        if (!sw || !ne) return null
        const west = toNumber(sw.lng)
        const south = toNumber(sw.lat)
        const east = toNumber(ne.lng)
        const north = toNumber(ne.lat)
        if ([west, south, east, north].every((v) => v != null))
            return [west, south, east, north]
        return null
    }

    function normalizeBoundingBox(raw) {
        if (!raw) return null
        if (Array.isArray(raw) && raw.length >= 4) {
            const west = toNumber(raw[0])
            const south = toNumber(raw[1])
            const east = toNumber(raw[2])
            const north = toNumber(raw[3])
            if ([west, south, east, north].every((v) => v != null))
                return [west, south, east, north]
            return null
        }
        if (typeof raw === 'object') {
            if (raw._southWest && raw._northEast) {
                return latLngBoundsToBbox(raw)
            }
            const west =
                toNumber(raw.west) ??
                toNumber(raw.minLon) ??
                toNumber(raw.minX) ??
                toNumber(raw.xmin)
            const south =
                toNumber(raw.south) ??
                toNumber(raw.minLat) ??
                toNumber(raw.minY) ??
                toNumber(raw.ymin)
            const east =
                toNumber(raw.east) ??
                toNumber(raw.maxLon) ??
                toNumber(raw.maxX) ??
                toNumber(raw.xmax)
            const north =
                toNumber(raw.north) ??
                toNumber(raw.maxLat) ??
                toNumber(raw.maxY) ??
                toNumber(raw.ymax)
            if ([west, south, east, north].every((v) => v != null))
                return [west, south, east, north]
        }
        return null
    }

    function deriveLayerBoundingBox(layerConfig, layerInstance) {
        let bbox =
            normalizeBoundingBox(layerConfig?.boundingBox) ||
            normalizeBoundingBox(layerConfig?.bounds) ||
            normalizeBoundingBox(layerConfig?.extent) ||
            normalizeBoundingBox(layerConfig?.bbox)
        if (!bbox && layerInstance) {
            if (typeof layerInstance.getBounds === 'function') {
                bbox = normalizeBoundingBox(layerInstance.getBounds())
            } else if (layerInstance.bounds) {
                bbox = normalizeBoundingBox(layerInstance.bounds)
            } else if (layerInstance.options?.bounds) {
                bbox = normalizeBoundingBox(layerInstance.options.bounds)
            }
        }
        return bbox
    }

    function deriveLayerGroupPath(layerConfig) {
        const cfg = layerConfig || {}
        if (typeof cfg.groupPath === 'string' && cfg.groupPath.trim()) {
            return cfg.groupPath.trim()
        }
        if (Array.isArray(cfg.groupPath)) {
            return cfg.groupPath
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .join(' > ')
        }
        if (Array.isArray(cfg.path)) {
            return cfg.path
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .join(' > ')
        }
        if (typeof cfg.path === 'string' && cfg.path.trim()) {
            return cfg.path.trim()
        }
        if (Array.isArray(cfg.group)) {
            return cfg.group
                .map((value) => String(value || '').trim())
                .filter(Boolean)
                .join(' > ')
        }
        if (typeof cfg.group === 'string' && cfg.group.trim()) {
            return cfg.group.trim()
        }
        return ''
    }

    function buildLayerIndex() {
        try {
            const api = window.mmgisAPI
            if (!api) return []
            const configs = api.getLayerConfigs?.() || {}
            const visibles = api.getVisibleLayers?.() || {}
            const layerOn = L_?.layers?.on || {}
            const liveLayers = api.getLayers?.() || {}
            const items = []
            const seen = new Set()

            Object.keys(configs).forEach((key) => {
                const layer = configs[key] || {}
                if (String(layer.type || '').toLowerCase() === 'header') return
                const uuid = String(layer.uuid || key || layer.name || '')
                if (!uuid || seen.has(uuid)) return
                seen.add(uuid)
                const liveInstance =
                    liveLayers[uuid] ||
                    liveLayers[layer.name] ||
                    liveLayers[layer.display_name] ||
                    null
                const display =
                    layer.display_name ||
                    layer.displayName ||
                    layer.title ||
                    layer.name ||
                    uuid
                const canonical = layer.name || display
                const bbox = deriveLayerBoundingBox(layer, liveInstance)
                const groupPath = deriveLayerGroupPath(layer)
                const aliases = new Set()
                ;[
                    display,
                    canonical,
                    layer.title,
                    layer.display_name,
                    layer.displayName,
                    layer.shortName,
                ].forEach((alias) => {
                    if (typeof alias === 'string' && alias.trim())
                        aliases.add(alias.trim())
                })
                if (Array.isArray(layer.aliases || layer.alias)) {
                    ;(layer.aliases || layer.alias).forEach((alias) => {
                        if (typeof alias === 'string' && alias.trim())
                            aliases.add(alias.trim())
                    })
                } else if (typeof layer.alias === 'string') {
                    layer.alias
                        .split(/[,;]+/)
                        .map((a) => a.trim())
                        .filter(Boolean)
                        .forEach((a) => aliases.add(a))
                }
                const normalizedAliases = Array.from(aliases).map((raw) => ({
                    raw,
                    normalized: normalizeName(raw),
                }))
                const isVisible = !!(
                    layerOn[uuid] ||
                    (layer.name && layerOn[layer.name]) ||
                    visibles[uuid] ||
                    visibles[key] ||
                    (layer.name && visibles[layer.name])
                )
                const timeMeta = getLayerTimeMetadata(layer)
                items.push({
                    id: uuid,
                    displayName: display,
                    canonical,
                    visible: isVisible,
                    bbox,
                    normalizedAliases,
                    aliases: Array.from(aliases),
                    groupPath,
                    tags: Array.isArray(layer.tags) ? layer.tags : [],
                    datasetId:
                        layer.datasetId || layer.dataset || layer.id || null,
                    config: layer,
                    liveInstance,
                    timeMeta,
                })
            })
            return items
        } catch (_) {
            return []
        }
    }

    function refreshLayerIndex() {
        state.layerIndex = buildLayerIndex()
    }

    function resolveActionLayerArgs(action, spec, userQuery = '') {
        const resolution = prepareActionLayerArguments({
            action,
            spec,
            layers: state.layerIndex,
            userQuery,
        })
        if (resolution.error) return resolution
        const matches = resolution.matches
        if (state.showDebugTraces && matches.length) {
            console.info('[AgentChat][layer_resolve]', {
                query: userQuery || state.lastUserQuery || '',
                matches: matches.map((match) => ({
                    key: match.key,
                    requested: match.requested,
                    resolved: match.resolved,
                    layerId: match.uuid,
                    groupPath: match.groupPath || '',
                })),
            })
        }

        return finalizePreparedAction(action, resolution)
    }

    // Initialize UI only (no external assets/styles)
    initUI()
    state.layerVisibilityListener = (event) =>
        handleLayerVisibilityChange(event)
    document.addEventListener(
        'layerVisibilityChange',
        state.layerVisibilityListener
    )

    function initUI() {
        removeExistingOverlay()

        // Overlay doesn’t intercept input outside the panel.
        const overlay = document.createElement('div')
        overlay.id = OVERLAY_ID
        overlay.style.position = 'fixed'
        overlay.style.zIndex = '2000'
        overlay.style.pointerEvents = 'none'
        const startW = 450
        const startH = 580
        const topPad = 48
        const rightPad = 40
        overlay.style.left = `${Math.max(
            8,
            window.innerWidth - startW - rightPad
        )}px`
        overlay.style.top = `${Math.max(8, topPad)}px`
        overlay.style.width = `${startW}px`
        overlay.style.height = `${startH}px`
        overlay.setAttribute('data-agentchat-root', 'true')

        state.lastFocusedEl = document.activeElement || null

        overlay.innerHTML = renderOverlayInner()
        document.body.appendChild(overlay)

        const panel = document.getElementById(PANEL_ID)
        state.transcriptEl = panel.querySelector('#agentChatTranscript')
        state.suggestionsEl = panel.querySelector('#agentChatSuggestions')
        state.inputEl = panel.querySelector('#agentChatInput')
        state.sendBtn = panel.querySelector('#agentChatSend')
        state.transcriptEl?.addEventListener('click', onTranscriptClick)
        state.suggestionsEl?.addEventListener('click', onSuggestionClick)

        wireHeaderControls(panel)
        wireComposer(panel)
        wireInputPlaceholderBehavior()
        loadDemoQueries()
        listenForToolRegistryChanges()

        renderMessages()
        // Runtime actions can be registered after the panel module loads. The
        // first welcome render must not permanently cache suggestions that
        // were built before those capabilities were discoverable.
        ensureRegistry({ refreshRuntime: true })
            .then(() => {
                state.welcomeSuggestions = null
                state.contextualSuggestions = null
                state.contextualSuggestionsAt = null
                renderMessages()
            })
            .catch((error) =>
                console.error(
                    'AgentChat initial capability discovery failed',
                    error
                )
            )
        scrollTranscript()
        initDragAndResize(overlay, panel)
        attachGlobalKeys()

        setTimeout(() => state.inputEl?.focus(), 0)
    }

    function renderOverlayInner() {
        return `
      <div
        id="${PANEL_ID}"
        class="ac-panel"
        role="dialog"
        aria-modal="false"
        aria-labelledby="agentchat-title"
      >
        <header class="ac-header">
          <div class="ac-header-left">
            <div class="ac-avatar"><i class="mdi mdi-robot-outline mdi-18px"></i></div>
            <div class="ac-title-wrap">
              <div id="agentchat-title" class="ac-title">MMGIS Copilot</div>
              <div class="ac-subtitle">Ask questions, control layers, explore docs.</div>
            </div>
          </div>
          <div class="ac-header-actions">
            <button
              id="agentChatDemoPlay"
              type="button"
              class="ac-icon-btn"
              title="Run demo query"
              aria-label="Run demo query"
            >
              <span class="ac-play-glyph" aria-hidden="true">►</span>
            </button>
            <button
              id="agentChatClear"
              type="button"
              class="ac-icon-btn"
              title="Delete conversation history"
              aria-label="Delete conversation history"
            >
              <i class="mdi mdi-trash-can-outline mdi-18px"></i>
            </button>
            <button id="agentChatMin" class="ac-icon-btn" title="Minimize" aria-label="Minimize">
              <i class="mdi mdi-window-minimize mdi-18px"></i>
            </button>
            <button id="agentChatClose" class="ac-icon-btn" title="Close" aria-label="Close">
              <i class="mdi mdi-close mdi-18px"></i>
            </button>
          </div>
        </header>

        <div id="agentChatTranscript" class="ac-scroll"></div>

        <div id="agentChatSuggestions" class="ac-suggestions-area"></div>

        <div class="ac-composer">
          <form id="agentChatComposer" class="ac-composer-row">
            <input id="agentChatInput" type="text" autocomplete="off" placeholder="Ask the Copilot" class="ac-input" />
            <button id="agentChatSend" type="submit" class="ac-btn-primary">Send</button>
          </form>
        </div>

        <!-- Resize handles placed inside to avoid corner artifacts -->
        <div data-agentchat-resize="top" class="ac-handle-top"></div>
        <div data-agentchat-resize="right" class="ac-handle-right"></div>
        <div data-agentchat-resize="corner" class="ac-handle-corner"></div>
      </div>
    `
    }

    function wireHeaderControls(panel) {
        panel
            .querySelector('#agentChatDemoPlay')
            ?.addEventListener('click', onDemoPlayClick)
        panel
            .querySelector('#agentChatClose')
            ?.addEventListener('click', () => {
                const toRestore = state.lastFocusedEl
                // Route through ToolController_ so MMGIS updates the tool's
                // on/off state (activeSeparatedTools, UI store, toggle event);
                // it calls our destroy() internally. Fall back to destroy() on
                // older core that lacks closeTool.
                const controller = window.ToolController_
                if (controller && typeof controller.closeTool === 'function') {
                    controller.closeTool('AgentChat')
                } else {
                    AgentChatTool.destroy()
                }
                setTimeout(() => {
                    if (toRestore && typeof toRestore.focus === 'function')
                        toRestore.focus()
                }, 0)
            })
        panel.querySelector('#agentChatMin')?.addEventListener('click', () => {
            state.minimized = !state.minimized
            applyMinimized(panel)
            if (!state.minimized) scrollTranscript()
        })
        syncHeaderActionStates()
    }

    function applyMinimized(panel) {
        const minimized = !!state.minimized
        const transcript = panel.querySelector('#agentChatTranscript')
        const composer = panel.querySelector('.ac-composer')
        const handles = panel.querySelectorAll(
            '.ac-handle-right, .ac-handle-top, .ac-handle-corner'
        )
        if (transcript) transcript.style.display = minimized ? 'none' : ''
        if (composer) composer.style.display = minimized ? 'none' : ''
        handles.forEach((h) => {
            h.style.display = minimized ? 'none' : ''
        })
        panel.style.height = minimized ? '53px' : '100%'
    }

    function wireComposer(panel) {
        const form = panel.querySelector('#agentChatComposer')
        form?.addEventListener('submit', onSend)
        panel
            .querySelector('#agentChatClear')
            ?.addEventListener('click', clearConversation)

        window.__mmgisAgentChatAppend = (text) => {
            if (!text) return
            pushSystem(text)
            scrollTranscript()
        }
    }

    function wireInputPlaceholderBehavior() {
        if (!state.inputEl) return
        state.lastInputHadText = !!state.inputEl.value.trim()
        state.inputEl.addEventListener('input', handlePlaceholderInput)
        rotateInputPlaceholder(true)
    }

    function handlePlaceholderInput() {
        if (!state.inputEl) return
        const hasText = state.inputEl.value.trim().length > 0
        if (!hasText && state.lastInputHadText) {
            rotateInputPlaceholder()
        }
        state.lastInputHadText = hasText
    }

    async function onDemoPlayClick() {
        if (
            state.isThinking ||
            !state.inputEl ||
            state.inputEl.hasAttribute('disabled')
        )
            return

        const queries =
            Array.isArray(state.demoQueries) && state.demoQueries.length
                ? state.demoQueries
                : DEFAULT_DEMO_QUERIES
        const currentIndex = clampDemoIndex(state.demoIndex, queries.length)
        const query = queries[currentIndex]
        if (!query) return

        state.inputEl.value = query
        state.inputEl.focus()
        state.demoIndex = (currentIndex + 1) % queries.length
        saveDemoIndex(state.demoIndex)
        syncHeaderActionStates()

        onSend({ preventDefault() {} }).catch((err) =>
            console.error('AgentChat demo query failed', err)
        )
    }

    function onTranscriptClick(event) {
        const origin = event.target
        const btn =
            origin && typeof origin.closest === 'function'
                ? origin.closest('.ac-suggest-chip')
                : null
        if (!btn || !state.transcriptEl?.contains(btn)) return
        if (!state.inputEl || state.inputEl.hasAttribute('disabled')) return
        const command = btn.getAttribute('data-command')
        if (!command) return
        state.inputEl.value = command
        state.inputEl.focus()
        onSend({ preventDefault() {} }).catch((err) =>
            console.error('AgentChat suggestion failed', err)
        )
    }

    function onSuggestionClick(event) {
        const origin = event.target
        const btn =
            origin && typeof origin.closest === 'function'
                ? origin.closest('.ac-suggest-chip')
                : null
        if (!btn || !state.suggestionsEl?.contains(btn)) return
        if (!state.inputEl || state.inputEl.hasAttribute('disabled')) return
        const command = btn.getAttribute('data-command')
        if (!command) return
        state.inputEl.value = command
        state.inputEl.focus()
        onSend({ preventDefault() {} }).catch((err) =>
            console.error('AgentChat suggestion failed', err)
        )
    }

    function attachGlobalKeys() {
        if (state.keyHandlersAttached) return
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
                const panel = document.getElementById(PANEL_ID)
                if (panel) {
                    state.minimized = !state.minimized
                    applyMinimized(panel)
                }
            }
            if (e.key === 'Escape') {
                const toRestore = state.lastFocusedEl
                // Properly destroy the tool to update made status and button state
                AgentChatTool.destroy()
                setTimeout(() => {
                    if (toRestore && typeof toRestore.focus === 'function')
                        toRestore.focus()
                }, 0)
            }
        }
        window.addEventListener('keydown', onKey)
        state.keyHandlersAttached = true
        window.__agentChatKeyHandler = onKey
    }

    // ————— Conversations ————————————————————————————————————————————————

    async function onSend(e) {
        e.preventDefault()
        ensureMissionConversationState()
        const input = state.inputEl
        if (!input) return
        if (state.isThinking || input.hasAttribute('disabled')) return
        const msg = (input.value || '').toString().trim()
        if (!msg) return

        pushMessage({
            id: uid(),
            role: 'user',
            text: msg,
            timestamp: new Date().toISOString(),
        })
        state.lastUserQuery = msg
        if (/^undo\s+last$/i.test(msg)) {
            input.value = ''
            await undoLast()
            scrollTranscript()
            return
        }

        input.value = ''
        state.lastInputHadText = false
        rotateInputPlaceholder()
        state.sendBtn?.setAttribute('data-loading', 'true')
        input.setAttribute('disabled', '')

        const requestId = beginThinking()

        try {
            let entry = null
            const turn = await runConversationTurn({
                originalMessage: msg,
                requestInitial: () => callAgent(msg),
                executeActions: (actions) => exec(actions, entry),
                requestContinuation: (response, toolResults) =>
                    continueAgent(msg, response, toolResults),
                resolveFinalText: resolveFinalAssistantText,
                maxRounds: MAX_TOOL_ROUNDS,
                onInitialResponse: (res) => {
                    const initialText =
                        res?.reply ||
                        res?.text ||
                        res?.message ||
                        'Working on that…'
                    entry = {
                        id: uid(),
                        role: 'assistant',
                        text: initialText,
                        reply: initialText,
                        citations: Array.isArray(res?.citations)
                            ? res.citations
                            : [],
                        actions: [],
                        debug: res?.debug || {},
                        originalQuery: msg,
                        timestamp: new Date().toISOString(),
                        notes: [],
                    }
                    pushMessage(entry)
                    scrollTranscript()
                },
                onResponse: (res) => {
                    if (entry && Array.isArray(res?.citations))
                        entry.citations = res.citations
                },
            })
            if (!entry)
                throw new Error('Agent turn did not create an assistant entry.')
            if (turn.continuationError) {
                console.error(
                    'AgentChat continuation failed',
                    turn.continuationError
                )
                entry.debug = entry.debug || {}
                entry.debug.continuationError = {
                    code: turn.continuationError?.code || 'CONTINUATION_FAILED',
                    message: sanitizeErrorMessage(turn.continuationError),
                }
            }
            entry.actions = turn.actions
            entry.toolResults = turn.toolResults
            entry.performed = turn.performed
            entry.reply = turn.finalText
            entry.text = turn.finalText
            saveHistory()
            renderMessages()
            scrollTranscript()
        } catch (err) {
            console.error('AgentChat request failed', err)
            const message = userFacingAgentError(err)
            pushMessage({
                id: uid(),
                role: 'assistant',
                text: message,
                reply: message,
                citations: [],
                actions: [],
                timestamp: new Date().toISOString(),
                debug: {
                    reason: err?.code || 'client_error',
                    clientError: sanitizeErrorMessage(err),
                },
            })
        } finally {
            endThinking(requestId)
            state.sendBtn?.removeAttribute('data-loading')
            input.removeAttribute('disabled')
            input.focus()
        }
    }

    async function callAgent(message) {
        if (!getCurrentMission()) {
            return {
                reply: 'No active mission is open. Open an MMGIS mission and try again.',
                actions: [],
                debug: { reason: 'missing_mission' },
            }
        }
        const payload = { message }
        // Runtime plugin actions may register/unregister or change availability
        // while MMGIS is open, so discover them fresh for every user turn.
        state.toolRegistry = null
        if (state.conversationId) payload.conversationId = state.conversationId
        const context = await buildAgentContext()
        if (context) payload.context = context
        // The current user entry was already pushed for immediate rendering;
        // omit it here because `message` is appended separately by the agent.
        payload.history = buildAgentHistory(state.history, message)
        return postAgent('', payload)
    }

    async function postAgent(path, payload) {
        const res = await fetch(agentApiUrl(path), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
        const responseText = await res.text()
        let responsePayload = responseText
        if (responseText.trim()) {
            try {
                responsePayload = JSON.parse(responseText)
            } catch (_) {
                // Plain text is a valid final continuation response.
            }
        } else {
            responsePayload = null
        }
        const normalized = normalizeAgentResponse(responsePayload, {
            ok: res.ok,
            status: res.status,
            contentType: res.headers.get('content-type') || '',
        })
        if (normalized.conversationId) {
            state.conversationId = normalized.conversationId
            saveConversationId(state.conversationId)
        }
        return normalized
    }

    function responseIdOf(response) {
        return (
            response?.responseId ||
            response?.response_id ||
            response?.requestId ||
            response?.id ||
            null
        )
    }

    async function continueAgent(originalMessage, response, toolResults) {
        return postAgent('/continue', {
            conversationId:
                state.conversationId || response?.conversationId || null,
            responseId: responseIdOf(response),
            originalMessage,
            toolResults,
            context: await buildAgentContext(),
        })
    }

    function renderMessages() {
        if (!state.transcriptEl) return
        const html = state.history.length
            ? state.history.map(renderMessage).join('')
            : renderEmptyState()

        const indicator = state.isThinking ? renderThinkingIndicator() : ''
        state.transcriptEl.innerHTML = html + indicator

        // Always render suggestions
        renderSuggestions()

        // Always scroll after rendering messages
        scrollTranscript()
    }

    function renderSuggestions() {
        if (!state.suggestionsEl) return

        const suggestions = state.history.length
            ? ensureContextualSuggestions()
            : ensureWelcomeSuggestions()

        const chips = (suggestions?.chips || [])
            .map(
                (cmd) => `
          <button
            type="button"
            class="ac-suggest-chip"
            role="listitem"
            data-command="${attr(cmd)}"
          >
            <span>${html(cmd)}</span>
          </button>`
            )
            .join('')

        state.suggestionsEl.innerHTML = chips
            ? `<div class="ac-suggest-label">Example queries:</div><div class="ac-suggest-grid" role="list">${chips}</div>`
            : ''
    }

    function renderEmptyState() {
        return `
      <section class="ac-welcome" aria-live="polite">
        <p class="ac-welcome-text">
          Ask the Copilot about MMGIS, list layers, toggle data, or explore documentation.
        </p>
      </section>
    `
    }

    function renderThinkingIndicator() {
        return `
      <div class="ac-thinking" role="status" aria-live="polite">
        <span class="ac-spinner" aria-hidden="true"></span>
        <span>Thinking&hellip;</span>
      </div>
    `
    }

    function renderMessage(entry) {
        const t = stamp(entry.timestamp)
        const isA = entry.role === 'assistant'
        const isU = entry.role === 'user'
        const roleLabel = isA ? 'Copilot' : isU ? 'You' : 'System'
        const bubbleClass = isA
            ? 'ac-bubble-a'
            : isU
              ? 'ac-bubble-u'
              : 'ac-bubble-s'
        const content = isA
            ? renderContent(entry.reply || entry.text || '')
            : renderContent(entry.text || '')
        const cites = isA ? renderCitations(entry.citations) : ''
        const trace = isA ? renderTrace(entry) : ''
        const notes =
            isA && Array.isArray(entry.notes) && entry.notes.length
                ? `<div class="ac-notes">${entry.notes
                      .map(
                          (n) =>
                              `<div class="ac-note">${renderContent(n)}</div>`
                      )
                      .join('')}</div>`
                : ''

        return `
      <article class="ac-msg">
        <div class="ac-meta ${isU ? 'ac-meta-right' : ''}">
          <span class="ac-role">${roleLabel}</span>
          <span class="ac-time" aria-label="time ${t}">${t}</span>
        </div>
        <div class="${bubbleClass}" aria-live="${isA ? 'polite' : 'off'}">
          <div class="ac-prose">${content}</div>
          ${notes}
          ${cites}
        </div>
        ${trace}
      </article>
    `
    }

    function renderCitations(list) {
        if (!Array.isArray(list) || !list.length) return ''
        const chips = list
            .map((c, i) => {
                const title =
                    (c && typeof c.title === 'string' && c.title) ||
                    `Source ${i + 1}`
                const safeUrl = safeCitationUrl(c?.url)
                const url = safeUrl ? attr(safeUrl) : null
                const snippet =
                    (c && typeof c.snippet === 'string' && c.snippet) || ''
                return `
          <span class="ac-cite">
            <details class="ac-cite"><summary class="ac-chip">[${
                i + 1
            }]</summary>
              <div class="ac-cite-card">
                <div class="ac-cite-title">${html(title)}</div>
                ${
                    snippet
                        ? `<p class="ac-cite-snippet">${html(snippet)}</p>`
                        : ''
                }
                ${
                    url
                        ? `<a class="ac-link" href="${url}" target="_blank" rel="noopener">Open source</a>`
                        : ''
                }
              </div>
            </details>
          </span>
        `
            })
            .join('')
        return `<div class="ac-cites">${chips}</div>`
    }

    function renderTrace(entry) {
        if (!state.showDebugTraces) return ''
        const blocks = []
        if (entry.actions?.length) {
            blocks.push(
                section(
                    'Planned actions',
                    code(
                        JSON.stringify(sanitizeToolData(entry.actions), null, 2)
                    )
                )
            )
        }
        if (entry.performed?.length) {
            blocks.push(
                section(
                    'Performed',
                    code(
                        JSON.stringify(
                            sanitizeToolData(entry.performed),
                            null,
                            2
                        )
                    )
                )
            )
        }
        if (entry.debug && typeof entry.debug === 'object') {
            const az = entry.debug.azure || {}
            const diag = sanitizeToolData({
                reason: entry.debug.reason,
                azureStatus: az?.response?.status,
                azureMessage: az?.message || az?.reason,
                run: entry.debug.run,
            })
            if (
                diag.reason ||
                diag.azureStatus ||
                diag.azureMessage ||
                diag.run
            ) {
                blocks.push(
                    section('Diagnostics', code(JSON.stringify(diag, null, 2)))
                )
            }
            if (entry.debug.serverError) {
                blocks.push(
                    section(
                        'Server error',
                        code(sanitizeErrorMessage(entry.debug.serverError))
                    )
                )
            }
            if (
                Array.isArray(entry.debug.serverStack) &&
                entry.debug.serverStack.length
            ) {
                blocks.push(
                    section(
                        'Server diagnostics',
                        code(
                            'A server stacktrace was recorded in backend logs.'
                        )
                    )
                )
            }
            if (
                Array.isArray(entry.debug.clientFailures) &&
                entry.debug.clientFailures.length
            ) {
                blocks.push(
                    section(
                        'Client failures',
                        code(
                            JSON.stringify(
                                sanitizeToolData(entry.debug.clientFailures),
                                null,
                                2
                            )
                        )
                    )
                )
            }
            if (
                Array.isArray(entry.debug.validationErrors) &&
                entry.debug.validationErrors.length
            ) {
                blocks.push(
                    section(
                        'Validation errors',
                        code(
                            JSON.stringify(
                                sanitizeToolData(entry.debug.validationErrors),
                                null,
                                2
                            )
                        )
                    )
                )
            }
        }
        if (!blocks.length) return ''
        return `
      <details class="ac-trace"><summary>Show trace</summary>
        <div class="ac-trace-body">${blocks.join('')}</div>
      </details>
    `
    }

    function section(title, body) {
        return `
      <section class="ac-trace-section">
        <div class="ac-trace-title">${html(title)}</div>
        ${body}
      </section>
    `
    }
    function code(s) {
        return `<pre class="ac-pre">${html(s)}</pre>`
    }

    function stamp(v) {
        if (!v) return ''
        try {
            const d = new Date(v)
            return d.toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
            })
        } catch {
            return ''
        }
    }
    function scrollTranscript() {
        if (!state.transcriptEl) {
            return
        }

        const element = state.transcriptEl

        // Simple scroll to bottom
        const scrollToBottom = () => {
            element.scrollTop = element.scrollHeight
        }

        // Execute immediately and after DOM updates
        scrollToBottom()
        requestAnimationFrame(scrollToBottom)
    }

    // Expose scroll function globally for renderers.js
    window.__mmgisAgentChatScroll = scrollTranscript

    function beginThinking() {
        const id = ++state.requestCounter
        state.activeRequestId = id
        setThinking(true)
        return id
    }

    function endThinking(id) {
        if (state.activeRequestId !== id) return
        state.activeRequestId = null
        setThinking(false)
    }

    function setThinking(flag) {
        const next = !!flag
        if (state.isThinking === next) return
        state.isThinking = next
        syncHeaderActionStates()
        renderMessages()
        if (next) scrollTranscript()
    }

    function syncHeaderActionStates() {
        const demoBtn = document.getElementById('agentChatDemoPlay')
        if (!demoBtn) return
        const disabled =
            state.isThinking ||
            !Array.isArray(state.demoQueries) ||
            state.demoQueries.length === 0
        if (disabled) demoBtn.setAttribute('disabled', '')
        else demoBtn.removeAttribute('disabled')
    }

    // ————— Drag & Resize ————————————————————————————————————————————————

    function initDragAndResize(overlay, panel) {
        const header = panel.querySelector('.ac-header')
        const topHandle = panel.querySelector('[data-agentchat-resize="top"]')
        const rightHandle = panel.querySelector(
            '[data-agentchat-resize="right"]'
        )
        const cornerHandle = panel.querySelector(
            '[data-agentchat-resize="corner"]'
        )

        let drag = null
        let rs = null

        const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

        function onDragStart(e) {
            if (e.button !== 0) return
            if (
                e.target?.closest(
                    '.ac-icon-btn, .ac-chip, details, button, input, a'
                )
            )
                return
            const r = overlay.getBoundingClientRect()
            drag = {
                dx: e.clientX - r.left,
                dy: e.clientY - r.top,
                w: r.width,
                h: r.height,
            }
            window.addEventListener('pointermove', onDragMove)
            window.addEventListener('pointerup', onDragEnd, { once: true })
            e.preventDefault()
        }
        function onDragMove(e) {
            if (!drag) return
            const l = clamp(
                e.clientX - drag.dx,
                8 - drag.w * 0.5,
                window.innerWidth - drag.w * 0.2
            )
            const t = clamp(
                e.clientY - drag.dy,
                8,
                window.innerHeight - drag.h - 56
            )
            overlay.style.left = `${Math.round(l)}px`
            overlay.style.top = `${Math.round(t)}px`
        }
        function onDragEnd() {
            drag = null
            window.removeEventListener('pointermove', onDragMove)
        }

        function onResizeStart(dir, e) {
            if (e.button !== 0) return
            e.preventDefault()
            e.stopPropagation()
            const r = overlay.getBoundingClientRect()
            rs = {
                dir,
                w: r.width,
                h: r.height,
                l: r.left,
                t: r.top,
                x: e.clientX,
                y: e.clientY,
            }
            window.addEventListener('pointermove', onResizeMove)
            window.addEventListener('pointerup', onResizeEnd, { once: true })
        }
        function onResizeMove(e) {
            if (!rs) return
            const minW = 360,
                minH = 320
            const maxW = Math.min(window.innerWidth - 40, 900)
            const maxH = Math.min(window.innerHeight - 40, 900)

            let w = rs.w,
                h = rs.h,
                top = rs.t

            if (rs.dir === 'right' || rs.dir === 'corner') {
                const dx = e.clientX - rs.x
                w = clamp(rs.w + dx, minW, maxW)
            }
            if (rs.dir === 'top' || rs.dir === 'corner') {
                const dy = e.clientY - rs.y
                if (rs.dir === 'top') {
                    h = clamp(rs.h - dy, minH, maxH)
                    top = clamp(rs.t + dy, 8, window.innerHeight - h - 56)
                } else {
                    h = clamp(rs.h + dy, minH, maxH)
                }
            }

            overlay.style.width = `${Math.round(w)}px`
            overlay.style.height = `${Math.round(h)}px`
            if (rs.dir === 'top') overlay.style.top = `${Math.round(top)}px`
        }
        function onResizeEnd() {
            rs = null
            window.removeEventListener('pointermove', onResizeMove)
        }

        header?.addEventListener('pointerdown', onDragStart)
        topHandle?.addEventListener('pointerdown', (e) =>
            onResizeStart('top', e)
        )
        rightHandle?.addEventListener('pointerdown', (e) =>
            onResizeStart('right', e)
        )
        cornerHandle?.addEventListener('pointerdown', (e) =>
            onResizeStart('corner', e)
        )
    }

    // ————— Tool registry + execution ————————————————————————————————————

    function listenForToolRegistryChanges() {
        try {
            // Access the main MMGIS WebSocket from the essence module
            const checkWs = () => {
                const ws = window.mmgisEssence?.ws || window.essence?.ws
                if (ws && ws.readyState === 1) {
                    ws.addEventListener('message', (event) => {
                        try {
                            const msg = JSON.parse(event.data)
                            if (msg.type === 'toolRegistryChanged') {
                                // Invalidate cached registry and reload
                                state.toolRegistry = null
                                state.staticToolRegistry = null
                                ensureRegistry()
                            }
                        } catch (_) {}
                    })
                } else {
                    // Retry after a short delay if WebSocket isn't ready yet
                    setTimeout(checkWs, 3000)
                }
            }
            checkWs()
        } catch (_) {}
    }

    async function ensureRegistry({ refreshRuntime = false } = {}) {
        if (!state.staticToolRegistry) {
            try {
                const res = await fetch(agentApiUrl('/tools'), {
                    method: 'GET',
                    headers: { 'Content-Type': 'application/json' },
                })
                if (!res.ok) throw new Error('Failed to load tool registry')
                const payload = await res.json()
                if (payload?.status === 'failure') {
                    throw new Error(
                        payload.message ||
                            payload.error ||
                            'Tool registry reported a failure.'
                    )
                }
                if (!payload || !Array.isArray(payload.tools))
                    throw new Error('Tool registry response is invalid')
                state.staticToolRegistry = payload
            } catch (error) {
                console.error('AgentChat tool registry load failed', error)
                // Keep the cache empty so a transient startup, auth, or
                // network failure is retried on the next request.
                state.staticToolRegistry = null
            }
        }
        if (!state.toolRegistry || refreshRuntime) {
            try {
                state.runtimeActions = await listRegisteredCopilotActions(
                    window.mmgisAPI
                )
            } catch (error) {
                console.error(
                    'AgentChat runtime action discovery failed',
                    error
                )
                state.runtimeActions = []
            }
        }
        const registry = state.staticToolRegistry || { tools: [] }
        state.toolRegistry = {
            ...registry,
            tools: mergeToolRegistries(
                state.runtimeActions,
                registry.tools || []
            ),
        }
        return state.toolRegistry
    }

    async function exec(actions, entry) {
        await ensureRegistry()
        refreshLayerIndex()
        const map = new Map(
            (state.toolRegistry?.tools || []).map((t) => [t.name, t])
        )
        const toolResults = []
        const queue = []

        for (const a of actions || []) {
            if (!a || typeof a !== 'object') continue
            const spec = map.get(a.tool)
            const callId = a.callId || a.call_id || a.toolCallId || a.id || null
            if (!spec) {
                const available = Array.from(map.keys())
                const err = new Error(
                    `Tool "${a.tool}" is not registered in the current tool registry.`
                )
                addFailure(
                    entry,
                    `Cannot execute tool "${
                        a.tool
                    }": not registered. Available: ${
                        available.length ? available.join(', ') : '(none)'
                    }.`,
                    err,
                    { tool: a.tool, stage: 'registry_lookup' }
                )
                toolResults.push(
                    createToolResult({
                        tool: a.tool,
                        callId,
                        ok: false,
                        message: err.message,
                        errorCode: 'TOOL_NOT_REGISTERED',
                    })
                )
                continue
            }

            const normalization = resolveActionLayerArgs(
                a,
                spec,
                entry?.originalQuery || state.lastUserQuery || ''
            )
            if (normalization.error) {
                addFailure(
                    entry,
                    `Cannot execute tool "${a.tool}": ${normalization.error}`,
                    null,
                    { tool: a.tool, args: a.args, stage: 'layer_resolution' }
                )
                toolResults.push(
                    createToolResult({
                        tool: a.tool,
                        callId,
                        ok: false,
                        message: normalization.error,
                        errorCode: 'LAYER_RESOLUTION_FAILED',
                    })
                )
                continue
            }
            queue.push({
                action: { ...normalization.prepared, callId },
                spec,
            })
        }

        for (const item of queue) {
            const a = item.action
            const x = item.spec.execution || {}

            if (x.adapter === 'mmgisAPI') {
                const r = await execMmgisApi(x, a, entry)
                toolResults.push(r)
            } else if (x.adapter === 'pluginAction') {
                const result = await executeRegisteredCopilotAction(
                    window.mmgisAPI,
                    {
                        name: x.action || a.tool,
                        callId: a.callId,
                    },
                    a.args || {},
                    await buildAgentContext()
                )
                if (!result.ok) {
                    addFailure(entry, result.message, null, {
                        tool: a.tool,
                        stage: 'plugin_action',
                    })
                }
                toolResults.push({ ...result, tool: a.tool })
            } else if (x.adapter === 'custom') {
                let pendingZoomUndo = null
                if (a.tool === 'zoom_to' && window.mmgisAPI?.map) {
                    const c = window.mmgisAPI.map.getCenter()
                    pendingZoomUndo = {
                        tool: 'zoom_to',
                        previous: {
                            center: [c.lng, c.lat],
                            zoom: window.mmgisAPI.map.getZoom(),
                        },
                    }
                }
                const kind = x.ui?.type || null
                if (kind && typeof RENDERERS[kind] === 'function') {
                    const appendedLines = []
                    const previousAppend = window.__mmgisAgentChatAppend
                    window.__mmgisAgentChatAppend = (text) => {
                        if (text != null && String(text).trim())
                            appendedLines.push(String(text))
                    }
                    try {
                        const rawResult = await RENDERERS[kind](
                            { originalMessage: entry?.originalQuery },
                            a.args || {}
                        )
                        const normalizedResult = normalizeRendererResult(
                            a.tool,
                            a.callId,
                            rawResult,
                            appendedLines
                        )
                        if (pendingZoomUndo && normalizedResult.ok)
                            pushUndo(pendingZoomUndo)
                        toolResults.push(normalizedResult)
                    } catch (e) {
                        console.error(`AgentChat renderer "${kind}" failed`, e)
                        const safeMessage = sanitizeErrorMessage(
                            e,
                            `Tool "${a.tool}" could not be completed.`
                        )
                        addFailure(entry, safeMessage, e, {
                            tool: a.tool,
                            renderer: kind,
                            args: a.args,
                        })
                        toolResults.push(
                            createToolResult({
                                tool: a.tool,
                                callId: a.callId,
                                ok: false,
                                message: safeMessage,
                                errorCode: e?.code || 'RENDERER_FAILED',
                            })
                        )
                    } finally {
                        window.__mmgisAgentChatAppend = previousAppend
                    }
                } else {
                    const msg = kind
                        ? `Renderer "${kind}" not available.`
                        : `Tool "${a.tool}" missing UI renderer type.`
                    addFailure(
                        entry,
                        `Cannot execute tool "${a.tool}": ${msg}`,
                        null,
                        { tool: a.tool, renderer: kind }
                    )
                    toolResults.push(
                        createToolResult({
                            tool: a.tool,
                            callId: a.callId,
                            ok: false,
                            message: msg,
                            errorCode: 'RENDERER_UNAVAILABLE',
                        })
                    )
                }
            } else {
                const message = `Tool "${a.tool}" uses unsupported adapter "${
                    x.adapter || 'missing'
                }".`
                addFailure(entry, message, null, {
                    tool: a.tool,
                    adapter: x.adapter,
                })
                toolResults.push(
                    createToolResult({
                        tool: a.tool,
                        callId: a.callId,
                        ok: false,
                        message,
                        errorCode: 'UNSUPPORTED_ADAPTER',
                    })
                )
            }
        }
        return toolResults
    }

    async function execMmgisApi(desc, action, entry) {
        const displayName = action.args?.name
        const matches = Array.isArray(action.__layerMatches)
            ? action.__layerMatches
            : []
        const matchForKey = (key) => matches.find((m) => m.key === key)
        const targetMatch = matchForKey('name')
        const method = desc.method
        const order = desc.argOrder || []
        const args = []
        const visibleBefore = window.mmgisAPI?.getVisibleLayers?.() || {}

        if (!isSafeMmgisApiMethod(method)) {
            const message = `Direct MMGIS API method "${method || 'missing'}" is not approved for Copilot execution.`
            addFailure(entry, message, null, {
                tool: action.tool,
                method,
                reason: 'unsafe_api_method',
            })
            return createToolResult({
                tool: action.tool,
                callId: action.callId,
                ok: false,
                message,
                errorCode: 'UNSAFE_MMGIS_API_METHOD',
            })
        }

        for (const k of order) {
            if (
                k === 'name' &&
                desc.nameResolution === 'displayNameToInternalId'
            ) {
                const resolvedMatch = matchForKey('name')
                const id =
                    resolvedMatch?.uuid || resolveDisplayNameToId(displayName)
                if (!id) {
                    const message = `Layer "${displayName}" was not found.`
                    addFailure(
                        entry,
                        `Cannot execute tool "${action.tool}": ${message}`,
                        null,
                        {
                            tool: action.tool,
                            method,
                            name: displayName,
                            reason: 'layer_not_found',
                        }
                    )
                    return createToolResult({
                        tool: action.tool,
                        callId: action.callId,
                        ok: false,
                        message,
                        errorCode: 'LAYER_NOT_FOUND',
                    })
                }
                args.push(id)
            } else {
                args.push(action.args ? action.args[k] : undefined)
            }
        }

        let pendingUndo = null
        if (method === 'toggleLayer') {
            const id = targetMatch?.uuid || resolveDisplayNameToId(displayName)
            const wasVisible = !!visibleBefore[id]
            pendingUndo = {
                method,
                target: displayName,
                previous: { visible: wasVisible },
            }
        }
        if (method === 'setLayerOpacity') {
            const resolvedMatch = matchForKey('name')
            const id =
                resolvedMatch?.uuid || resolveDisplayNameToId(displayName)
            const prev =
                L_?.layers?.opacity && typeof L_.layers.opacity[id] === 'number'
                    ? L_.layers.opacity[id]
                    : undefined
            if (typeof prev === 'number')
                pendingUndo = {
                    method,
                    target: displayName,
                    previous: { opacity: prev },
                }
        }

        const fn = window.mmgisAPI?.[method]
        let apiResult = null
        let verifiedResult = { ok: true, data: null }
        if (typeof fn === 'function') {
            try {
                apiResult = await fn.apply(window.mmgisAPI, args)
                const targetId = targetMatch?.uuid || args[0] || null
                const targetName =
                    targetMatch?.layer?.name || targetMatch?.resolved || null
                verifiedResult = verifyMmgisFacadeResult({
                    method,
                    targetId,
                    targetName,
                    requestedVisible: action?.args?.visible,
                    requestedOpacity: action?.args?.opacity,
                    visibleLayers: window.mmgisAPI?.getVisibleLayers?.() || {},
                    opacityByLayer: L_?.layers?.opacity || {},
                    rawResult: apiResult,
                })
                if (!verifiedResult.ok) {
                    addFailure(entry, verifiedResult.message, null, {
                        tool: action.tool,
                        method,
                        args,
                        verification: verifiedResult.data,
                    })
                    return createToolResult({
                        tool: action.tool,
                        callId: action.callId,
                        ok: false,
                        message: verifiedResult.message,
                        data: verifiedResult.data,
                        errorCode: verifiedResult.errorCode,
                    })
                }
                if (pendingUndo) pushUndo(pendingUndo)
                if (method === 'toggleLayer' && state.showDebugTraces) {
                    const visibleAfter =
                        window.mmgisAPI?.getVisibleLayers?.() || {}
                    const changed = Object.keys(visibleAfter).filter(
                        (key) => !!visibleAfter[key] !== !!visibleBefore[key]
                    )
                    console.info('[AgentChat][toggle_layer]', {
                        query:
                            entry?.originalQuery || state.lastUserQuery || '',
                        requestedLayer: displayName,
                        resolvedLayerName: targetMatch?.resolved || displayName,
                        resolvedLayerId: targetMatch?.uuid || args[0] || null,
                        resolvedGroupPath: targetMatch?.groupPath || '',
                        resolvedLayerUrl: targetMatch?.layer?.config?.url || '',
                        changedLayerIds: changed,
                    })
                }
                if (
                    method === 'toggleLayer' &&
                    action?.args?.visible === true &&
                    (targetMatch?.uuid || args[0])
                ) {
                    await hideConflictingLayersForTarget(
                        targetMatch?.uuid || args[0],
                        entry?.originalQuery || state.lastUserQuery || '',
                        entry
                    )
                }
            } catch (e) {
                addFailure(
                    entry,
                    `API method "${method}" threw an error: ${
                        e?.message || 'Unknown error'
                    }.`,
                    e,
                    { tool: action.tool, method, args }
                )
                return createToolResult({
                    tool: action.tool,
                    callId: action.callId,
                    ok: false,
                    message: `Unable to ${action.tool.replace(/_/g, ' ')}: ${
                        e?.message || 'Unknown error'
                    }`,
                    errorCode: e?.code || 'MMGIS_API_FAILED',
                })
            }
        } else {
            const message = `MMGIS API method "${method}" is unavailable.`
            addFailure(entry, message, null, {
                tool: action.tool,
                method,
                args,
                reason: 'missing_api_method',
            })
            return createToolResult({
                tool: action.tool,
                callId: action.callId,
                ok: false,
                message,
                errorCode: 'MMGIS_API_UNAVAILABLE',
            })
        }

        let message = `${action.tool.replace(/_/g, ' ')} completed successfully.`
        if (method === 'toggleLayer') {
            message = `${targetMatch?.resolved || displayName || 'The layer'} is now ${
                action.args?.visible ? 'visible' : 'hidden'
            }.`
        } else if (method === 'setLayerOpacity') {
            const opacity = Number(action.args?.opacity)
            message = `Set ${
                targetMatch?.resolved || displayName || 'the layer'
            } opacity to ${
                Number.isFinite(opacity)
                    ? `${Math.round(opacity * 100)}%`
                    : 'the requested value'
            }.`
        }
        return createToolResult({
            tool: action.tool,
            callId: action.callId,
            ok: true,
            message,
            data: {
                method,
                args,
                result: apiResult,
                verified: verifiedResult.data,
            },
        })
    }

    // ————— Layer helpers (robust name/id resolution) —————————————————————

    function collectLayers() {
        refreshLayerIndex()
        return state.layerIndex
            .filter(
                (layer) =>
                    String(layer?.config?.type || '').toLowerCase() !== 'header'
            )
            .map((layer) => {
                const aliases = Array.from(
                    new Set(
                        (layer.normalizedAliases || [])
                            .map((alias) => alias.raw)
                            .filter(Boolean)
                    )
                )
                const timeMeta = layer.timeMeta
                const analysis = assessLayerAnalysisCompatibility(layer, {
                    onState: L_?.layers?.on || null,
                    tools: state.toolRegistry?.tools || [],
                })
                const time =
                    timeMeta && timeMeta.enabled
                        ? {
                              enabled: true,
                              cadence: timeMeta.cadence,
                              format: timeMeta.format,
                              available_start: timeMeta.availableStart,
                              available_end: timeMeta.availableEnd,
                              current_start: timeMeta.currentStart,
                              current_end: timeMeta.currentEnd,
                          }
                        : null
                return {
                    id: layer.id,
                    display: layer.displayName,
                    name: layer.canonical,
                    aliases,
                    groupPath: layer.groupPath || '',
                    visible: layer.visible,
                    bbox: Array.isArray(layer.bbox) ? layer.bbox.slice() : null,
                    time,
                    type: layer.config?.type || null,
                    source_type:
                        layer.config?.sourceType ||
                        layer.config?.demSourceType ||
                        null,
                    analysis: {
                        supported: analysis.supported,
                        reason: analysis.reason,
                        operations: analysis.operations,
                        source: analysis.source,
                        scalar: analysis.scalar,
                    },
                }
            })
    }

    async function buildAgentContext() {
        await ensureRegistry({ refreshRuntime: true })
        const layers = collectLayers()
        const hints = layers.map((layer) => {
            const hint = {
                display_name: layer.display,
                canonical_name: layer.name,
                aliases: layer.aliases,
                group_path: layer.groupPath,
                visible: layer.visible,
                bbox: layer.bbox,
            }
            if (layer.time) hint.time = layer.time
            hint.type = layer.type
            hint.source_type = layer.source_type
            hint.analysis = layer.analysis
            return hint
        })
        const map = window.mmgisAPI?.map
        let mapContext = null
        if (map) {
            const center = map.getCenter?.()
            const bounds = map.getBounds?.()
            mapContext = {
                center:
                    center &&
                    Number.isFinite(center.lng) &&
                    Number.isFinite(center.lat)
                        ? [center.lng, center.lat]
                        : null,
                zoom: Number.isFinite(map.getZoom?.()) ? map.getZoom() : null,
                bounds: bounds ? latLngBoundsToBbox(bounds) : null,
                home:
                    Array.isArray(L_?.view) && L_.view.length >= 2
                        ? {
                              center: [Number(L_.view[1]), Number(L_.view[0])],
                              zoom: Number.isFinite(Number(L_.view[2]))
                                  ? Number(L_.view[2])
                                  : null,
                          }
                        : null,
            }
        }
        const pluginActions = state.runtimeActions
            .map(toRuntimeCapabilityDescriptor)
            .filter(Boolean)
        const configuredTools = Array.isArray(L_?.configData?.tools)
            ? L_.configData.tools
                  .map((tool) => tool?.name || tool?.js)
                  .filter(Boolean)
            : []
        const activeFeature = window.mmgisAPI?.getActiveFeature?.()
        const activeLayer =
            activeFeature && typeof activeFeature === 'object'
                ? Object.keys(activeFeature)[0] || null
                : L_?.activeFeature?.layerName || null
        const activeToolsRaw = window.mmgisAPI?.getActiveTools?.()
        const activeTools = Array.isArray(activeToolsRaw?.activeToolNames)
            ? activeToolsRaw.activeToolNames.slice(0, 20).map(String)
            : [window.mmgisAPI?.getActiveTool?.()?.activeToolName]
                  .filter(Boolean)
                  .map(String)
        return {
            mission: getCurrentMission(),
            map: mapContext,
            layers: hints,
            temporal: {
                enabled: TimeControl?.enabled === true,
                current: TimeControl?.currentTime || null,
                start: TimeControl?.startTime || null,
                end: TimeControl?.endTime || null,
            },
            analysis: buildAnalysisCatalog(state.layerIndex, {
                onState: L_?.layers?.on || null,
                tools: state.toolRegistry?.tools || [],
            }).map((entry) => ({
                layer: entry.layerName,
                visible: entry.visible,
                supported: entry.supported,
                reason: entry.reason,
                operations: entry.operations,
                source: entry.source,
            })),
            // The backend owns the bundled/static registry. Only locally
            // registered runtime capabilities are sent across the trust
            // boundary; static specs remain client-local for dispatch.
            runtimeCapabilities: pluginActions,
            loadedTools: configuredTools,
            activeLayer,
            activeTools,
            current: {
                layer: activeLayer,
                tools: activeTools,
            },
        }
    }

    function handleLayerVisibilityChange(event) {
        try {
            refreshLayerIndex()
        } catch (_) {}
        const detail = event?.detail
        if (!detail || !detail.layer || detail.visible !== true) return
        const layer = detail.layer
        const display =
            layer.display_name ||
            layer.displayName ||
            layer.title ||
            layer.name ||
            'Layer'
        const meta = getLayerTimeMetadata(layer)
        if (!meta.enabled) return
        const message = formatLayerTimeAnnouncement(display, meta)
        if (message) pushSystem(message)
    }

    function resolveDisplayNameToId(v) {
        if (!v) return null
        if (!state.layerIndex.length) refreshLayerIndex()
        const normalized = normalizeName(v)
        const direct = state.layerIndex.find(
            (layer) =>
                normalizeName(layer.displayName) === normalized ||
                normalizeName(layer.canonical) === normalized
        )
        if (direct) return direct.id
        return window.mmgisAPI?.asLayerUUID?.(String(v)) || null
    }

    function resolveIdToDisplayName(id) {
        const list = collectLayers()
        const found = list.find((x) => String(x.id) === String(id))
        return found ? found.display : String(id)
    }

    async function hideConflictingLayersForTarget(targetId, queryText, entry) {
        // Mission-specific conflict rules can be provided via window.mmgisAgentLayerConflicts:
        // An array of { trigger: /regex/, conflicts: /regex/ } objects.
        // If no mission provides rules, we skip conflict resolution entirely.
        const conflictRules =
            (typeof window !== 'undefined' &&
                window.mmgisAgentLayerConflicts) ||
            []
        if (!conflictRules.length) return []

        const normalizedQuery = normalizeName(queryText)
        const api = window.mmgisAPI
        if (!api) return []

        const matchingRules = conflictRules.filter(
            (r) => r.trigger && r.trigger.test(normalizedQuery)
        )
        if (!matchingRules.length) return []

        const visible = api.getVisibleLayers?.() || {}
        const configs = api.getLayerConfigs?.() || {}
        const turnedOff = []

        for (const id of Object.keys(visible)) {
            if (!visible[id]) continue
            if (String(id) === String(targetId)) continue
            const cfg = configs[id] || {}
            const haystack = normalizeName(
                [
                    cfg.display_name,
                    cfg.displayName,
                    cfg.name,
                    cfg.title,
                    ...(Array.isArray(cfg.aliases) ? cfg.aliases : []),
                ]
                    .filter(Boolean)
                    .join(' ')
            )
            const shouldDisable = matchingRules.some(
                (r) => r.conflicts && r.conflicts.test(haystack)
            )
            if (!shouldDisable) continue
            try {
                await api.toggleLayer(id, false)
                turnedOff.push({
                    id,
                    name:
                        cfg.display_name ||
                        cfg.displayName ||
                        cfg.name ||
                        String(id),
                })
            } catch (_) {}
        }

        if (turnedOff.length && entry) {
            addNoteToAssistant(
                entry,
                `Also turned off conflicting layer(s): ${turnedOff
                    .map((layer) => layer.name)
                    .join(', ')}.`
            )
        }
        return turnedOff
    }

    // (Fallback removed intentionally. Tools must be explicitly registered and executed.)

    function addNoteToAssistant(entry, text) {
        // Prefer adding notes to the most recent assistant message to reduce bubble count.
        let target = entry
        if (!target) {
            for (let i = state.history.length - 1; i >= 0; i--) {
                if (state.history[i]?.role === 'assistant') {
                    target = state.history[i]
                    break
                }
            }
        }
        if (target && target.role === 'assistant') {
            target.notes = target.notes || []
            target.notes.push(text)
            saveHistory()
            renderMessages()
        } else {
            // Fallback to a small system line if no assistant message exists yet
            pushMessage({
                id: uid(),
                role: 'system',
                text,
                timestamp: new Date().toISOString(),
            })
        }
    }

    // ————— Failure reporting helper ——————————————————————————————————————
    function addFailure(entry, noteText, error, meta) {
        const message = sanitizeErrorMessage(
            noteText || error,
            'Unknown failure.'
        )
        if (error) console.error('[AgentChat][tool failure]', error)
        addNoteToAssistant(entry, message)
        try {
            entry.debug =
                entry.debug && typeof entry.debug === 'object'
                    ? entry.debug
                    : {}
            entry.debug.clientFailures = Array.isArray(
                entry.debug.clientFailures
            )
                ? entry.debug.clientFailures
                : []
            entry.debug.clientFailures.push({
                message,
                meta: sanitizeToolData(meta),
            })
            saveHistory()
            renderMessages()
        } catch (_) {}
    }

    // ————— Undo, persistence, utilities ————————————————————————————————

    function pushUndo(entry) {
        undoStack.push({ ...entry, ts: Date.now() })
        if (undoStack.length > 25) undoStack.shift()
    }

    async function undoLast() {
        const e = undoStack.pop()
        if (!e) return pushSystem('Nothing to undo.')
        const map = window.mmgisAPI?.map

        if (e.method === 'toggleLayer') {
            const id = resolveDisplayNameToId(e.target)
            if (id != null && typeof e.previous?.visible === 'boolean') {
                await window.mmgisAPI.toggleLayer(id, e.previous.visible)
                pushSystem(
                    `Restored visibility for ${resolveIdToDisplayName(id)}.`
                )
            }
            return
        }
        if (e.method === 'setLayerOpacity') {
            const id = resolveDisplayNameToId(e.target)
            if (id != null && typeof e.previous?.opacity === 'number') {
                L_?.setLayerOpacity?.(id, e.previous.opacity)
                pushSystem(
                    `Restored opacity for ${resolveIdToDisplayName(id)}.`
                )
            }
            return
        }
        if (
            e.tool === 'zoom_to' &&
            map &&
            e.previous?.center &&
            typeof e.previous?.zoom === 'number'
        ) {
            const [lon, lat] = e.previous.center
            map.setView([lat, lon], e.previous.zoom)
            pushSystem('Restored previous view.')
        }
    }

    function loadConversationId() {
        try {
            return (
                localStorage.getItem(
                    scopedAgentStorageKey(
                        CONVERSATION_ID_KEY,
                        getCurrentMission()
                    )
                ) || null
            )
        } catch {
            return null
        }
    }

    function saveConversationId(id) {
        try {
            const key = scopedAgentStorageKey(
                CONVERSATION_ID_KEY,
                state.storageMission || getCurrentMission()
            )
            if (id) {
                localStorage.setItem(key, id)
            } else {
                localStorage.removeItem(key)
            }
        } catch (_) {}
    }

    function loadHistory() {
        try {
            const raw = localStorage.getItem(
                scopedAgentStorageKey(HISTORY_KEY, getCurrentMission())
            )
            const parsed = raw ? JSON.parse(raw) : []
            return Array.isArray(parsed) ? parsed.slice(-200) : []
        } catch {
            return []
        }
    }

    function loadTracePreference() {
        try {
            const raw = localStorage.getItem(TRACE_PREF_KEY)
            if (raw == null) return false
            return raw === 'true' || raw === '1'
        } catch (_) {
            return false
        }
    }

    function clampDemoIndex(index, length) {
        if (!Number.isFinite(length) || length <= 0) return 0
        const whole = Number.isFinite(index) ? Math.trunc(index) : 0
        if (whole < 0) return 0
        if (whole >= length) return 0
        return whole
    }

    function loadDemoIndex(length) {
        try {
            const raw = localStorage.getItem(DEMO_INDEX_KEY)
            if (raw == null) return 0
            return clampDemoIndex(Number(raw), length)
        } catch (_) {
            return 0
        }
    }

    function saveDemoIndex(index) {
        try {
            localStorage.setItem(DEMO_INDEX_KEY, String(index))
        } catch (_) {}
    }

    async function loadDemoQueries() {
        let queries = DEFAULT_DEMO_QUERIES.slice()
        try {
            const res = await fetch(agentApiUrl('/copilot/demo-queries'), {
                method: 'GET',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
            })
            if (!res.ok) {
                throw new Error(`Failed to load demo queries: ${res.status}`)
            }
            const payload = await res.json()
            const parsed = sanitizeDemoQueries(payload)
            if (!parsed.length) {
                throw new Error('Demo queries response is invalid')
            }
            queries = parsed
        } catch (_) {}

        state.demoQueries = queries
        state.demoIndex = clampDemoIndex(
            state.demoIndex,
            state.demoQueries.length
        )
        saveDemoIndex(state.demoIndex)
        syncHeaderActionStates()
    }

    function saveHistory() {
        try {
            localStorage.setItem(
                scopedAgentStorageKey(
                    HISTORY_KEY,
                    state.storageMission || getCurrentMission()
                ),
                JSON.stringify(state.history.slice(-200))
            )
        } catch {}
    }
    function clearConversation() {
        state.history = []
        state.conversationId = null
        saveConversationId(null)
        state.welcomeSuggestions = null
        state.demoIndex = 0
        saveDemoIndex(state.demoIndex)
        saveHistory()
        if (!state.inputEl || !state.inputEl.value.trim()) {
            state.lastInputHadText = false
            rotateInputPlaceholder()
        }
        renderMessages()
    }

    function ensureMissionConversationState() {
        const mission = getCurrentMission() || ''
        if (mission === state.storageMission) return
        state.storageMission = mission
        state.history = loadHistory()
        state.conversationId = loadConversationId()
        state.welcomeSuggestions = null
        state.contextualSuggestions = null
        state.contextualSuggestionsAt = null
        renderMessages()
    }
    function pushMessage(entry, { persist = true } = {}) {
        if (!state.history.length) state.welcomeSuggestions = null
        state.history.push(entry)
        if (persist) saveHistory()
        renderMessages()
    }
    function pushSystem(text) {
        // Prefer folding into latest assistant bubble to simplify the thread.
        addNoteToAssistant(null, text)
    }

    function uid() {
        return (
            (typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : Math.random().toString(36).slice(2)) + Date.now().toString(36)
        )
    }
    function html(s) {
        if (s == null) return ''
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
    }
    function attr(s) {
        return html(s).replace(/"/g, '%22')
    }

    function ensureWelcomeSuggestions() {
        if (!state.welcomeSuggestions) {
            state.welcomeSuggestions = createWelcomeSuggestions()
        }
        return state.welcomeSuggestions
    }

    function ensureContextualSuggestions() {
        const histLen = state.history.length
        if (
            !state.contextualSuggestions ||
            state.contextualSuggestionsAt !== histLen
        ) {
            state.contextualSuggestions = createContextualSuggestions()
            state.contextualSuggestionsAt = histLen
        }
        return state.contextualSuggestions
    }

    function createWelcomeSuggestions() {
        const pool = getCopilotSuggestionPool()
        const chipCount = boundedRandomCount(
            COPILOT_SUGGESTION_CHIP_RANGE.min,
            COPILOT_SUGGESTION_CHIP_RANGE.max,
            pool.length
        )
        const chips = sampleUnique(pool, chipCount)
        return { chips }
    }

    function createContextualSuggestions() {
        refreshLayerIndex()
        const contextualSuggestions = buildContextualSuggestions(
            state.history,
            state.layerIndex,
            {
                onState: L_?.layers?.on || null,
                tools: state.toolRegistry?.tools || [],
            }
        )
        const baseSuggestions = getCopilotSuggestionPool()
        const allSuggestions = [
            ...new Set([...contextualSuggestions, ...baseSuggestions]),
        ]
        const chipCount = boundedRandomCount(
            COPILOT_SUGGESTION_CHIP_RANGE.min,
            COPILOT_SUGGESTION_CHIP_RANGE.max,
            allSuggestions.length
        )

        // Prioritize contextual suggestions
        const contextualCount = Math.min(3, contextualSuggestions.length)
        const baseCount = Math.max(0, chipCount - contextualCount)

        const selectedContextual = sampleUnique(
            contextualSuggestions,
            contextualCount
        )
        const selectedBase = sampleUnique(
            baseSuggestions.filter((s) => !contextualSuggestions.includes(s)),
            baseCount
        )

        return { chips: [...selectedContextual, ...selectedBase] }
    }

    function boundedRandomCount(min, max, available) {
        const cappedMax = Math.max(0, Math.min(max, available))
        if (cappedMax === 0) return 0
        const cappedMin = Math.min(min, cappedMax)
        return randomInt(cappedMin, cappedMax)
    }

    function randomInt(min, max) {
        if (!Number.isFinite(min) || !Number.isFinite(max)) return 0
        if (max <= min) return Math.max(0, Math.floor(max))
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    function sampleUnique(list, count) {
        if (!Array.isArray(list) || count <= 0) return []
        const pool = [...list]
        const picks = []
        while (pool.length && picks.length < count) {
            const idx = Math.floor(Math.random() * pool.length)
            picks.push(pool.splice(idx, 1)[0])
        }
        return picks
    }

    function rotateInputPlaceholder() {
        if (!state.inputEl) return
        const pool = getCopilotSuggestionPool()
        if (!pool.length) return
        const exclude = pool.length > 1 ? state.currentPlaceholder : null
        let workingPool = pool
        if (exclude) {
            const filtered = workingPool.filter((cmd) => cmd !== exclude)
            if (filtered.length) workingPool = filtered
        }
        const next =
            workingPool[Math.floor(Math.random() * workingPool.length)] ||
            pool[0]
        state.currentPlaceholder = next
        applyInputPlaceholder(next)
    }

    function applyInputPlaceholder(text) {
        if (!state.inputEl) return
        const formatted = text ? `Ask: "${text}"` : 'Ask the Copilot'
        state.inputEl.setAttribute('placeholder', formatted)
    }

    function renderContent(text) {
        if (!text) return ''
        const escaped = html(text)
        const withLinks = escaped.replace(
            /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
            (_m, label, href) =>
                `<a class="ac-link" href="${attr(
                    href
                )}" target="_blank" rel="noopener">${html(label)}</a>`
        )
        const withUrls = withLinks.replace(
            /(https?:\/\/[^\s<]+)/g,
            (url) =>
                `<a class="ac-link" href="${attr(
                    url
                )}" target="_blank" rel="noopener">${html(url)}</a>`
        )
        return withUrls.replace(/\n/g, '<br>')
    }

    // ————— Assets/Styles removed ————————————————————————————————————————

    function removeExistingOverlay() {
        const el = document.getElementById(OVERLAY_ID)
        if (el) el.remove()
    }

    // ————— Teardown ————————————————————————————————————————————————

    function cleanup() {
        try {
            if (state.layerVisibilityListener) {
                document.removeEventListener(
                    'layerVisibilityChange',
                    state.layerVisibilityListener
                )
                state.layerVisibilityListener = null
            }
            document.getElementById(OVERLAY_ID)?.remove()
            delete window.__mmgisAgentChatAppend
            if (window.__agentChatKeyHandler) {
                window.removeEventListener(
                    'keydown',
                    window.__agentChatKeyHandler
                )
                delete window.__agentChatKeyHandler
            }
        } catch {}
    }
}

function hideToolbarButtons(retry = 0) {
    const ids = ['toolButtonAgentChat', 'toolButtonSeparated_AgentChat']
    let hidden = true
    ids.forEach((id) => {
        const el = document.getElementById(id)
        if (el) {
            el.style.display = 'none'
        } else {
            hidden = false
        }
    })
    if (!hidden && retry < 10) {
        setTimeout(() => hideToolbarButtons(retry + 1), 200)
    }
}

function ensureTopbarLauncher(retry = 0) {
    try {
        document
            .querySelectorAll('.mmgis-copilot-launcher')
            .forEach((el) => el.remove())
    } catch (_) {}

    const topBar =
        document.getElementById('loginDiv') ||
        document.getElementById('topBarRight')
    if (!topBar) {
        if (retry < 20) setTimeout(() => ensureTopbarLauncher(retry + 1), 250)
        return
    }

    let wrapper = document.getElementById(TOPBAR_WRAPPER_ID)
    if (!wrapper) {
        wrapper = document.createElement('div')
        wrapper.id = TOPBAR_WRAPPER_ID
        wrapper.style.display = 'flex'
        wrapper.style.flexDirection = 'column'
        wrapper.style.alignItems = 'center'
        wrapper.style.justifyContent = 'center'
        wrapper.style.marginLeft = '6px'
        wrapper.style.pointerEvents = 'auto'
        const insertionPoint =
            topBar.querySelector('#loginoutButton') ||
            topBar.querySelector('#forceSignupButton')?.nextSibling ||
            null
        topBar.insertBefore(wrapper, insertionPoint)
    }

    let button = document.getElementById(TOPBAR_LAUNCHER_ID)
    if (!button) {
        button = document.createElement('button')
        button.id = TOPBAR_LAUNCHER_ID
        button.type = 'button'
        button.className = 'mmgis-copilot-button mdi mdi-robot-outline'
        button.setAttribute('aria-label', 'Open MMGIS Copilot')
        button.setAttribute('title', 'Open MMGIS Copilot')
        button.addEventListener('click', (evt) => {
            evt.preventDefault()
            evt.stopPropagation()
            openFromTopbar()
        })
        wrapper.appendChild(button)
    }

    if (!wrapper.querySelector('.mmgis-copilot-label')) {
        const label = document.createElement('span')
        label.className = 'mmgis-copilot-label'
        label.textContent = 'Copilot'
        wrapper.appendChild(label)
    }
}

function openFromTopbar(attempt = 0) {
    try {
        const controller = window.ToolController_
        if (!controller) throw new Error('Tool controller unavailable')
        // Prefer the type-agnostic openTool API so open/close stay symmetric
        // (registers activeSeparatedTools, UI store, toggle event). Fall back
        // to makeTool on older core that lacks openTool.
        if (typeof controller.openTool === 'function') {
            controller.openTool('AgentChat')
        } else {
            if (!Array.isArray(controller.toolModuleNames))
                throw new Error('Tool controller unavailable')
            const idx = controller.toolModuleNames.indexOf('AgentChatTool')
            if (idx === -1) throw new Error('AgentChat tool not registered')
            controller.makeTool('AgentChatTool', idx)
        }
    } catch (err) {
        if (attempt < 5) {
            setTimeout(() => openFromTopbar(attempt + 1), 200)
        } else {
            // eslint-disable-next-line no-console
            console.warn('Failed to open AgentChat from topbar:', err?.message)
        }
    }
}

export default AgentChatTool
