/*
CREATE TABLE job_submissions(
    id SERIAL UNIQUE NOT NULL PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    maap_user_id VARCHAR(255),
    workflow_id VARCHAR(255) NOT NULL,
    endpoint VARCHAR(500),
    payload JSON,
    name VARCHAR(255),
    created_on TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_submissions_username ON job_submissions(username);
CREATE INDEX idx_job_submissions_maap_user_id ON job_submissions(maap_user_id);
CREATE INDEX idx_job_submissions_workflow_id ON job_submissions(workflow_id);
*/

/*
Per-user record of jobs submitted via the MapJobSubmit tool. Holds the submit-
time inputs (endpoint + payload) so the user can see what they sent after
reload, and a client-side display name. The workflows API itself has no
notion of these — it's purely MMGIS-side metadata.

maap_user_id is the MAAP user ID from /api/members/self, used to filter
jobs by MAAP user (not MMGIS username) since PAT auth is per-MAAP-user.
*/

const Sequelize = require("sequelize");

const attributes = {
    username: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    maap_user_id: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    workflow_id: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    endpoint: {
        type: Sequelize.STRING(500),
        allowNull: true,
    },
    payload: {
        type: Sequelize.JSON,
        allowNull: true,
    },
    name: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    created_on: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
    },
};

const options = {
    tableName: "job_submissions",
    timestamps: false,
    indexes: [
        { fields: ["username"] },
        { fields: ["maap_user_id"] },
        { fields: ["workflow_id"] },
    ],
};

let JobSubmissions;

module.exports = {
    attributes,
    options,
    get JobSubmissions() {
        return JobSubmissions;
    },
    up: async function () {
        const { sequelize } = require("../../../../../API/connection");
        console.log("[JobSubmissions] up() called, sequelize:", !!sequelize);
        if (!sequelize) {
            console.error("[JobSubmissions] sequelize is undefined!");
            return;
        }

        JobSubmissions = sequelize.define("JobSubmissions", attributes, options);
        
        try {
            await JobSubmissions.sync();
            console.log("[JobSubmissions] Model synced successfully");
        } catch (err) {
            console.error("Error syncing JobSubmissions model:", err);
        }
    },
};
