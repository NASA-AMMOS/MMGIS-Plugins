const express = require("express");
const router = express.Router();

/**
 * Sanitizes user input to prevent XSS attacks.
 * Based on the pattern used in API/Backend/Config/routes/configs.js
 */
function sanitizeInput(input) {
    if (typeof input !== "string") return String(input);
    return input.replace(/[<>'"&]/g, function (match) {
        switch (match) {
            case "<": return "&lt;";
            case ">": return "&gt;";
            case '"': return "&quot;";
            case "'": return "&#x27;";
            case "&": return "&amp;";
            default: return match;
        }
    });
}

// GET /api/mapjobsubmit-history
// Returns all job submissions for the authenticated user, ordered newest first.
// MMGIS uses the username string directly as the identity field; no FK.

router.get("/", async (req, res) => {
    const maapUserId = req.query.maap_user_id;

    try {
        // Lazy load model to avoid initialization order issues
        const { JobSubmissions } = require("../models/jobSubmissions");
        if (!JobSubmissions) {
            return res.status(500).send({
                status: "failure",
                message: "JobSubmissions model not initialized yet"
            });
        }

        const where = { username: req.user };
        // If maap_user_id is provided, filter by it
        if (maapUserId) {
            where.maap_user_id = maapUserId;
        }

        const rows = await JobSubmissions.findAll({
            where,
            order: [["created_on", "DESC"]],
        });
        res.send({
            status: "success",
            message: "Retrieved job submission history",
            body: rows.map((r) => ({
                id: r.id,
                username: r.username,
                maap_user_id: r.maap_user_id,
                workflow_id: r.workflow_id,
                endpoint: r.endpoint,
                payload: r.payload,
                name: r.name,
                created_on: r.created_on,
            })),
        });
    } catch (err) {
        console.error("Error fetching job submissions:", err);
        res.status(500).send({
            status: "failure",
            message: "Failed to fetch job submission history",
            error: err.message,
        });
    }
});

router.post("/", async (req, res) => {
    const { workflow_id, endpoint, payload, name, maap_user_id } = req.body || {};
    if (!workflow_id || typeof workflow_id !== "string") {
        return res
            .status(400)
            .send({ status: "failure", message: "workflow_id is required" });
    }

    // Sanitize string inputs to prevent XSS
    const sanitizedName = name ? sanitizeInput(name) : null;
    const sanitizedEndpoint = endpoint ? sanitizeInput(endpoint) : null;
    const sanitizedMaapUserId = maap_user_id ? sanitizeInput(maap_user_id) : null;

    try {
        // Lazy load model to avoid initialization order issues
        const { JobSubmissions } = require("../models/jobSubmissions");
        if (!JobSubmissions) {
            return res.status(500).send({
                status: "failure",
                message: "JobSubmissions model not initialized yet"
            });
        }

        const [row, created] = await JobSubmissions.findOrCreate({
            where: { username: req.user, workflow_id },
            defaults: {
                maap_user_id: sanitizedMaapUserId,
                endpoint: sanitizedEndpoint,
                payload: payload || null,
                name: sanitizedName,
            },
        });
        if (!created) {
            // Preserve existing endpoint/payload if we already have them;
            // only fill blanks or update the name/maap_user_id.
            const updates = {};
            if (name !== undefined) updates.name = sanitizedName;
            if (maap_user_id !== undefined) updates.maap_user_id = sanitizedMaapUserId;
            if (endpoint && !row.endpoint) updates.endpoint = sanitizedEndpoint;
            if (payload && !row.payload) updates.payload = payload;
            if (Object.keys(updates).length > 0) await row.update(updates);
        }
        res.send({
            status: "success",
            message: created ? "Job submission recorded" : "Job submission updated",
            body: { id: row.id },
        });
    } catch (err) {
        console.error("Error recording job submission:", err);
        res.status(500).send({
            status: "failure",
            message: "Failed to record job submission",
            error: err.message,
        });
    }
});

// DELETE /api/mapjobsubmit-history/:workflowId
// Deletes a job submission from the MMGIS database (not from MAAP)
router.delete("/:workflowId", async (req, res) => {
    const workflowId = req.params.workflowId;

    if (!workflowId) {
        return res.status(400).send({
            status: "failure",
            message: "workflowId is required"
        });
    }

    try {
        // Lazy load model to avoid initialization order issues
        const { JobSubmissions } = require("../models/jobSubmissions");
        if (!JobSubmissions) {
            return res.status(500).send({
                status: "failure",
                message: "JobSubmissions model not initialized yet"
            });
        }

        // Delete the job submission for this user and workflow_id
        const deleted = await JobSubmissions.destroy({
            where: {
                username: req.user,
                workflow_id: workflowId
            }
        });

        if (deleted === 0) {
            return res.status(404).send({
                status: "failure",
                message: "Job submission not found"
            });
        }

        res.send({
            status: "success",
            message: "Job submission deleted",
            body: { workflow_id: workflowId }
        });
    } catch (err) {
        console.error("Error deleting job submission:", err);
        res.status(500).send({
            status: "failure",
            message: "Failed to delete job submission",
            error: err.message
        });
    }
});

module.exports = router;
