"use strict";

const Ajv = require("ajv");
const addFormats = require("ajv-formats");

function createAgentAjv(options = {}) {
  const ajv = new Ajv({ strict: false, ...options });
  addFormats(ajv);
  return ajv;
}

module.exports = { createAgentAjv };
