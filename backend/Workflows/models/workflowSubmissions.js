/*
CREATE TABLE workflow_submissions(
    id SERIAL UNIQUE NOT NULL PRIMARY KEY,
    username VARCHAR(255) NOT NULL,
    workflow_id VARCHAR(255) NOT NULL,
    endpoint VARCHAR(500),
    payload JSON,
    name VARCHAR(255),
    created_on TIMESTAMP NOT NULL,
    updated_on TIMESTAMP NOT NULL,
    UNIQUE(username, workflow_id)
) WITH (
    OIDS = FALSE
)
TABLESPACE pg_default;

ALTER TABLE workflow_submissions OWNER to postgres;

Per-user record of jobs submitted via the Workflows tool. Holds the submit-
time inputs (endpoint + payload) so the user can see what they sent after
reload, and a client-side display name. The workflows API itself has no
notion of these — it's purely MMGIS-side metadata.
*/

const Sequelize = require("sequelize");
const { sequelize } = require("../../../../../API/connection");
const logger = require("../../../../../API/logger");
require("dotenv").config();

const attributes = {
    username: {
        type: Sequelize.STRING,
        allowNull: false,
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
};

const options = {
    timestamps: true,
    createdAt: "created_on",
    updatedAt: "updated_on",
    indexes: [
        { fields: ["username"] },
        { unique: true, fields: ["username", "workflow_id"] },
    ],
};

const WorkflowSubmissions = sequelize.define(
    "workflow_submissions",
    attributes,
    options
);

// Reserved hook for future ALTER TABLE migrations, mirrored from the
// pattern used by Draw/userfiles.js.
const up = async () => {};

module.exports = { WorkflowSubmissions, up };
