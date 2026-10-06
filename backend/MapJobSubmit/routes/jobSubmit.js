const express = require("express");
const router = express.Router();
const logger = require("../../../../../API/logger");

/**
 * Helper function to proxy a request to an external API with optional auth header.
 * Handles common error cases and logging.
 *
 * @param {Object} options - Configuration options
 * @param {string} options.url - Target URL to proxy to
 * @param {string} options.method - HTTP method (GET, POST, etc.)
 * @param {Object} options.headers - Additional headers to send
 * @param {Object} options.body - Request body (for POST requests)
 * @param {string} options.proxyTicket - Optional proxy ticket for authentication
 * @param {Object} options.req - Express request object for logging
 * @param {Object} options.res - Express response object
 * @param {string} options.errorContext - Context string for error messages
 */
async function proxyRequest({ url, method = 'GET', headers = {}, body, proxyTicket, req, res, errorContext }) {
    try {
        logger("info", `Proxying request to: ${url}`, req.originalUrl, req);

        const requestHeaders = {
            'Accept': 'application/json',
            ...headers,
        };

        // Forward x-proxy-ticket header as proxy-ticket to external API
        if (proxyTicket) {
            requestHeaders['proxy-ticket'] = proxyTicket;
        }

        const fetchOptions = {
            method,
            headers: requestHeaders,
        };

        if (body && method !== 'GET') {
            fetchOptions.body = JSON.stringify(body);
            requestHeaders['Content-Type'] = 'application/json';
        }

        const response = await fetch(url, fetchOptions);

        if (!response.ok) {
            // Try to get the actual error message from the API response
            let errorData;
            try {
                errorData = await response.json();
            } catch (jsonErr) {
                // If JSON parsing fails, try text
                try {
                    const responseText = await response.text();
                    errorData = { detail: responseText || response.statusText || 'Unknown error' };
                } catch (textErr) {
                    errorData = { detail: response.statusText || 'Unknown error' };
                }
            }

            logger(
                "error",
                `${errorContext} - API returned ${response.status}: ${JSON.stringify(errorData)}`,
                req.originalUrl,
                req
            );

            // Return the actual API error to the client with the original status code
            return res.status(response.status).send({
                status: "failure",
                message: errorContext,
                apiError: errorData,
                statusCode: response.status
            });
        }

        const data = await response.json();
        return res.json(data);
    } catch (err) {
        logger("error", errorContext, req.originalUrl, req, err);
        return res.status(500).send({
            status: "failure",
            message: errorContext,
            error: err.message
        });
    }
}

// Proxy endpoint to fetch processes from the workflows API.
// Solves CORS issues by making the request server-side.
router.get("/processes", async (req, res) => {
    const baseUrl = req.query.baseUrl;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    const url = baseUrl.replace(/\/+$/, '') + '/processes';
    await proxyRequest({
        url,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to fetch processes from workflows API"
    });
});

// Proxy endpoint to fetch details for a specific process by processID.
// Returns the full process schema including inputs.
router.get("/processes/:processID", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const processID = req.params.processID;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!processID) {
        return res.status(400).send({
            status: "failure",
            message: "processID is required"
        });
    }

    const url = baseUrl.replace(/\/+$/, '') + `/processes/${processID}`;
    await proxyRequest({
        url,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to fetch process details from workflows API"
    });
});

// Proxy endpoint to submit/execute a workflow job.
router.post("/processes/:processID/execution", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const processID = req.params.processID;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!processID) {
        return res.status(400).send({
            status: "failure",
            message: "processID is required"
        });
    }

    const url = baseUrl.replace(/\/+$/, '') + `/processes/${processID}/execution`;
    await proxyRequest({
        url,
        method: 'POST',
        body: req.body,
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to submit job to Workflows API"
    });
});

// Proxy endpoint to get current user info from MAAP API
router.get("/members/self", async (req, res) => {
    const memberInfoUrl = req.query.memberInfoUrl; // Full URL to the member info endpoint

    if (!memberInfoUrl) {
        return res.status(400).send({
            status: "failure",
            message: "memberInfoUrl query parameter is required"
        });
    }

    // Validate that it's a full URL
    if (!/^https?:\/\//i.test(memberInfoUrl)) {
        return res.status(400).send({
            status: "failure",
            message: "memberInfoUrl must be a full URL (starting with http:// or https://)"
        });
    }

    if (!req.headers['x-proxy-ticket']) {
        logger("warn", `No proxy-ticket header received from client for member info endpoint: ${memberInfoUrl}`, req.originalUrl, req);
    }

    await proxyRequest({
        url: memberInfoUrl,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: `Failed to fetch user info from member endpoint: ${memberInfoUrl}`
    });
});

// Proxy endpoint to get user jobs
router.get("/jobs", async (req, res) => {
    const baseUrl = req.query.baseUrl;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!req.headers['x-proxy-ticket']) {
        logger("warn", `No proxy-ticket header received from client`, req.originalUrl, req);
    }

    const url = baseUrl.replace(/\/+$/, '') + `/jobs`;
    await proxyRequest({
        url,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to fetch jobs from Workflows API"
    });
});

// Proxy endpoint to poll a specific job by ID
router.get("/jobs/:jobId", async (req, res) => {
    const baseUrl = req.query.baseUrl;
    const jobId = req.params.jobId;
    const getJobDetails = req.query.getJobDetails;

    if (!baseUrl) {
        return res.status(400).send({
            status: "failure",
            message: "baseUrl query parameter is required"
        });
    }

    if (!jobId) {
        return res.status(400).send({
            status: "failure",
            message: "jobId is required"
        });
    }

    let url = baseUrl.replace(/\/+$/, '') + `/jobs/${encodeURIComponent(jobId)}`;

    // Add getJobDetails query parameter if provided
    if (getJobDetails) {
        url += `?getJobDetails=${encodeURIComponent(getJobDetails)}`;
    }

    await proxyRequest({
        url,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to fetch job details from MAAP API"
    });
});

// Proxy endpoint to fetch available algorithm resources/queues
router.get("/resources", async (req, res) => {
    const resourcesUrl = req.query.resourcesUrl; // Full URL to resources endpoint

    if (!resourcesUrl) {
        return res.status(400).send({
            status: "failure",
            message: "resourcesUrl query parameter is required"
        });
    }

    if (!req.headers['x-proxy-ticket']) {
        logger("warn", `No proxy-ticket header received from client for resources endpoint`, req.originalUrl, req);
    }

    await proxyRequest({
        url: resourcesUrl,
        method: 'GET',
        proxyTicket: req.headers['x-proxy-ticket'],
        req,
        res,
        errorContext: "Failed to fetch resources from API"
    });
});

module.exports = router;
