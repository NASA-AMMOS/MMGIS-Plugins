import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MODULE_SOURCE = readFileSync(
    resolve(
        process.cwd(),
        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/conversationTurn.js'
    ),
    'utf8'
)
const ACTION_POLICY_SOURCE = readFileSync(
    resolve(
        process.cwd(),
        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/actionArgumentPolicy.js'
    ),
    'utf8'
)
const LAYER_ARGUMENT_SOURCE = readFileSync(
    resolve(
        process.cwd(),
        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/layerArgumentResolver.js'
    ),
    'utf8'
)
const LAYER_RESOLVER_SOURCE = readFileSync(
    resolve(
        process.cwd(),
        'plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/layerResolver.js'
    ),
    'utf8'
)

const HARNESS_HTML = `<!doctype html>
<html>
  <body>
    <form id="chat-form">
      <input id="chat-input" aria-label="Copilot prompt" />
      <button type="submit">Send</button>
    </form>
    <div id="map-state">initial</div>
    <div id="tool-state">closed</div>
    <div id="transcript" aria-live="polite"></div>
    <script type="module">
      import { runConversationTurn } from '/conversationTurn.js'
      import { prepareActionLayerArguments } from '/actionArgumentPolicy.js'

      const transcript = document.querySelector('#transcript')
      const form = document.querySelector('#chat-form')
      const input = document.querySelector('#chat-input')
      const layerIndex = [
        {
          id: 'layer-data',
          displayName: 'Data Layer',
          canonical: 'data-layer',
          aliases: ['data'],
        },
      ]
      const toolSpecs = {
        zoom_to: {
          name: 'zoom_to',
          execution: { adapter: 'custom' },
          parameters: { type: 'object', properties: { region: { type: 'string' } } },
        },
        plugin__explode: {
          name: 'plugin__explode',
          execution: { adapter: 'pluginAction' },
          parameters: { type: 'object', properties: {} },
        },
        'mmgis-core__open_tool': {
          name: 'mmgis-core__open_tool',
          execution: { adapter: 'pluginAction' },
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
          },
        },
      }

      function append(role, text) {
        const item = document.createElement('div')
        item.dataset.role = role
        item.textContent = text
        transcript.appendChild(item)
        return item
      }

      function finalText(response, results) {
        const direct = response?.reply || response?.text || response?.message
        if (direct && String(direct).trim()) return String(direct).trim()
        const messages = results.map((result) => result.message).filter(Boolean)
        return messages.join('\\n') || "Copilot didn't return a response for that. Please try rephrasing or try again."
      }

      window.mmgisAPI = {
        async executeCopilotHarnessAction(action) {
          if (action.tool === 'zoom_to') {
            document.querySelector('#map-state').textContent =
              'Beaufort Sea, zoom 3'
            return {
              tool: action.tool,
              callId: action.callId,
              ok: true,
              message: 'Zoomed to the Beaufort Sea at zoom level 3.',
              data: { region: 'Beaufort Sea', zoom: 3 },
              error: null,
            }
          }
          if (action.tool === 'mmgis-core__open_tool') {
            document.querySelector('#tool-state').textContent = action.args.name
            return {
              tool: action.tool,
              callId: action.callId,
              ok: true,
              message: action.args.name + ' tool opened.',
              data: { name: action.args.name },
              error: null,
            }
          }
          throw new Error(
            'private renderer failure at C:\\\\Users\\\\operator\\\\secret.js token=abc'
          )
        },
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        const message = input.value.trim()
        if (!message) return
        append('user', message)
        const assistant = append('assistant', 'Working on that…')
        try {
          const turn = await runConversationTurn({
            originalMessage: message,
            requestInitial: async () => {
              const response = await fetch('/api/agent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  message,
                  context: { mission: 'browser-harness' },
                  history: [],
                }),
              })
              return response.json()
            },
            executeActions: async (actions) =>
              Promise.all(
                actions.map(async (action) => {
                  try {
                    const prepared = prepareActionLayerArguments({
                      action,
                      spec: toolSpecs[action.tool],
                      layers: layerIndex,
                      userQuery: message,
                    })
                    if (prepared.error) {
                      return {
                        tool: action.tool,
                        callId: action.callId,
                        ok: false,
                        message: prepared.error,
                        data: null,
                        error: {
                          code: 'LAYER_RESOLUTION_FAILED',
                          message: prepared.error,
                        },
                      }
                    }
                    window.__preparedAction = prepared.prepared
                    return await window.mmgisAPI.executeCopilotHarnessAction(prepared.prepared)
                  } catch (error) {
                    console.error('Harness action failed', error)
                    return {
                      tool: action.tool,
                      callId: action.callId,
                      ok: false,
                      message: 'The requested tool could not be completed.',
                      data: null,
                      error: {
                        code: 'RENDERER_FAILED',
                        message: 'The requested tool could not be completed.',
                      },
                    }
                  }
                })
              ),
            requestContinuation: async (response, toolResults) => {
              const continued = await fetch('/api/agent/continue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  conversationId: response.conversationId,
                  responseId: response.responseId,
                  originalMessage: message,
                  toolResults,
                  context: { mission: 'browser-harness' },
                }),
              })
              return continued.json()
            },
            resolveFinalText: finalText,
            maxRounds: 4,
          })
          assistant.textContent = turn.finalText
          assistant.dataset.done = 'true'
          window.__turnResult = turn
        } catch (error) {
          assistant.textContent = 'Copilot could not complete that request.'
          assistant.dataset.done = 'true'
          window.__turnError = String(error)
        }
      })
    </script>
  </body>
</html>`

async function openHarness(page, { initialResponse, finalResponse }) {
    const requests = { initial: [], continuation: [] }
    await page.route('https://copilot-harness.test/**', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.pathname === '/conversationTurn.js') {
            await route.fulfill({
                status: 200,
                contentType: 'text/javascript',
                body: MODULE_SOURCE,
            })
            return
        }
        if (url.pathname === '/actionArgumentPolicy.js') {
            await route.fulfill({
                status: 200,
                contentType: 'text/javascript',
                body: ACTION_POLICY_SOURCE,
            })
            return
        }
        if (
            url.pathname === '/layerArgumentResolver' ||
            url.pathname === '/layerArgumentResolver.js'
        ) {
            await route.fulfill({
                status: 200,
                contentType: 'text/javascript',
                body: LAYER_ARGUMENT_SOURCE,
            })
            return
        }
        if (
            url.pathname === '/layerResolver' ||
            url.pathname === '/layerResolver.js'
        ) {
            await route.fulfill({
                status: 200,
                contentType: 'text/javascript',
                body: LAYER_RESOLVER_SOURCE,
            })
            return
        }
        if (url.pathname === '/api/agent') {
            requests.initial.push(request.postDataJSON())
            await route.fulfill({ json: initialResponse })
            return
        }
        if (url.pathname === '/api/agent/continue') {
            requests.continuation.push(request.postDataJSON())
            await route.fulfill({ json: finalResponse })
            return
        }
        await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: HARNESS_HTML,
        })
    })
    await page.goto('https://copilot-harness.test/')
    return requests
}

test.describe('@unit AgentChat browser request/action/continuation harness', () => {
    test('send executes an action, continues, and renders final assistant text', async ({
        page,
    }) => {
        const requests = await openHarness(page, {
            initialResponse: {
                conversationId: 'conversation-1',
                responseId: 'response-1',
                actions: [
                    {
                        tool: 'zoom_to',
                        callId: 'call-zoom',
                        args: { region: 'Beaufort Sea', zoom: 3 },
                    },
                ],
            },
            finalResponse: {
                reply: 'Zoomed to the Beaufort Sea at zoom level 3.',
                actions: [],
            },
        })

        await page.getByLabel('Copilot prompt').fill('Take me to Beaufort Sea at zoom 3')
        await page.getByRole('button', { name: 'Send' }).click()
        await expect(
            page.locator('[data-role="assistant"][data-done="true"]')
        ).toHaveText('Zoomed to the Beaufort Sea at zoom level 3.')
        await expect(page.locator('#map-state')).toHaveText(
            'Beaufort Sea, zoom 3'
        )

        expect(requests.initial).toHaveLength(1)
        expect(requests.initial[0].message).toBe(
            'Take me to Beaufort Sea at zoom 3'
        )
        expect(requests.continuation).toHaveLength(1)
        expect(requests.continuation[0]).toMatchObject({
            conversationId: 'conversation-1',
            responseId: 'response-1',
            originalMessage: 'Take me to Beaufort Sea at zoom 3',
            toolResults: [
                {
                    tool: 'zoom_to',
                    callId: 'call-zoom',
                    ok: true,
                    message: 'Zoomed to the Beaufort Sea at zoom level 3.',
                    error: null,
                },
            ],
        })
    })

    test('tool exception is structured, continued, and rendered without secrets', async ({
        page,
    }) => {
        const requests = await openHarness(page, {
            initialResponse: {
                conversationId: 'conversation-2',
                responseId: 'response-2',
                actions: [
                    {
                        tool: 'plugin__explode',
                        callId: 'call-error',
                        args: {},
                    },
                ],
            },
            finalResponse: {
                reply:
                    'The requested plugin action could not be completed. Try another available action.',
                actions: [],
            },
        })

        await page.getByLabel('Copilot prompt').fill('Run the failing plugin action')
        await page.getByRole('button', { name: 'Send' }).click()
        const assistant = page.locator(
            '[data-role="assistant"][data-done="true"]'
        )
        await expect(assistant).toHaveText(
            'The requested plugin action could not be completed. Try another available action.'
        )
        expect(requests.continuation).toHaveLength(1)
        expect(requests.continuation[0].toolResults[0]).toEqual({
            tool: 'plugin__explode',
            callId: 'call-error',
            ok: false,
            message: 'The requested tool could not be completed.',
            data: null,
            error: {
                code: 'RENDERER_FAILED',
                message: 'The requested tool could not be completed.',
            },
        })
        expect(JSON.stringify(requests.continuation[0])).not.toContain(
            'operator'
        )
        expect(await assistant.textContent()).not.toContain('token=abc')
    })

    test('core open_tool name bypasses layer resolution and reaches dispatch', async ({
        page,
    }) => {
        const requests = await openHarness(page, {
            initialResponse: {
                conversationId: 'conversation-open-tool',
                responseId: 'response-open-tool',
                actions: [
                    {
                        tool: 'mmgis-core__open_tool',
                        callId: 'call-open-tool',
                        args: { name: 'Layers' },
                    },
                ],
            },
            finalResponse: {
                reply: 'Opened the Layers tool.',
                actions: [],
            },
        })

        await page.getByLabel('Copilot prompt').fill('Open the Layers tool')
        await page.getByRole('button', { name: 'Send' }).click()
        await expect(page.locator('#tool-state')).toHaveText('Layers')
        await expect(
            page.locator('[data-role="assistant"][data-done="true"]')
        ).toHaveText('Opened the Layers tool.')
        expect(await page.evaluate(() => window.__preparedAction.args)).toEqual({
            name: 'Layers',
        })
        expect(requests.continuation[0].toolResults[0]).toMatchObject({
            tool: 'mmgis-core__open_tool',
            ok: true,
            message: 'Layers tool opened.',
        })
    })
})
