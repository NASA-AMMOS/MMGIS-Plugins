const jobSubmitRouter = require("./routes/jobSubmit");
const submissionsRouter = require("./routes/submissions");
const { up } = require("./models/jobSubmissions");
const logger = require("../../../../API/logger");

// MapJobSubmit backend routes for proxying requests to external workflows API
// to avoid CORS issues, plus per-user job history storage.

let setup = {
    onceInit: (s) => {
        const proxyPath = s.ROOT_PATH + "/api/mapjobsubmit";
        logger("info", `Registering MapJobSubmit proxy route at: ${proxyPath}`, "MapJobSubmit");
        // Proxy endpoint for fetching processes (no auth required)
        s.app.use(
            proxyPath,
            s.checkHeadersCodeInjection,
            s.setContentType,
            jobSubmitRouter
        );

        // Per-user job history endpoint (requires auth)
        const historyPath = s.ROOT_PATH + "/api/mapjobsubmit-history";
        logger("info", `Registering MapJobSubmit history route at: ${historyPath}`, "MapJobSubmit");
        s.app.use(
            historyPath,
            s.ensureUser(),
            s.checkHeadersCodeInjection,
            s.setContentType,
            submissionsRouter
        );
    },
    onceStarted: (s) => {},
    onceSynced: (s) => {
        logger("info", "MapJobSubmit onceSynced called, initializing model...", "MapJobSubmit");
        if (typeof up === "function") {
            up();
        } else {
            logger("error", "up() function is not available!", "MapJobSubmit");
        }
    },
};

module.exports = setup;
