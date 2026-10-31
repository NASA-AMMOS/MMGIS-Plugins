// Resolves packages from the MMGIS installation (process.cwd() is the MMGIS
// root when the server runs) instead of this plugin's private node_modules,
// so routers are built with the same Express instance as the host app.

function requireFromMmgis(name) {
  try {
    return require(require.resolve(name, { paths: [process.cwd()] }));
  } catch (_) {
    return require(name);
  }
}

module.exports = { requireFromMmgis };
