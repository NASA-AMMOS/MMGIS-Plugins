const router = require("./routes/submissions");
const { up } = require("./models/workflowSubmissions");

// MMGIS-side store for per-user Workflows-tool job history. Holds the
// endpoint/payload/name a user submitted from any browser they sign in from,
// so they see the same history across devices. The workflows API has no
// concept of these — they're purely client-side metadata moved off
// localStorage and into the MMGIS Postgres database.

let setup = {
    onceInit: (s) => {
        s.app.use(
            s.ROOT_PATH + "/api/workflows-history",
            s.ensureUser(),
            s.checkHeadersCodeInjection,
            s.setContentType,
            router
        );
    },
    onceStarted: (s) => {},
    onceSynced: (s) => {
        if (typeof up === "function") up();
    },
};

module.exports = setup;
