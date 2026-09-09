# Agent action catalog and transport

AgentChat owns a fixed catalog of optional-tool adapters. Each entry pairs a
model-facing JSON Schema with a handler and a live availability predicate.
`ToolController_` supplies the mission's configured and loaded tools and their
open state. Analysis and Animation do not import or register with Agent.
The catalog is private to AgentChat; it is not part of `window.mmgisAPI`.

The browser sends available descriptors in `context.runtimeCapabilities` on
each turn. Agent merges these with the static registry (static names win),
rewrites execution to its client adapter, validates model arguments with Ajv,
and correlates each returned result with its pending model call. Executable
handlers never cross the HTTP boundary. The client rechecks availability and
arguments immediately before dispatch. Handler execution has a 10-second
timeout with an abort signal, and results are limited to 64 KiB. Async Analysis
catalog loading checks cancellation and panel state before changing inputs.
Synchronous plugin code cannot be preempted by a browser timeout.

JSON Schemas are preserved rather than rewritten into a custom dialect. Ajv
with `ajv-formats` supports local `$ref`, `pattern`, standard formats, and composition (`oneOf`, `anyOf`, `allOf`).
Invalid schemas reject the request with `InvalidRuntimeCapabilities`. Names,
metadata, schema bytes and depth remain bounded as Agent request I/O budgets:
at most 128 actions, 64-character names, 32 KiB per schema, 12 JSON container
levels, 256 properties per object, 128-character property names, and 128 enum
values. Analytics lists have at most 32 entries of 64 characters. These limits
bound model context and processing; installed plugins are trusted host code.

`tests/fixtures/runtime-capability-transport.v1.json` retains a compatible
transport example. Tests also cover normal JSON Schema references and patterns,
optional-tool discovery, cancellation, timeout, ambiguous Analysis keys, and
successful calls to the unchanged Analysis methods.

## Validation

Install this repository under `plugins/NASA-AMMOS--MMGIS-Plugins` in a current
MMGIS `development` checkout with the typed-authentication change applied,
then run `npm run plugins:install`. From the host root:

```bash
npx cross-env PLAYWRIGHT_TEST_UNIT_ONLY=true playwright test plugins/NASA-AMMOS--MMGIS-Plugins/backend/Agent/tests plugins/NASA-AMMOS--MMGIS-Plugins/tools/AgentChat/tests --grep @unit --project=chromium
npx cross-env PLAYWRIGHT_TEST_UNIT_ONLY=true MMGIS_RUN_RASTER_INTEGRATION=true playwright test plugins/NASA-AMMOS--MMGIS-Plugins/backend/Agent/tests --grep @integration --workers=1 --project=chromium
```

Raster validation needs the manifest-generated Python dependencies (Python 3.12,
`numpy==2.1.0`, `rasterio==1.5.1`). Set `MMGIS_PYTHON` to that interpreter.
The raster fixtures must run serially on Windows. Tests live with their plugins.
This repository does not assemble a pinned host from fork commits in CI.
Host integration CI should use real `development` after the auth PR is merged.
