// API communication and data services - all external service interactions

// ============================================================================
// Network Helpers
// ============================================================================

export function mmgisUrl(path) {
    const root =
        (window.mmgisglobal && window.mmgisglobal.ROOT_PATH) || ''
    return (root ? root + '/' : '') + path.replace(/^\//, '')
}

export function mmgisFetch(path, init, personalAccessToken) {
    const headers = {
        Accept: 'application/json',
        ...((init && init.headers) || {}),
    }

    // Add x-proxy-ticket header if token is available
    if (personalAccessToken) {
        headers['x-proxy-ticket'] = personalAccessToken
    }

    return fetch(mmgisUrl(path), {
        credentials: 'same-origin',
        ...init,
        headers: headers,
    })
}

// ============================================================================
// Authentication
// ============================================================================

// Verify the personal access token by calling the /jobs endpoint.
export function verifyToken(baseUrl, personalAccessToken) {
    const proxyUrl = 'api/mapjobsubmit/jobs?baseUrl=' + encodeURIComponent(baseUrl)
    return mmgisFetch(proxyUrl, {}, personalAccessToken)
        .then((r) => {
            if (r.status === 403) {
                console.warn('[MapJobSubmitTool] Token verification failed: 403 Forbidden')
                return false
            }
            if (!r.ok) {
                console.warn('[MapJobSubmitTool] Token verification failed:', r.status)
                return false
            }
            return r.json()
        })
        .then((data) => {
            if (data === false) return false
            return true
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] verifyToken failed', err)
            return false
        })
}

// Fetch the MAAP user ID from the configured member info endpoint
export function fetchMaapUserId(memberInfoUrl, personalAccessToken) {
    if (!memberInfoUrl) {
        console.error('[MapJobSubmitTool] memberInfoUrl not configured')
        return Promise.resolve(null)
    }
    const proxyUrl = 'api/mapjobsubmit/members/self?memberInfoUrl=' + encodeURIComponent(memberInfoUrl)
    return mmgisFetch(proxyUrl, {}, personalAccessToken)
        .then((r) => {
            if (!r.ok) {
                console.warn('[MapJobSubmitTool] Failed to fetch user ID:', r.status)
                return null
            }
            return r.json()
        })
        .then((data) => {
            if (!data || !data.id) {
                console.warn('[MapJobSubmitTool] No user ID in response:', data)
                return null
            }
            return data.id
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchMaapUserId failed', err)
            return null
        })
}

// ============================================================================
// Workflow/Process Operations
// ============================================================================

// Fetch the list of available algorithms/processes from the workflows API.
export function fetchProcesses(baseUrl) {
    const proxyUrl = 'api/mapjobsubmit/processes?baseUrl=' + encodeURIComponent(baseUrl)
    return mmgisFetch(proxyUrl)
        .then((r) => r.json())
        .then((data) => {
            if (!data || !Array.isArray(data.processes)) {
                console.warn('[MapJobSubmitTool] /processes returned invalid shape:', data)
                return []
            }
            return data.processes
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchProcesses failed', err)
            return []
        })
}

// Fetch details for a specific process including its input schema.
export function fetchProcessDetails(processID, baseUrl) {
    const proxyUrl = `api/mapjobsubmit/processes/${processID}?baseUrl=` + encodeURIComponent(baseUrl)
    return mmgisFetch(proxyUrl)
        .then((r) => r.json())
        .then((data) => {
            return data
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] fetchProcessDetails failed', err)
            return null
        })
}

// Fetch or parse available algorithm resources/queues based on configuration.
export function fetchResources(resourcesConfig, personalAccessToken) {
    // Mode 1: No configuration - queues disabled
    if (!resourcesConfig || resourcesConfig.trim() === '') {
        return Promise.resolve(null)
    }

    // Mode 2: URL - fetch from API
    if (/^https?:\/\//i.test(resourcesConfig)) {
        const proxyUrl = 'api/mapjobsubmit/resources?resourcesUrl=' + encodeURIComponent(resourcesConfig)
        return mmgisFetch(proxyUrl, {}, personalAccessToken)
            .then((r) => r.json())
            .then((data) => {
                // API returns { code, message, queues: [...] }
                if (data && Array.isArray(data.queues)) {
                    return data.queues
                }
                console.warn('[MapJobSubmitTool] No queues array in response:', data)
                return []
            })
            .catch((err) => {
                console.warn('[MapJobSubmitTool] fetchResources failed', err)
                return []
            })
    }

    // Mode 3: Comma-separated list - parse as static array
    const queues = resourcesConfig.split(',')
        .map(q => q.trim())
        .filter(q => q.length > 0)
    return Promise.resolve(queues)
}

// ============================================================================
// Job Operations
// ============================================================================

// Poll a specific job's status through the MMGIS proxy
export function pollJob(jobId, baseUrl, personalAccessToken, getJobDetails) {
    let proxyUrl = `api/mapjobsubmit/jobs/${encodeURIComponent(jobId)}?baseUrl=` + encodeURIComponent(baseUrl)

    // Add getJobDetails parameter if requested
    if (getJobDetails) {
        proxyUrl += `&getJobDetails=true`
    }

    return mmgisFetch(proxyUrl, {}, personalAccessToken)
        .then((r) => {
            if (!r.ok) {
                // Return the status so we can handle 404 vs other errors
                return r.json().catch(() => ({ error: true, status: r.status, statusText: r.statusText }))
            }
            return r.json()
        })
        .then((data) => {
            // Check if this is an error response
            if (data && data.error && data.status) {
                throw new Error(`HTTP ${data.status}: ${data.statusText || 'Job not found'}`)
            }
            return data || {}
        })
        .catch((err) => {
            console.warn('[MapJobSubmitTool] pollJob failed for', jobId, err)
            throw err
        })
}

// ============================================================================
// Job History Database Operations
// ============================================================================

// Returns { [workflow_id]: { endpoint, payload, name, ts } }
export function fetchSubmittedRegistry(maapUserId, personalAccessToken) {
    // Include maap_user_id query param to filter by MAAP user
    const url = maapUserId
        ? `api/mapjobsubmit-history?maap_user_id=${encodeURIComponent(maapUserId)}`
        : 'api/mapjobsubmit-history'
    return mmgisFetch(url, {}, personalAccessToken)
        .then((r) => r.json())
        .then((d) => {
            if (!d || d.status !== 'success' || !Array.isArray(d.body)) {
                console.warn('[MapJobSubmitTool] Invalid registry response format:', d)
                return {}
            }
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
        .catch((err) => {
            console.error('[MapJobSubmitTool] Failed to fetch registry:', err)
            return {}
        })
}

export function recordSubmittedJob(jobId, endpoint, payload, name, maapUserId, personalAccessToken) {
    return mmgisFetch('api/mapjobsubmit-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            workflow_id: jobId,
            maap_user_id: maapUserId || null,
            endpoint,
            payload,
            name: name || '',
        }),
    }, personalAccessToken)
        .then((r) => r.json())
        .then((data) => {
            if (data && data.status === 'success') {
                return data
            }
            throw new Error('Failed to record job')
        })
}

export function deleteJobFromDatabase(jobId, personalAccessToken) {
    return mmgisFetch(`api/mapjobsubmit-history/${encodeURIComponent(jobId)}`, {
        method: 'DELETE',
    }, personalAccessToken)
        .then((r) => r.json())
        .then((data) => {
            if (data && data.status === 'success') {
                return data
            }
            throw new Error(data.message || 'Failed to delete job')
        })
        .catch((err) => {
            console.error('[MapJobSubmitTool] Failed to delete job from DB:', err)
            throw err
        })
}
