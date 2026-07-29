import $ from 'jquery'
import './WorkflowsTool.css'
import L_ from '@basics/Layers_/Layers_'
import ToolController_ from '@basics/ToolController_/ToolController_'

// mmgisAPI is intentionally accessed via window.mmgisAPI at call time rather
// than imported at module top. Importing it here creates a cycle through
// src/pre/tools.js → WorkflowsTool → mmgisAPI → LayerUtils that fails with
// "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before initialization."

const DEFAULT_POLL_INTERVAL_MS = 30000
// TiTiler colormap applied to workflow raster layers when the STAC item
// provides usable band statistics.
const DEFAULT_COG_COLORMAP = 'viridis'
const AUTH_POLL_INTERVAL_MS = 2000
const AUTH_POLL_TIMEOUT_MS = 5 * 60 * 1000
const SUBMITTED_STORAGE_KEY = 'mmgis.workflows.submitted'
const SUBMITTED_MAX_ENTRIES = 100
const PAGE_SIZE = 10

// Per-user job history is stored server-side in the MMGIS DB
// (workflow_submissions table). All three helpers below talk to that API.
// Network failures are intentionally swallowed — the UI degrades gracefully
// rather than blocking submit on a transient MMGIS-side error.

function mmgisUrl(path) {
    const root =
        (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    return (root ? root + '/' : '') + path.replace(/^\//, '')
}

function mmgisFetch(path, init) {
    return fetch(mmgisUrl(path), {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
        ...(init || {}),
    })
}

// Returns { [workflow_id]: { endpoint, payload, name, ts } }
function fetchSubmittedRegistry() {
    return mmgisFetch('api/workflows-history')
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body))
                return {}
            const out = {}
            d.body.forEach((row) => {
                if (!row || !row.workflow_id) return
                out[row.workflow_id] = {
                    endpoint: row.endpoint || '',
                    payload: row.payload || null,
                    name: row.name || '',
                    ts: row.created_on
                        ? new Date(row.created_on).getTime()
                        : Date.now(),
                }
            })
            return out
        })
        .catch(() => ({}))
}

function recordSubmittedJob(jobId, endpoint, payload, name) {
    return mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            endpoint,
            payload,
            name: name || '',
        }),
    }).catch(() => {})
}

function updateJobName(jobId, name) {
    // Goes through the upsert route (not /rename) so naming a job this user
    // never submitted creates its history row instead of silently updating
    // zero rows.
    return mmgisFetch('api/workflows-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workflow_id: jobId, name: name || '' }),
    }).catch(() => {})
}

// One-time migration from the old localStorage registry into the new
// DB-backed store. After successful upload, the localStorage key is cleared
// so we don't re-migrate every load. If MMGIS is unreachable, the legacy
// data is left in place to retry on the next open.
function migrateLegacyLocalStorageRegistry() {
    let raw
    try {
        raw = window.localStorage.getItem(SUBMITTED_STORAGE_KEY)
    } catch (e) {
        return Promise.resolve()
    }
    if (!raw) return Promise.resolve()
    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e2) {}
        return Promise.resolve()
    }
    if (!parsed || typeof parsed !== 'object') return Promise.resolve()
    const entries = Object.entries(parsed).filter(
        ([id]) => !id.startsWith('mock-')
    )
    if (entries.length === 0) {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e) {}
        return Promise.resolve()
    }
    return Promise.all(
        entries.map(([jobId, data]) =>
            recordSubmittedJob(
                jobId,
                data.endpoint,
                data.payload,
                data.name || ''
            )
        )
    ).then(() => {
        try {
            window.localStorage.removeItem(SUBMITTED_STORAGE_KEY)
        } catch (e) {}
    })
}

// Hardcoded from the cmss_api OpenAPI spec. When the upstream API gains or
// changes endpoints, edit this array. Field shape:
//   { name, type: 'string'|'number'|'boolean'|'date', default?, min?, max?,
//     description?, hidden?, readOnly? }
// hidden: don't render the field; always send its default in the payload.
// readOnly: render the field disabled (so the user sees the value) and always
// send its default in the payload.
//
// Data-source URI fields are marked hidden with NO default: they're omitted
// from the payload entirely and the API applies its own deployment-specific
// defaults. (TEMPORARY: file:// values are still stripped from the display
// of historical job payloads via isFilePathValue — remove that treatment
// when the UI learns to surface them helpfully.)
const ENDPOINTS = [
    {
        path: '/api/nfss/flood_prediction_inference',
        label: 'Flood Prediction Inference',
        category: 'Forecasting',
        description: 'Enqueue flood prediction inference.',
        fields: [
            {
                name: 'forecast_date',
                type: 'date',
                default: '2016-09-15',
            },
            {
                name: 'precipitation_scale_factor',
                type: 'string',
                default: '1.0',
            },
        ],
    },
    {
        path: '/api/iass/aquaculture_impact_assessment',
        label: 'Aquaculture Impact Assessment',
        category: 'Assessment',
        description: 'Enqueue aquaculture impact assessment.',
        fields: [
            {
                // Omitted from the payload — the API supplies its own
                // deployment-specific default for this data source.
                name: 'aquaculture_data_uri',
                type: 'string',
                hidden: true,
            },
            {
                name: 'geophysical_data_uri',
                type: 'string',
                hidden: true,
            },
            {
                name: 'geophysical_data_variable',
                type: 'string',
                default: 'temp',
            },
            {
                name: 'threshold',
                type: 'number',
                default: 90,
                description:
                    'Mean geophysical threshold that identifies impacted aquaculture.',
            },
            {
                name: 'impact_exceeds_threshold',
                type: 'boolean',
                default: true,
            },
            {
                name: 'output_file_suffix',
                type: 'string',
                default: 'gpkg',
            },
        ],
    },
    {
        path: '/api/iass/flood_population_impact_assessment',
        label: 'Population Impact Assessment',
        category: 'Assessment',
        description: 'Enqueue population impact assessment.',
        fields: [
            {
                // Omitted from the payload — the API supplies its own
                // deployment-specific default for this data source.
                name: 'population_data_uri',
                type: 'string',
                hidden: true,
            },
            {
                name: 'population_data_variable',
                type: 'string',
                default: 'population',
            },
            {
                name: 'geophysical_data_uri',
                type: 'string',
                hidden: true,
            },
            {
                name: 'geophysical_data_variable',
                type: 'string',
                default: 'FloodedFrac_tavg',
            },
            {
                name: 'threshold',
                type: 'number',
                default: 0.15,
                min: 0,
                max: 1,
            },
            {
                name: 'impact_exceeds_threshold',
                type: 'boolean',
                default: true,
            },
            {
                name: 'output_file_suffix',
                type: 'string',
                default: 'zarr',
            },
            {
                name: 'aggregation_units_uri',
                type: 'string',
                hidden: true,
            },
            {
                name: 'aggregation_output_file_suffix',
                type: 'string',
                default: 'gpkg',
            },
        ],
    },
]

function escapeHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function normalizeStatus(s) {
    if (!s || typeof s !== 'string') return ''
    return s.toLowerCase()
}

function isTerminal(status) {
    const s = normalizeStatus(status)
    return s === 'completed' || s === 'failed' || s === 'cancelled'
}

// Human-friendly label for a job's endpoint/template id. Locally-submitted
// jobs carry an ENDPOINTS path we can match exactly; server-only jobs carry
// a template_id like "flood_population_impact_v1" that we prettify.
function endpointLabel(endpoint) {
    if (!endpoint) return ''
    const known = ENDPOINTS.find((e) => e.path === endpoint)
    if (known) return known.label
    return endpoint
        .replace(/^\/api\//, '')
        .replace(/_v\d+$/i, '')
        .replace(/[/_]+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase())
}

// TEMPORARY: see comment on the ENDPOINTS const above.
function isFilePathValue(v) {
    return typeof v === 'string' && v.startsWith('file://')
}

// Pull a status from either our mock shape (job_status) or the real workflow
// shape (workflow_status). Always returned lowercase to keep CSS classes
// consistent.
function readStatus(body) {
    return normalizeStatus(
        (body && (body.workflow_status || body.job_status)) || ''
    )
}

// Detect a STAC item URL — anything with /stac/... and /items/<id> in the
// path. Workflow responses put these in prod_description, sometimes
// comma-separated with duplicates.
function isStacItemUrl(u) {
    return (
        typeof u === 'string' &&
        /^https?:\/\//i.test(u) &&
        /\/stac\//i.test(u) &&
        /\/items\//i.test(u)
    )
}

// Extract URLs (http/https) from a free-form description field. The workflow
// API concatenates multiple entries with commas.
function urlsFromString(s) {
    if (typeof s !== 'string' || !s) return []
    const out = []
    const re = /https?:\/\/[^\s,]+/gi
    let m
    while ((m = re.exec(s))) out.push(m[0])
    return out
}

// Collect every output URI we can find on a workflow body. Walks:
//   - stages[].products[].products[].file_uris[]  (canonical file paths)
//   - stages[].products[].products[].prod_description (URLs, e.g. STAC items)
// Also tolerates flat strings and the obvious url/uri/href keys.
function extractOutputUris(body) {
    const uris = []
    const push = (u) => {
        if (typeof u === 'string' && u) uris.push(u)
    }
    if (!body || typeof body !== 'object') return uris
    push(body.output_uri)
    if (Array.isArray(body.output_uris)) body.output_uris.forEach(push)
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (const stage of stages) {
        if (!stage || !Array.isArray(stage.products)) continue
        for (const outer of stage.products) {
            if (!outer) continue
            if (typeof outer === 'string') {
                push(outer)
                continue
            }
            const inner = Array.isArray(outer.products)
                ? outer.products
                : [outer]
            for (const item of inner) {
                if (!item) continue
                if (typeof item === 'string') {
                    push(item)
                    continue
                }
                if (Array.isArray(item.file_uris))
                    item.file_uris.forEach(push)
                push(item.url)
                push(item.uri)
                push(item.href)
                push(item.path)
                urlsFromString(item.prod_description).forEach(push)
            }
        }
    }
    // Dedupe while preserving first-seen order.
    return Array.from(new Set(uris))
}

// Workflow outputs become layers ONLY via tile STAC items — runs whose
// pipeline didn't catalog a STAC entry (e.g. vector-only outputs published
// to GeoServer) have no mappable layer here by design. Other URI kinds
// (s3://, file://, WFS) are never loadable from the browser anyway.
function findAutoAddableUri(uris) {
    for (const u of uris) {
        if (isStacItemUrl(u)) return u
    }
    return null
}

// Friendly endpoint label: prefer what we locally knew (the path the user
// submitted), then template_id, then nothing.
function readEndpoint(body, existingEndpoint) {
    if (existingEndpoint) return existingEndpoint
    if (body && typeof body.template_id === 'string') return body.template_id
    return ''
}

// For RUNNING workflows: pull the current stage name if available.
function readCurrentStage(body) {
    if (!body) return ''
    const stages = Array.isArray(body.stages) ? body.stages : []
    const idx =
        typeof body.current_stage_index === 'number'
            ? body.current_stage_index
            : -1
    if (idx >= 0 && idx < stages.length && stages[idx]) {
        return stages[idx].name || ''
    }
    return ''
}

// For FAILED workflows: prefer the top-level summary, fall back to the last
// stage with an error_message.
function readError(body) {
    if (!body) return ''
    if (typeof body.overall_error === 'string' && body.overall_error)
        return body.overall_error
    const stages = Array.isArray(body.stages) ? body.stages : []
    for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i]
        if (s && typeof s.error_message === 'string' && s.error_message)
            return s.error_message
    }
    return ''
}

function trimSlash(u) {
    return (u || '').replace(/\/+$/, '')
}

function buildForm($parent, fields) {
    $parent.empty()
    if (!fields || fields.length === 0) {
        $parent.append('<div class="wf-empty">No parameters.</div>')
        return () => ({})
    }
    const inputs = []
    let visibleCount = 0
    fields.forEach((f) => {
        // Hidden (explicit, or — TEMPORARY — file:// default): skip the DOM
        // entirely. The default still gets sent at collect-payload time.
        if (f.hidden || isFilePathValue(f.default)) {
            inputs.push({ f, $input: null })
            return
        }
        const id = `wf-field-${f.name.replace(/[^A-Za-z0-9_-]/g, '_')}`
        const initial = f.default
        const initialStr = initial != null ? String(initial) : ''
        const $field = $('<div class="wf-field"></div>')
        const lockedSuffix = f.readOnly
            ? ' <span class="wf-field-locked">read-only</span>'
            : ''
        $field.append(
            `<div class="wf-field-label"><label for="${id}">${escapeHTML(
                f.name
            )}</label><span class="wf-field-type">${escapeHTML(
                f.type || ''
            )}${lockedSuffix}</span></div>`
        )
        let $input
        if (f.type === 'boolean') {
            $input = $('<input type="checkbox" />').attr('id', id)
            if (initial === true) $input.prop('checked', true)
        } else if (f.type === 'number' || f.type === 'integer') {
            $input = $('<input type="number" />')
                .attr('id', id)
                .attr('placeholder', initialStr)
                .val(initialStr)
            if (f.type === 'integer') $input.attr('step', '1')
            if (f.min != null) $input.attr('min', f.min)
            if (f.max != null) $input.attr('max', f.max)
        } else if (f.type === 'date') {
            $input = $('<input type="date" />').attr('id', id).val(initialStr)
        } else {
            $input = $('<input type="text" />')
                .attr('id', id)
                .attr('placeholder', initialStr)
                .val(initialStr)
        }
        if (f.readOnly) {
            $input.prop('disabled', true).addClass('wf-input-readonly')
        }
        $field.append($input)
        if (f.description) {
            $field.append(
                `<div class="wf-field-description">${escapeHTML(
                    f.description
                )}</div>`
            )
        }
        $parent.append($field)
        inputs.push({ f, $input })
        visibleCount++
    })
    if (visibleCount === 0) {
        $parent.append(
            '<div class="wf-empty">All parameters hidden; defaults will be sent.</div>'
        )
    }
    return function collectPayload() {
        const out = {}
        inputs.forEach(({ f, $input }) => {
            let v
            if (f.hidden || f.readOnly || isFilePathValue(f.default)) {
                // Always emit the configured default — user can't change it
                // (either intentionally locked, or TEMPORARY file:// hiding).
                v = f.default
            } else if (f.type === 'boolean') {
                v = $input.is(':checked')
            } else if (f.type === 'number' || f.type === 'integer') {
                const raw = $input.val()
                if (raw !== '') v = Number(raw)
            } else {
                v = $input.val()
            }
            if (v !== undefined && v !== '') out[f.name] = v
        })
        return out
    }
}

// Pull {collection, item} out of a STAC item URL like
// http://host/stac/collections/<coll>/items/<item>. Returns null if not
// recognized.
function parseStacItemUrl(u) {
    const m = /\/stac\/collections\/([^/?#]+)\/items\/([^/?#]+)/i.exec(u)
    if (!m) return null
    return { collection: m[1], item: m[2] }
}

// Fixed RFC-format uuid — the Configure API's validator (uuidValidate)
// rejects human-readable ids and would regenerate them, breaking lookups.
const GROUP_UUID = 'c7a4f1de-2f04-4e6b-9c8d-3b1a2e5f6a70'
const GROUP_DISPLAY_NAME = 'Workflow Outputs'

// Get (or lazily create + register) the header group all workflow layers
// live under in the Layers panel. The same object reference is shared
// between L_.configData.layers and L_.layers.data, mirroring parseConfig.
function ensureWorkflowsGroup() {
    if (L_.layers.data[GROUP_UUID]) return L_.layers.data[GROUP_UUID]
    const header = {
        // Post-parse convention: name IS the uuid (LayersTool builds DOM ids
        // from name; display_name carries the label).
        name: GROUP_UUID,
        uuid: GROUP_UUID,
        display_name: GROUP_DISPLAY_NAME,
        type: 'header',
        expanded: true,
        visibility: true,
        sublayers: [],
    }
    L_.layers.data[GROUP_UUID] = header
    L_.layers.nameToUUID = L_.layers.nameToUUID || {}
    L_.layers.nameToUUID[GROUP_DISPLAY_NAME] = [GROUP_UUID]
    L_.layers.on = L_.layers.on || {}
    L_.layers.on[GROUP_UUID] = true // headers always start on
    L_.layers.opacity = L_.layers.opacity || {}
    L_.layers.opacity[GROUP_UUID] = 1
    L_.layers.dataFlat = L_.layers.dataFlat || []
    L_.layers.dataFlat.unshift(header)
    L_.configData.layers = L_.configData.layers || []
    L_.configData.layers.unshift(header)
    return header
}

// Markdown provenance blurb for the Layers panel's Information modal
// (LayerInfoModal renders layer.description through showdown).
// The description is rendered as HTML by the Layers panel's info modal
// (showdown passes raw HTML through), and it persists into the shared
// mission config — so every interpolated value is untrusted input and must
// be neutralized against stored XSS AND markdown breakouts. HTML-active
// chars become entities (decoded only at final render, after markdown
// parsing); md-active chars are backslash-escaped. No code spans: a value
// containing a backtick could otherwise close the span and inject raw HTML.
function mdSafe(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/`/g, '&#96;')
        .replace(/\|/g, '&#124;') // keeps table cells intact
        .replace(/"/g, '&quot;') // blocks attribute injection in generated tags
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        // Markdown image/link syntax still emits <img>/<a> without these:
        // ![](https://a/b.png"onerror="alert(1)) yields an auto-firing
        // onerror, and [x](javascript:alert(1)) yields a javascript: href.
        .replace(/[\[\]()!]/g, (m) => '\\' + m)
}

function buildLayerDescription(jobId, job) {
    const lines = ['Generated by the Workflows tool.', '']
    if (job.name) lines.push(`**Run:** ${mdSafe(job.name)}`)
    lines.push(`**Workflow:** ${mdSafe(jobId)}`)
    if (job.endpoint) lines.push(`**Endpoint:** ${mdSafe(job.endpoint)}`)
    if (job.payload && Object.keys(job.payload).length > 0) {
        // TEMPORARY: file:// values stripped from display, same as the job
        // tiles (see comment on ENDPOINTS).
        const entries = Object.entries(job.payload).filter(
            ([, v]) => !isFilePathValue(v)
        )
        if (entries.length > 0) {
            lines.push('', '**Parameters:**', '')
            lines.push('| Parameter | Value |')
            lines.push('| --- | --- |')
            entries.forEach(([k, v]) => {
                lines.push(`| ${mdSafe(k)} | ${mdSafe(v)} |`)
            })
        }
    }
    return lines.join('\n')
}

// Fetch the run's STAC item — same-origin through MMGIS's /stac proxy — and
// pull raster band statistics so the layer starts with a sensible TiTiler
// rescale instead of the default stretch. Returns {min, max, nodata} or null
// when the item has no usable stats (layer then renders with defaults).
async function fetchStacRasterOptions(stac) {
    try {
        const r = await mmgisFetch(
            `stac/collections/${encodeURIComponent(
                stac.collection
            )}/items/${encodeURIComponent(stac.item)}`
        )
        if (!r.ok) return null
        const item = await r.json()
        const assets = item.assets || {}
        const asset = assets.asset || assets[Object.keys(assets)[0]]
        const bands =
            (asset && asset['raster:bands']) ||
            (item.properties && item.properties['raster:bands'])
        const b0 = Array.isArray(bands) ? bands[0] : null
        const stats = b0 && (b0.statistics || b0.stats)
        const min = stats && (stats.minimum != null ? stats.minimum : stats.min)
        const max = stats && (stats.maximum != null ? stats.maximum : stats.max)
        if (typeof min === 'number' && typeof max === 'number' && max > min) {
            return { min, max, nodata: b0.nodata }
        }
        return null
    } catch (e) {
        return null
    }
}

// Core MMGIS templates (LayersTool rows, LayerInfoModal title) interpolate
// layer display_name into HTML without escaping — since run names are
// user input, strip tag-forming characters before they become a
// display_name. (The Workflows panel itself escapes properly; this guards
// the core-side sinks.)
function safeDisplayName(name, jobId) {
    const cleaned = String(name || '')
        .replace(/[<>]/g, '')
        .trim()
    return cleaned || `Workflow ${jobId}`
}

function buildLayerObjForJob(jobId, uri, job) {
    const uuid = jobId
    const base = {
        // MMGIS keys everything by uuid-as-name; display_name is the label.
        name: uuid,
        uuid,
        display_name: safeDisplayName(job.name, jobId),
        description: buildLayerDescription(jobId, job),
        initialOpacity: 1,
        visibility: true,
        controlled: false,
        variables: {},
        // parseConfig stamps this on every layer; without it Map_ turns the
        // missing time into starttime/endtime of '' and the tile middleware
        // emits a `datetime=/` param that pgstac rejects.
        time: { enabled: false },
    }
    // Workflow layers are exclusively tile STAC items (findAutoAddableUri
    // guarantees uri parses). Piggy-back on MMGIS's stac-collection:
    // handling — the workflow's item lives in a per-user collection; adding
    // the collection surfaces the new item via titilerpgstac tiles.
    const stac = parseStacItemUrl(uri)
    if (!stac) return null
    return {
        ...base,
        type: 'tile',
        url: `stac-collection:${stac.collection}`,
        tileformat: 'wmts',
        minZoom: 0,
        // The config validator requires all three zoom fields on tile
        // layers (no defaults are filled for them).
        maxNativeZoom: 20,
        maxZoom: 20,
        style: {},
    }
}

// Persist the layer into the mission's stored configuration via the
// Configure API so it survives reloads and reaches other users of the
// mission. Two-step, self-healing: first try placing the child inside the
// existing "Workflow Outputs" group; if the group doesn't exist in the
// stored config yet, create it (with the layer inside) at the top.
// Requires the MMGIS user to have mission-edit permission — failure is
// non-fatal (the layer stays for this session either way).
async function persistLayerToMission(layerObj) {
    const mission = L_.mission
    if (!mission) return false
    const post = (body) =>
        mmgisFetch('api/configure/addLayer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then((r) => r.json())
            .catch(() => ({ status: 'failure', message: 'network error' }))

    let r = await post({
        mission,
        layer: layerObj,
        placement: { path: GROUP_DISPLAY_NAME, index: 0 },
    })
    if (r.status === 'success') return true
    if (!/not found/i.test(String(r.message || ''))) {
        console.warn('[WorkflowsTool] persist failed:', r.message, r.errors || r.badUUIDs || '')
        return false
    }
    r = await post({
        mission,
        layer: {
            name: GROUP_DISPLAY_NAME,
            uuid: GROUP_UUID,
            type: 'header',
            expanded: true,
            visibility: true,
            sublayers: [layerObj],
        },
        placement: { index: 0 },
    })
    if (r.status === 'success') return true
    console.warn('[WorkflowsTool] persist failed:', r.message, r.errors || r.badUUIDs || '')
    return false
}

// Remove a run's layer everywhere: off the map, out of the L_ registries and
// the "Workflow Outputs" group, and (best-effort) out of the stored mission
// configuration.
async function removeLayerForJob(jobId, job) {
    const layerObj = L_.layers.data[jobId]
    if (layerObj) {
        try {
            // Detach from the map first if currently visible.
            if (L_.layers.on[jobId] === true) {
                await L_.toggleLayer(layerObj, true)
            }
        } catch (err) {
            console.warn('[WorkflowsTool] layer detach failed', err)
        }
        delete L_.layers.layer[jobId]
        delete L_.layers.data[jobId]
        delete L_.layers.on[jobId]
        delete L_.layers.opacity[jobId]
        if (L_.layers.attachments) delete L_.layers.attachments[jobId]
        if (L_._layersParent) delete L_._layersParent[jobId]
        const oi = (L_._layersOrdered || []).indexOf(jobId)
        if (oi !== -1) L_._layersOrdered.splice(oi, 1)
        const fi = (L_.layers.dataFlat || []).findIndex(
            (l) => l && l.uuid === jobId
        )
        if (fi !== -1) L_.layers.dataFlat.splice(fi, 1)
        const dn = layerObj.display_name
        if (dn && L_.layers.nameToUUID && L_.layers.nameToUUID[dn]) {
            const ni = L_.layers.nameToUUID[dn].indexOf(jobId)
            if (ni !== -1) L_.layers.nameToUUID[dn].splice(ni, 1)
            if (L_.layers.nameToUUID[dn].length === 0)
                delete L_.layers.nameToUUID[dn]
        }
        // The group header object is shared with configData, so splicing its
        // sublayers updates the config tree too.
        const group = L_.layers.data[GROUP_UUID]
        if (group && Array.isArray(group.sublayers)) {
            const si = group.sublayers.findIndex(
                (l) => l && l.uuid === jobId
            )
            if (si !== -1) group.sublayers.splice(si, 1)
        }
        const layersTool = ToolController_.getTool
            ? ToolController_.getTool('LayersTool')
            : null
        if (
            ToolController_.activeToolName === 'LayersTool' &&
            layersTool &&
            layersTool.destroy &&
            layersTool.make
        ) {
            layersTool.destroy()
            layersTool.make()
        }
    }
    job.layerAdded = false
    job.persisted = undefined
    Workflows.renderJobs()
    // Best-effort removal from the stored mission config; "not found" just
    // means it was session-only.
    mmgisFetch('api/configure/removeLayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mission: L_.mission, layerUUID: jobId }),
    })
        .then((r) => r.json())
        .then((r) => {
            if (
                r.status !== 'success' &&
                !/not found|unable/i.test(String(r.message || ''))
            )
                console.warn(
                    '[WorkflowsTool] layer config removal:',
                    r.message
                )
        })
        .catch(() => {})
}

// Keep an added layer's label (and provenance description) in sync when the
// user renames the run — in-memory, in the Layers panel, and in the stored
// mission config when the layer was persisted there.
function syncLayerName(jobId) {
    const uuid = jobId
    const layerObj = L_.layers.data[uuid]
    if (!layerObj) return
    const job = Workflows.jobs[jobId] || {}
    layerObj.display_name = safeDisplayName(job.name, jobId)
    layerObj.description = buildLayerDescription(jobId, job)
    // dataFlat/configData hold the same object reference, so the Layers
    // panel picks the new label up on its next build; rebuild now if showing.
    const layersTool = ToolController_.getTool
        ? ToolController_.getTool('LayersTool')
        : null
    if (
        ToolController_.activeToolName === 'LayersTool' &&
        layersTool &&
        layersTool.destroy &&
        layersTool.make
    ) {
        layersTool.destroy()
        layersTool.make()
    }
    // Best-effort config sync — a "not found" just means the layer was never
    // persisted (session-only), which is fine.
    mmgisFetch('api/configure/updateLayer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mission: L_.mission,
            layerUUID: uuid,
            layer: {
                display_name: layerObj.display_name,
                description: layerObj.description,
            },
        }),
    })
        .then((r) => r.json())
        .then((r) => {
            if (
                r.status !== 'success' &&
                !/not found/i.test(String(r.message || ''))
            )
                console.warn('[WorkflowsTool] layer rename sync:', r.message)
        })
        .catch(() => {})
}

function addLayerForJob(jobId, job) {
    const uri = job.autoAddableUri
    if (!uri) return
    const uuid = jobId
    const layerObj = buildLayerObjForJob(jobId, uri, job)
    if (!layerObj) return
    // Skip mmgisAPI.addLayer (it forgets to re-parse the config) and skip the
    // resetConfig path (re-runs parseConfig over every existing mission layer,
    // surfacing unrelated latent bugs in those layers). Splice the new layer
    // directly into the already-parsed L_ registries — nested under the
    // shared "Workflows" header group — and ask the map to render only it.
    ;(async () => {
        try {
            if (L_.layers.data[uuid]) {
                // Already present; nothing to do.
                job.layerAdded = true
                Workflows.renderJobs()
                return
            }
            // Seed TiTiler options from the STAC item's raster statistics
            // (best-effort — defaults apply when the item carries no stats).
            const stac = parseStacItemUrl(uri)
            if (stac) {
                const ropts = await fetchStacRasterOptions(stac)
                if (ropts) {
                    layerObj.cogTransform = true
                    layerObj.cogMin = ropts.min
                    layerObj.currentCogMin = ropts.min
                    layerObj.cogMax = ropts.max
                    layerObj.currentCogMax = ropts.max
                    layerObj.cogColormap = DEFAULT_COG_COLORMAP
                    if (ropts.nodata != null)
                        layerObj.cogNodata = ropts.nodata
                }
            }
            const group = ensureWorkflowsGroup()
            group.sublayers.unshift(layerObj)
            L_.layers.data[uuid] = layerObj
            L_.layers.nameToUUID = L_.layers.nameToUUID || {}
            L_.layers.nameToUUID[layerObj.display_name] =
                L_.layers.nameToUUID[layerObj.display_name] || []
            L_.layers.nameToUUID[layerObj.display_name].push(uuid)
            L_._layersOrdered = L_._layersOrdered || []
            L_._layersOrdered.unshift(uuid)
            L_.layers.dataFlat = L_.layers.dataFlat || []
            L_.layers.dataFlat.unshift(layerObj)
            L_.layers.on = L_.layers.on || {}
            L_.layers.on[uuid] = true
            L_.layers.opacity = L_.layers.opacity || {}
            L_.layers.opacity[uuid] = 1
            L_._layersParent = L_._layersParent || {}
            L_._layersParent[uuid] = GROUP_UUID
            await L_.Map_.makeLayer(layerObj, true)
            // makeLayer only constructs the Leaflet layer; addVisible is
            // what actually attaches it to the map (same two-step
            // addLayerToLayersData performs).
            L_.addVisible(L_.Map_, [uuid])
            // Refresh the Layers panel if it happens to be showing.
            const layersTool = ToolController_.getTool
                ? ToolController_.getTool('LayersTool')
                : null
            if (
                ToolController_.activeToolName === 'LayersTool' &&
                layersTool &&
                layersTool.destroy &&
                layersTool.make
            ) {
                layersTool.destroy()
                layersTool.make()
            }
            job.layerAdded = true
            job.persisted = 'pending'
            Workflows.renderJobs()
            persistLayerToMission(layerObj).then((ok) => {
                job.persisted = ok
                Workflows.renderJobs()
            })
        } catch (err) {
            console.warn('[WorkflowsTool] addLayer failed', err)
        }
    })()
}

// ---- HTTP helpers ----

function directFetchJSON(url, init) {
    return fetch(url, {
        credentials: 'include',
        ...(init || {}),
        headers: {
            Accept: 'application/json',
            ...((init && init.headers) || {}),
        },
    }).then(async (res) => {
        const text = await res.text()
        let json
        try {
            json = text ? JSON.parse(text) : {}
        } catch (e) {
            json = { raw: text }
        }
        return { ok: res.ok, status: res.status, body: json }
    })
}

function checkAuth() {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) + '/api/auth-status'
    )
        .then((r) => {
            if (!r.ok) return false
            if (
                r.body &&
                (r.body.authenticated === false ||
                    r.body.status === 'unauthenticated')
            )
                return false
            return true
        })
        .catch(() => false)
}

function submitJob(endpointPath, payload) {
    return directFetchJSON(trimSlash(Workflows.baseUrl) + endpointPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
    }).then((r) => {
        if (!r.ok) {
            const msg =
                (r.body && (r.body.detail || r.body.message)) ||
                `Submit ${r.status}`
            throw new Error(
                typeof msg === 'string' ? msg : JSON.stringify(msg)
            )
        }
        return r.body || {}
    })
}

function pollJob(jobId) {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) +
            '/api/workflows/' +
            encodeURIComponent(jobId)
    ).then((r) => (r.ok ? r.body || {} : {}))
}

function listJobIds() {
    return directFetchJSON(
        trimSlash(Workflows.baseUrl) + '/api/workflows/all_ids'
    ).then((r) => (r.ok && Array.isArray(r.body) ? r.body : []))
}

// ---- Tool ----

const Workflows = {
    height: 0,
    width: 360,
    vars: null,
    baseUrl: '',
    selectedEndpointPath: null,
    jobs: {},
    jobIds: [],
    filterText: '',
    expandedIds: null, // initialized in make()
    paramsExpandedIds: null, // initialized in make()
    page: 0,
    pollTimer: null,
    authPollTimer: null,
    onAuthReady: null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    MMGISInterface: null,

    make: function () {
        Workflows.vars = L_.getToolVars('workflows') || {}
        if (Workflows.vars.pollIntervalMs)
            Workflows.pollIntervalMs = Workflows.vars.pollIntervalMs
        // baseUrl is a tool variable (configurable in the Configure UI).
        // Fall back to the legacy top-level `workflows` config block for
        // missions configured before this moved.
        const legacy = (L_.configData && L_.configData.workflows) || {}
        Workflows.baseUrl = Workflows.vars.baseUrl || legacy.baseUrl || ''
        if (!Workflows.expandedIds) Workflows.expandedIds = new Set()
        if (!Workflows.paramsExpandedIds)
            Workflows.paramsExpandedIds = new Set()
        Workflows.MMGISInterface = new interfaceWithMMGIS()
        // Hydrate the per-user submitted-job registry asynchronously from
        // the MMGIS DB. UI renders immediately with whatever in-memory state
        // we have; rows refresh once the fetch returns. Legacy localStorage
        // data (from before this was moved server-side) gets one-time
        // migrated first.
        migrateLegacyLocalStorageRegistry()
            .then(fetchSubmittedRegistry)
            .then((reg) => {
                Object.keys(reg).forEach((jobId) => {
                    if (jobId.startsWith('mock-')) return
                    if (!Workflows.jobs[jobId]) {
                        Workflows.jobs[jobId] = {
                            endpoint: reg[jobId].endpoint || '',
                            payload: reg[jobId].payload,
                            name: reg[jobId].name || '',
                            status: 'unknown',
                            startedAt: reg[jobId].ts || Date.now(),
                        }
                    } else {
                        Workflows.jobs[jobId].payload =
                            Workflows.jobs[jobId].payload ||
                            reg[jobId].payload
                        Workflows.jobs[jobId].endpoint =
                            Workflows.jobs[jobId].endpoint ||
                            reg[jobId].endpoint
                        Workflows.jobs[jobId].name =
                            Workflows.jobs[jobId].name ||
                            reg[jobId].name ||
                            ''
                    }
                })
                Workflows.renderJobs()
            })
    },

    destroy: function () {
        if (Workflows.MMGISInterface)
            Workflows.MMGISInterface.separateFromMMGIS()
        Workflows.MMGISInterface = null
        if (Workflows.pollTimer) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
        }
        if (Workflows.authPollTimer) {
            clearInterval(Workflows.authPollTimer)
            Workflows.authPollTimer = null
        }
    },

    // Opens the workflows API's OAuth login in a popup, then polls
    // auth-status until the session cookie lands (or times out).
    connect: function () {
        const popup = window.open(
            trimSlash(Workflows.baseUrl) + '/api/login',
            'wf_login',
            'width=520,height=720,resizable,scrollbars'
        )
        if (!popup) {
            window.alert(
                'Popup blocked. Allow popups for this site and click Connect again.'
            )
            return
        }
        // Keep the reference so we can close the popup ourselves once
        // auth-status confirms sign-in — the API redirects it to /api/docs
        // and never closes it.
        Workflows._authPopup = popup
        Workflows.startAuthPoll()
    },

    startAuthPoll: function () {
        if (Workflows.authPollTimer) return
        const startedAt = Date.now()
        Workflows.authPollTimer = setInterval(() => {
            if (Date.now() - startedAt > AUTH_POLL_TIMEOUT_MS) {
                clearInterval(Workflows.authPollTimer)
                Workflows.authPollTimer = null
                return
            }
            checkAuth().then((ok) => {
                if (!ok) return
                clearInterval(Workflows.authPollTimer)
                Workflows.authPollTimer = null
                if (Workflows._authPopup) {
                    try {
                        Workflows._authPopup.close()
                    } catch (e) {}
                    Workflows._authPopup = null
                }
                if (typeof Workflows.onAuthReady === 'function')
                    Workflows.onAuthReady()
            })
        }, AUTH_POLL_INTERVAL_MS)
    },

    submit: function (endpointPath, payload, name) {
        return submitJob(endpointPath, payload).then((body) => {
            const jobId = body.job_id || body._id
            if (!jobId) throw new Error('No job_id in response')
            Workflows.jobs[jobId] = {
                endpoint: endpointPath,
                payload: payload,
                name: name || '',
                status: readStatus(body) || 'queued',
                startedAt: Date.now(),
            }
            recordSubmittedJob(jobId, endpointPath, payload, name)
            // Prepend to ordered list and jump to first page so the user
            // sees their submission immediately.
            const i = Workflows.jobIds.indexOf(jobId)
            if (i !== -1) Workflows.jobIds.splice(i, 1)
            Workflows.jobIds.unshift(jobId)
            Workflows.page = 0
            Workflows.ensurePolling()
            Workflows.renderJobs()
            return jobId
        })
    },

    ensurePolling: function () {
        if (Workflows.pollTimer) return
        Workflows.pollTimer = setInterval(
            Workflows.pollAll,
            Workflows.pollIntervalMs
        )
    },

    refreshFromServer: function () {
        return listJobIds()
            .then((ids) => {
                const serverIds = Array.isArray(ids) ? ids.slice() : []
                // Assume server returns oldest-first; show newest-first.
                serverIds.reverse()
                const serverSet = new Set(serverIds)
                // Local-only ids first (sorted newest-first by our timestamp)
                // so freshly submitted jobs stay visible even before the
                // server has them indexed.
                const localOnly = Object.keys(Workflows.jobs)
                    .filter((id) => !serverSet.has(id))
                    .sort(
                        (a, b) =>
                            (Workflows.jobs[b].startedAt || 0) -
                            (Workflows.jobs[a].startedAt || 0)
                    )
                Workflows.jobIds = localOnly.concat(serverIds)
                // Clamp the current page in case the new list is shorter.
                const maxPage = Math.max(
                    0,
                    Math.ceil(Workflows.jobIds.length / PAGE_SIZE) - 1
                )
                if (Workflows.page > maxPage) Workflows.page = maxPage
                // Render the id list immediately (rows show as loading…)
                // so a slow or partially failing detail fetch can't keep
                // the panel stale.
                Workflows.renderJobs()
                return Workflows.fetchPageDetails()
            })
            .then(() => {
                Workflows.renderJobs()
                const hasActive = Object.values(Workflows.jobs).some(
                    (j) => !isTerminal(j.status)
                )
                if (hasActive) Workflows.ensurePolling()
            })
            .catch((err) => {
                console.warn('[WorkflowsTool] refresh failed', err)
            })
    },

    // The job ids currently visible given the text filter (matches run name
    // or workflow id, case-insensitive).
    getVisibleJobIds: function () {
        const f = Workflows.filterText
        if (!f) return Workflows.jobIds
        return Workflows.jobIds.filter((id) => {
            if (id.toLowerCase().indexOf(f) !== -1) return true
            const name = (Workflows.jobs[id] && Workflows.jobs[id].name) || ''
            return name.toLowerCase().indexOf(f) !== -1
        })
    },

    fetchPageDetails: function () {
        const start = Workflows.page * PAGE_SIZE
        const slice = Workflows.getVisibleJobIds().slice(
            start,
            start + PAGE_SIZE
        )
        return Promise.all(
            slice.map((id) =>
                pollJob(id)
                    .then((body) => mergeJobUpdate(id, body))
                    // One bad job must never sink the whole page's render.
                    .catch((err) =>
                        console.warn(
                            `[WorkflowsTool] detail fetch failed for ${id}`,
                            err
                        )
                    )
            )
        )
    },

    goToPage: function (n) {
        const maxPage = Math.max(
            0,
            Math.ceil(Workflows.getVisibleJobIds().length / PAGE_SIZE) - 1
        )
        const target = Math.max(0, Math.min(n, maxPage))
        if (target === Workflows.page) return
        Workflows.page = target
        Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        Workflows.renderJobs() // immediate render with whatever we have
    },

    pollAll: function () {
        const ids = Object.keys(Workflows.jobs).filter(
            (id) => !isTerminal(Workflows.jobs[id].status)
        )
        if (ids.length === 0) {
            clearInterval(Workflows.pollTimer)
            Workflows.pollTimer = null
            return
        }
        ids.forEach((id) => {
            pollJob(id).then((body) => {
                const prev = Workflows.jobs[id]
                if (!prev) return
                const prevStatus = prev.status
                mergeJobUpdate(id, body)
                if (Workflows.jobs[id].status !== prevStatus)
                    Workflows.renderJobs()
            })
        })
    },

    renderJobs: function () {
        const $list = $('#workflowsTool .wf-jobs-list')
        if ($list.length === 0) return
        $list.empty()

        // Bootstrap jobIds from Workflows.jobs the first time renderJobs runs
        // before refreshFromServer has populated the ordered list.
        if (Workflows.jobIds.length === 0) {
            Workflows.jobIds = Object.keys(Workflows.jobs).sort(
                (a, b) =>
                    (Workflows.jobs[b].startedAt || 0) -
                    (Workflows.jobs[a].startedAt || 0)
            )
        }

        const visibleIds = Workflows.getVisibleJobIds()
        const total = visibleIds.length
        if (total === 0) {
            $list.append(
                `<div class="wf-empty">${
                    Workflows.filterText
                        ? 'No jobs match the filter.'
                        : 'No jobs yet.'
                }</div>`
            )
            renderPagination(0, 0, 0)
            return
        }

        const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
        if (Workflows.page >= totalPages) Workflows.page = totalPages - 1
        const start = Workflows.page * PAGE_SIZE
        const pageIds = visibleIds.slice(start, start + PAGE_SIZE)

        pageIds.forEach((id) => {
            const job = Workflows.jobs[id] || { status: 'loading…', endpoint: '' }
            const statusClass = normalizeStatus(job.status) || 'loading'
            const isExpanded = Workflows.expandedIds.has(id)
            const $div = $('<div class="wf-job"></div>')
            // Named runs show just the name (uuid available via tooltip and
            // the expanded drawer); unnamed runs fall back to the uuid.
            const primary = job.name
                ? `<span class="wf-job-name" title="${escapeHTML(
                      id
                  )}">${escapeHTML(job.name)}</span>`
                : `<span class="wf-job-id">${escapeHTML(id)}</span>`
            // Inline visibility checkbox on the tile itself once the layer
            // exists — no need to open the drawer just to toggle. The
            // wf-layer-toggle handler stops propagation, so clicking it
            // doesn't expand/collapse the row.
            const layerExists = L_.layers.data[id] != null
            const tileVisibility = layerExists
                ? `<div class="wf-tile-visibility wf-layer-toggle" data-job-id="${escapeHTML(
                      id
                  )}" title="Toggle layer visibility">` +
                  `<div class="wf-checkbox${
                      L_.layers.on[id] === true ? ' on' : ''
                  }"></div>` +
                  `</div>`
                : ''
            const $header = $(
                `<div class="wf-job-header" data-job-id="${escapeHTML(id)}">` +
                    `<span class="wf-job-chevron">${isExpanded ? '▼' : '▶'}</span> ` +
                    primary + ' ' +
                    `<span class="wf-job-status ${escapeHTML(statusClass)}">${escapeHTML(job.status)}</span>` +
                    tileVisibility +
                    `</div>`
            )
            $div.append($header)
            if (job.endpoint) {
                $div.append(
                    `<div class="wf-job-output" title="${escapeHTML(
                        job.endpoint
                    )}">${escapeHTML(endpointLabel(job.endpoint))}</div>`
                )
            }
            if (job.payload && Object.keys(job.payload).length > 0) {
                // TEMPORARY: file:// values are stripped from display (still
                // sent to the API — see comment on ENDPOINTS).
                const displayEntries = Object.entries(job.payload).filter(
                    ([, v]) => !isFilePathValue(v)
                )
                if (displayEntries.length > 0) {
                    const paramsOpen = Workflows.paramsExpandedIds.has(id)
                    $div.append(
                        `<div class="wf-params-toggle" data-job-id="${escapeHTML(
                            id
                        )}">${paramsOpen ? '▼' : '▶'} parameters (${
                            displayEntries.length
                        })</div>`
                    )
                    if (paramsOpen) {
                        const $params = $('<div class="wf-job-params"></div>')
                        displayEntries.forEach(([k, v]) => {
                            $params.append(
                                `<span class="wf-param-key">${escapeHTML(k)}</span>`
                            )
                            $params.append(
                                `<span class="wf-param-val" title="${escapeHTML(
                                    String(v == null ? '' : v)
                                )}">${escapeHTML(formatParamValue(v))}</span>`
                            )
                        })
                        $div.append($params)
                    }
                }
            }
            if (statusClass === 'running' && job.currentStage) {
                $div.append(
                    `<div class="wf-job-stage">stage: ${escapeHTML(
                        job.currentStage
                    )}</div>`
                )
            }
            if (statusClass === 'failed' && job.error) {
                $div.append(
                    `<div class="wf-job-error">${escapeHTML(job.error)}</div>`
                )
            }
            if (isExpanded) {
                $div.append(buildExpandedSection(job, id))
            }
            $list.append($div)
        })

        renderPagination(Workflows.page, totalPages, total)
    },
}

// Single source of truth for merging a backend response into Workflows.jobs.
// Preserves locally-known fields (the path the user actually submitted, our
// startedAt) and overlays the latest server state. Triggers layer add when
// a job first reaches completed with an output URI.
function mergeJobUpdate(id, body) {
    if (!body || typeof body !== 'object') return
    const existing = Workflows.jobs[id] || {}
    const status = readStatus(body) || existing.status || 'unknown'
    const freshUris = extractOutputUris(body)
    const output_uris =
        freshUris.length > 0
            ? freshUris
            : Array.isArray(existing.output_uris)
              ? existing.output_uris
              : []
    const next = {
        endpoint: readEndpoint(body, existing.endpoint),
        payload: existing.payload, // submitted payload sticks; server doesn't echo it
        name: existing.name || '', // client-side label
        status,
        output_uris,
        autoAddableUri:
            findAutoAddableUri(output_uris) || existing.autoAddableUri,
        currentStage:
            status === 'running' ? readCurrentStage(body) : undefined,
        error: status === 'failed' ? readError(body) : undefined,
        startedAt: existing.startedAt || Date.now(),
        layerAdded: existing.layerAdded,
        body: body, // full latest server response for the expanded view
        fromServer: true,
    }
    Workflows.jobs[id] = next
    // No auto-add: completed jobs with an addable output render an
    // "add as layer" button instead — the user decides what lands on the map.
}

// Compact value renderer for the always-visible params summary. For URI-like
// strings, show just the leaf (filename) — the path prefix is rarely useful
// at a glance and full value is available in the title tooltip + expand.
function formatParamValue(v) {
    if (v == null) return ''
    if (typeof v === 'string') {
        if (/^[a-z]+:\/\//i.test(v)) {
            const i = v.lastIndexOf('/')
            if (i > 0 && i < v.length - 1) return '…/' + v.slice(i + 1)
        }
        if (v.length > 60) return v.slice(0, 12) + '…' + v.slice(-30)
        return v
    }
    return String(v)
}

// Parse an ISO-ish timestamp (the API returns naive UTC like "2026-06-02T23:20:50.586000")
// and render in the user's locale. Falls back to the raw string on bad input.
function formatLocale(iso) {
    if (!iso) return ''
    // The server's naive timestamps don't include a 'Z' suffix; FastAPI emits
    // UTC-but-unmarked. Append Z so Date doesn't interpret as local time.
    const s =
        typeof iso === 'string' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
            ? iso + 'Z'
            : iso
    const d = new Date(s)
    if (isNaN(d.getTime())) return String(iso)
    return d.toLocaleString()
}

function buildExpandedSection(job, jobId) {
    const $exp = $('<div class="wf-job-expanded"></div>')

    // Workflow uuid — hidden on named tiles' headers, so surface it here.
    $exp.append(
        `<div class="wf-exp-uuid" title="Workflow id">${escapeHTML(
            jobId
        )}</div>`
    )

    // Name — editable. Locally-stored (the API has no concept of job names).
    $exp.append('<div class="wf-exp-label">Name</div>')
    const $nameRow = $('<div class="wf-exp-name-row"></div>')
    const $nameInput = $(
        `<input type="text" class="wf-exp-name-input" placeholder="e.g. SF Sept-15 forecast" value="${escapeHTML(
            job.name || ''
        )}" />`
    )
    const $nameSave = $(
        '<button type="button" class="wf-exp-name-save">Save</button>'
    )
    $nameSave.on('click', function () {
        const newName = $nameInput.val().trim()
        // Write onto the CURRENT job object — polling replaces
        // Workflows.jobs[id] wholesale, so the reference this expanded view
        // captured at render time may be stale.
        if (Workflows.jobs[jobId]) Workflows.jobs[jobId].name = newName
        updateJobName(jobId, newName)
        syncLayerName(jobId)
        Workflows.renderJobs()
    })
    $nameInput.on('keydown', function (e) {
        if (e.key === 'Enter') $nameSave.trigger('click')
    })
    $nameRow.append($nameInput).append($nameSave)
    $exp.append($nameRow)

    // Submitted params — only if we know them (locally submitted or hydrated
    // from the persistent registry). TEMPORARY: file:// values stripped.
    if (job.payload && Object.keys(job.payload).length > 0) {
        const display = Object.fromEntries(
            Object.entries(job.payload).filter(
                ([, v]) => !isFilePathValue(v)
            )
        )
        if (Object.keys(display).length > 0) {
            $exp.append('<div class="wf-exp-label">Submitted parameters</div>')
            const $pre = $('<pre class="wf-exp-json"></pre>')
            $pre.text(JSON.stringify(display, null, 2))
            $exp.append($pre)
        }
    } else if (job.fromServer) {
        $exp.append(
            '<div class="wf-exp-hint">No submitted parameters on record (job was likely submitted from elsewhere or before this browser stored them).</div>'
        )
    }

    // Raw output URIs are intentionally NOT listed (s3/internal paths are
    // noise to end users) — just the layer controls for the loadable output.
    {
        const statusClass = normalizeStatus(job.status)
        const visible = L_.layers.on[jobId] === true

        if (statusClass === 'completed' && job.autoAddableUri) {
            // A layer counts as added if we added it this session OR it was
            // persisted to the mission config earlier and came in via the
            // normal config parse on load.
            const added =
                job.layerAdded ||
                L_.layers.data[jobId] != null
            // Two explicit controls: "Add layer" (one-time) and a visibility
            // toggle that's only live once the layer exists on the map.
            const $row = $('<div class="wf-map-btn-row"></div>')
            $row.append(
                `<button type="button" class="wf-map-btn wf-layer-add" data-job-id="${escapeHTML(
                    jobId
                )}"${added ? ' disabled' : ''}>${
                    added ? 'Layer added' : 'Add layer'
                }</button>`
            )
            // Visibility control styled like the Layers panel's filled
            // checkbox. The wf-layer-toggle handler no-ops until the layer
            // actually exists on the map.
            $row.append(
                `<div class="wf-layer-visibility wf-layer-toggle${
                    added ? '' : ' disabled'
                }" data-job-id="${escapeHTML(jobId)}" title="${
                    added
                        ? 'Toggle layer visibility'
                        : 'Add the layer first'
                }">` +
                    `<div class="wf-checkbox${
                        added && visible ? ' on' : ''
                    }"></div>` +
                    `<span>Visible</span>` +
                    `</div>`
            )
            $exp.append($row)
            if (added) {
                $exp.append(
                    `<button type="button" class="wf-map-btn wf-layer-remove" data-job-id="${escapeHTML(
                        jobId
                    )}">Remove layer</button>`
                )
            }
            if (job.persisted === 'pending') {
                $exp.append(
                    '<div class="wf-exp-hint">Saving to mission configuration…</div>'
                )
            } else if (job.persisted === true) {
                $exp.append(
                    '<div class="wf-exp-hint">Saved to mission configuration — persists across reloads.</div>'
                )
            } else if (job.persisted === false) {
                $exp.append(
                    '<div class="wf-exp-hint">Added for this session only — could not save to the mission configuration (this needs mission-edit permission).</div>'
                )
            } else if (added && !job.layerAdded) {
                $exp.append(
                    '<div class="wf-exp-hint">Layer is saved in the mission configuration.</div>'
                )
            }
        } else if (statusClass === 'completed') {
            $exp.append(
                '<div class="wf-exp-hint">This run produced no mappable STAC output.</div>'
            )
        }
    }

    // Server-side metadata, when present.
    const body = job.body
    if (body) {
        if (body.created_at || body.updated_at) {
            $exp.append('<div class="wf-exp-label">Timing</div>')
            const lines = []
            if (body.created_at)
                lines.push(`created: ${formatLocale(body.created_at)}`)
            if (body.updated_at)
                lines.push(`updated: ${formatLocale(body.updated_at)}`)
            $exp.append(
                `<div class="wf-exp-hint">${escapeHTML(lines.join(' · '))}</div>`
            )
        }
        if (Array.isArray(body.stages) && body.stages.length > 0) {
            $exp.append('<div class="wf-exp-label">Stages</div>')
            const $stages = $('<div class="wf-exp-stages"></div>')
            body.stages.forEach((s, i) => {
                const sclass = normalizeStatus(s && s.status) || 'unknown'
                const isCurrent = i === body.current_stage_index
                const $row = $(
                    `<div class="wf-exp-stage ${escapeHTML(sclass)}${
                        isCurrent ? ' current' : ''
                    }">` +
                        `<span class="wf-exp-stage-status">${escapeHTML(
                            s.status || ''
                        )}</span> ` +
                        `<span class="wf-exp-stage-name">${escapeHTML(
                            s.name || ''
                        )}</span>` +
                        (s.subsystem
                            ? ` <span class="wf-exp-stage-sub">[${escapeHTML(
                                  s.subsystem
                              )}]</span>`
                            : '') +
                        `</div>`
                )
                if (s.error_message) {
                    $row.append(
                        `<div class="wf-exp-stage-error">${escapeHTML(
                            s.error_message
                        )}</div>`
                    )
                }
                $stages.append($row)
            })
            $exp.append($stages)
        }
    }

    return $exp
}

function renderPagination(page, totalPages, total) {
    const $container = $('#workflowsTool .wf-pagination')
    if ($container.length === 0) return
    $container.empty()
    if (totalPages <= 1) return
    const $prev = $(
        '<button type="button" class="wf-page-btn wf-page-prev">Prev</button>'
    )
    if (page === 0) $prev.attr('disabled', true)
    $prev.on('click', () => Workflows.goToPage(Workflows.page - 1))
    const $next = $(
        '<button type="button" class="wf-page-btn wf-page-next">Next</button>'
    )
    if (page >= totalPages - 1) $next.attr('disabled', true)
    $next.on('click', () => Workflows.goToPage(Workflows.page + 1))
    const $label = $(
        `<span class="wf-page-label">Page ${page + 1} of ${totalPages} · ${total} jobs</span>`
    )
    $container.append($prev).append($label).append($next)
}

function interfaceWithMMGIS() {
    const tools = $('#toolPanel')
    tools.css({
        background: 'var(--color-k)',
        'box-shadow': 'inset 2px 0px 10px 0px rgba(0,0,0,0.2)',
    })
    tools.empty()
    tools.html('<div id="workflowsTool" class="mmgisScrollbar"></div>')
    const $root = $('#workflowsTool')
    $root.append('<div class="wf-header">Workflows</div>')

    const $authBanner = $('<div id="wf-auth-banner"></div>')
    $root.append($authBanner)

    $root.append('<div class="wf-section-label">Endpoint</div>')
    const $endpointSelect = $('<select id="wf-endpoint-select"></select>')
    const byCategory = ENDPOINTS.reduce((acc, ep) => {
        const cat = ep.category || 'Other'
        ;(acc[cat] = acc[cat] || []).push(ep)
        return acc
    }, {})
    Object.keys(byCategory).forEach((cat) => {
        const $group = $(`<optgroup label="${escapeHTML(cat)}"></optgroup>`)
        byCategory[cat].forEach((ep) => {
            $group.append(
                `<option value="${escapeHTML(ep.path)}">${escapeHTML(
                    ep.label
                )}</option>`
            )
        })
        $endpointSelect.append($group)
    })
    $root.append($endpointSelect)
    $root.append('<div class="wf-endpoint-desc" id="wf-endpoint-desc"></div>')

    $root.append('<div class="wf-section-label">Run Name *</div>')
    const $nameInput = $(
        '<input type="text" id="wf-submit-name" class="wf-name-input" placeholder="e.g. SF Sept-15 forecast (required)" />'
    )
    $root.append($nameInput)
    const $nameWarning = $(
        '<div class="wf-name-warning">Please name this run before submitting.</div>'
    )
    $root.append($nameWarning)
    $nameInput.on('input', function () {
        $nameInput.removeClass('wf-input-error')
        $nameWarning.removeClass('visible')
    })

    $root.append('<div class="wf-section-label">Parameters</div>')
    const $form = $('<div id="wf-form"></div>')
    $root.append($form)

    const $submit = $('<button class="wf-submit" disabled>Loading…</button>')
    $root.append($submit)

    $root.append(
        '<div class="wf-jobs"><div class="wf-jobs-header"><div class="wf-section-label">Jobs</div><button class="wf-refresh-btn" type="button">Refresh</button></div><input type="text" class="wf-jobs-filter" placeholder="Filter by name or id…" spellcheck="false" /><div class="wf-jobs-list"></div><div class="wf-pagination"></div></div>'
    )
    Workflows.renderJobs()

    let filterFetchTimer = null
    $root.find('.wf-jobs-filter').on('input', function () {
        Workflows.filterText = ($(this).val() || '').trim().toLowerCase()
        Workflows.page = 0
        Workflows.renderJobs()
        // Fetch details for the newly visible page, lightly debounced so
        // fast typing doesn't spray requests.
        clearTimeout(filterFetchTimer)
        filterFetchTimer = setTimeout(() => {
            Workflows.fetchPageDetails().then(() => Workflows.renderJobs())
        }, 300)
    })

    $root.find('.wf-refresh-btn').on('click', function () {
        const $btn = $(this)
        $btn.attr('disabled', true).text('Refreshing…')
        Workflows.refreshFromServer().finally(() => {
            $btn.attr('disabled', false).text('Refresh')
        })
    })

    // Click-to-expand on job rows. Delegated so it survives re-renders.
    $root.find('.wf-jobs-list').on('click', '.wf-job-header', function () {
        const id = $(this).attr('data-job-id')
        if (!id) return
        if (Workflows.expandedIds.has(id)) Workflows.expandedIds.delete(id)
        else Workflows.expandedIds.add(id)
        Workflows.renderJobs()
    })

    // Toggle the inline params grid. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-params-toggle', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        if (Workflows.paramsExpandedIds.has(id))
            Workflows.paramsExpandedIds.delete(id)
        else Workflows.paramsExpandedIds.add(id)
        Workflows.renderJobs()
    })

    // Add a completed job's STAC/vector output as a map layer. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-layer-add', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job || !job.autoAddableUri || job.layerAdded) return
        $(this).text('Adding…').attr('disabled', true)
        addLayerForJob(id, job)
    })

    // Remove a run's layer (map + registries + stored config). Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-layer-remove', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const job = Workflows.jobs[id]
        if (!job) return
        if (
            !window.confirm(
                'Remove this layer from the map and the mission configuration?'
            )
        )
            return
        removeLayerForJob(id, job)
    })

    // Toggle layer visibility for a completed job's output. Delegated.
    $root.find('.wf-jobs-list').on('click', '.wf-layer-toggle', function (e) {
        e.preventDefault()
        e.stopPropagation()
        const id = $(this).attr('data-job-id')
        if (!id) return
        const layerObj = L_.layers.data[id]
        if (!layerObj) return
        Promise.resolve(L_.toggleLayer(layerObj)).then(() =>
            Workflows.renderJobs()
        )
    })

    let collectPayload = () => ({})

    function renderSelectedEndpoint() {
        const ep = ENDPOINTS.find(
            (e) => e.path === Workflows.selectedEndpointPath
        )
        if (!ep) return
        $('#wf-endpoint-desc').text(ep.description || ep.label)
        collectPayload = buildForm($form, ep.fields)
    }

    function enableSubmit() {
        Workflows.selectedEndpointPath = ENDPOINTS[0].path
        $endpointSelect.val(Workflows.selectedEndpointPath)
        renderSelectedEndpoint()
        $submit.text('Submit').attr('disabled', false)
    }

    function renderUnauthenticated() {
        $authBanner.empty()
        const $row = $(
            `<div class="wf-auth-msg">Not signed in to ${escapeHTML(
                Workflows.baseUrl
            )}. <a class="wf-signout wf-connect-link" href="#">connect</a></div>`
        )
        $row.find('.wf-connect-link').on('click', function (e) {
            e.preventDefault()
            const $link = $(this)
            $link.text('waiting for sign-in…')
            Workflows.onAuthReady = function () {
                Workflows.onAuthReady = null
                renderAuthenticated()
            }
            Workflows.connect()
        })
        $authBanner.append($row)
        $submit.text('Sign in to continue').attr('disabled', true)
    }

    function renderAuthenticated() {
        $authBanner.empty()
        const $row = $(
            `<div class="wf-auth-ok">Signed in · ${escapeHTML(
                Workflows.baseUrl
            )} <a class="wf-signout" href="#">sign out</a></div>`
        )
        $row.find('.wf-signout').on('click', function (e) {
            e.preventDefault()
            directFetchJSON(
                trimSlash(Workflows.baseUrl) + '/api/logout'
            ).finally(() => renderUnauthenticated())
        })
        $authBanner.append($row)
        enableSubmit()
        // Pull existing jobs from the server so the panel isn't empty on
        // first open of a new session.
        Workflows.refreshFromServer()
    }

    $endpointSelect.on('change', function () {
        Workflows.selectedEndpointPath = $(this).val()
        renderSelectedEndpoint()
    })

    $submit.on('click', function () {
        if (!Workflows.selectedEndpointPath) return
        const name = $nameInput.val().trim()
        if (!name) {
            $nameInput.addClass('wf-input-error').trigger('focus')
            $nameWarning.addClass('visible')
            return
        }
        const payload = collectPayload()
        $submit.attr('disabled', true).text('Submitting…')
        Workflows.submit(Workflows.selectedEndpointPath, payload, name)
            .then(() => {
                $submit.attr('disabled', false).text('Submit')
                $nameInput.val('')
            })
            .catch((err) => {
                $submit.attr('disabled', false).text('Submit')
                window.alert(`Workflows submit failed: ${err.message}`)
            })
    })

    if (!Workflows.baseUrl) {
        $authBanner.append(
            '<div class="wf-auth-msg">No API Base URL configured. Set it in the Configure page under Tools → Workflows.</div>'
        )
        $submit.text('Not configured').attr('disabled', true)
    } else {
        $authBanner.append('<div class="wf-auth-msg">Checking sign-in…</div>')
        checkAuth().then((ok) => {
            if (ok) renderAuthenticated()
            else renderUnauthenticated()
        })
    }

    this.separateFromMMGIS = function () {}
}

export default Workflows
