const express = require("express");
const router = express.Router();

const logger = require("../../../../../API/logger");
const { WorkflowSubmissions } = require("../models/workflowSubmissions");

// All routes are scoped to req.user — set by ensureUser() in setup.js.
// MMGIS uses the username string directly as the identity field; no FK.

router.get("/", async (req, res) => {
    try {
        const rows = await WorkflowSubmissions.findAll({
            where: { username: req.user },
            order: [["created_on", "DESC"]],
        });
        res.send({
            status: "success",
            body: rows.map((r) => r.toJSON()),
        });
    } catch (err) {
        logger(
            "error",
            "Failed to list workflow submissions",
            req.originalUrl,
            req,
            err
        );
        res
            .status(500)
            .send({ status: "failure", message: "Failed to list submissions" });
    }
});

router.post("/", async (req, res) => {
    const { workflow_id, endpoint, payload, name } = req.body || {};
    if (!workflow_id || typeof workflow_id !== "string") {
        return res
            .status(400)
            .send({ status: "failure", message: "workflow_id is required" });
    }
    try {
        const [row, created] = await WorkflowSubmissions.findOrCreate({
            where: { username: req.user, workflow_id },
            defaults: {
                endpoint: endpoint || null,
                payload: payload || null,
                name: name || null,
            },
        });
        if (!created) {
            // Preserve existing endpoint/payload if we already have them;
            // only fill blanks or update the name.
            const updates = {};
            if (name !== undefined) updates.name = name || null;
            if (endpoint && !row.endpoint) updates.endpoint = endpoint;
            if (payload && !row.payload) updates.payload = payload;
            if (Object.keys(updates).length > 0) await row.update(updates);
        }
        res.send({ status: "success", body: row.toJSON() });
    } catch (err) {
        logger(
            "error",
            "Failed to save workflow submission",
            req.originalUrl,
            req,
            err
        );
        res
            .status(500)
            .send({ status: "failure", message: "Failed to save submission" });
    }
});

router.post("/rename", async (req, res) => {
    const { workflow_id, name } = req.body || {};
    if (!workflow_id || typeof workflow_id !== "string") {
        return res
            .status(400)
            .send({ status: "failure", message: "workflow_id is required" });
    }
    try {
        const [count] = await WorkflowSubmissions.update(
            { name: name || null },
            { where: { username: req.user, workflow_id } }
        );
        res.send({ status: "success", body: { updated: count } });
    } catch (err) {
        logger(
            "error",
            "Failed to rename workflow submission",
            req.originalUrl,
            req,
            err
        );
        res
            .status(500)
            .send({ status: "failure", message: "Failed to rename submission" });
    }
});

module.exports = router;
