# MMGIS-Plugins

Official plugin collection for [MMGIS](https://github.com/NASA-AMMOS/MMGIS) — vetted tools, backends, and components maintained by the MMGIS team.

## Installation

```bash
# From within your MMGIS installation:
npm run plugins -- install https://github.com/NASA-AMMOS/MMGIS-Plugins.git

# Or install only specific plugins:
npm run plugins -- install MMGIS-Plugins --only PluginA,PluginB

# Then install plugin dependencies and rebuild:
npm run plugins:install
npm run build
```

## Available Plugins

| Plugin    | Type    | Tier         | Description                                                                             | Notes                             |
| --------- | ------- | ------------ | ---------------------------------------------------------------------------------------- | ---------------------------------- |
| Agent     | backend | experimental | AI Agent backend — LLM providers (Azure AI Foundry, Gemini), generic MMGIS tool registry, and REST routes exposed at /api/agent. |  |
| AgentChat | tool    | experimental | Natural-language chat panel that sends queries to the Agent backend and renders tool-call results directly on the map. | Requires the Agent backend plugin. |
| Analysis  | tool    | experimental | A graphing and analysis tool for data visualization and statistical analysis.             | Backend server not yet released.  |
| Chemistry | tool    | official     | Display chemistry percentages via graphs of a clicked point.                             |                                    |
| Isochrone | tool    | official     | Find the range of locations accessible to an explorer within a given time                |                                    |
| Segment   | tool    | experimental | Segment map features using SAM3 AI model with text prompts.                              | Backend server not yet released.  |
| Workflows | tool, backend | experimental | Submit jobs to an external workflows API and add completed runs' outputs as map layers. | Requires an external workflows API; set its base URL in the tool's configuration. |

### Agent API

**POST /api/agent?mission=MISSION** returns a nonblank reply plus zero or
more validated actions. The client executes those actions and submits bounded
structured results to **POST /api/agent/continue?mission=MISSION** using
**conversationId**, **responseId**, **toolResults**, and **context**. Azure-native
actions carry a **callId**; JSON-plan actions do not.

Clients and plugins may advertise declarative capabilities in
**context.runtimeCapabilities** (the compatibility aliases
**context.capabilities**, **context.runtime_capabilities**, and **context.tools**
are also accepted). Their names, descriptions, category/plugin metadata, and
JSON parameter schemas are sanitized and merged with the static registry for
that request. These capabilities always execute in the MMGIS client; the Agent
backend never accepts executable code.

Agent routes always run MMGIS **ensureUserForApi**. The host guard preserves
the explicit public **AUTH=none**/**AUTH=off** modes; protected modes validate
the current session or a strict bearer token and return typed HTTP 401 JSON
instead of login HTML or legacy HTTP-200 failure envelopes. Authentication
infrastructure outages return a typed HTTP 503 response.

The real Rasterio comparison harness is intentionally serialized (GDAL/PROJ
initialization is not reliable under parallel local Windows workers). From the
MMGIS host root, run:

```bash
npx cross-env PLAYWRIGHT_TEST_UNIT_ONLY=true MMGIS_RUN_RASTER_INTEGRATION=true playwright test plugins/NASA-AMMOS--MMGIS-Plugins/backend/Agent/tests/rasterDifference.spec.js plugins/NASA-AMMOS--MMGIS-Plugins/backend/Agent/tests/rasterStatistics.spec.js --grep @integration --workers=1 --project=chromium
```

Raster statistics use a bounded auto policy. Selected windows of at most
1,000,000 pixels, 32 MiB decoded, and a 128 MiB source file may use the capped
full reader. Up to 100,000,000 selected pixels use tiled all-pixel streaming;
larger requests use at most 5,000 spatial samples. Full/tiled mean, standard
deviation, minimum, and maximum cover every valid pixel. Quartiles retain at
most 65,536 deterministic priority-sampled values and are explicitly marked
approximate when that cap is exceeded. Sampled mode marks both population
coverage and mean/quantiles as approximate. Geographic bbox statistics require
raster CRS metadata; whole-raster statistics do not.

Raster comparisons use the same bounded thresholds, align the second raster
onto the first raster's selected grid, and compute both input means and the
difference on one shared validity mask. Full/tiled moments are exact;
quartiles are retained in a bounded deterministic sample, and comparisons
beyond 100,000,000 selected pixels use at most 5,000 spatial samples with
explicit approximation metadata. Analytics endpoints accept one optional
**time** or **datetime** ISO-8601 instant (or **YYYYMMDD**) and select the
nearest dated local STAC asset. Provider availability is reported separately
from analyzability: configured remote/STAC source strings are not treated as
proof that scalar data can be read.

Mission COG expressions, configured valid ranges, units, and nodata values are
preserved as scalar-semantics metadata. The backend refuses transformed or
otherwise configured values it cannot reproduce exactly, and refuses layer
subtraction without explicitly matching units. These typed 422 responses let
AgentChat use its validated client raster path instead of presenting raw TIFF
values as scientifically meaningful results.

## Plugin Tiers

| Tier             | Meaning                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| **official**     | Fully supported and tested against the latest MMGIS release                                        |
| **experimental** | Functional but may have breaking changes between releases and may rely on unreleased code/services |

## Structure

```
MMGIS-Plugins/
├── tools/
│   └── PluginName/
│       └── plugin.json
├── backend/
│   └── PluginName/
│       ├── plugin.json
│       └── plugin.js
└── components/
    └── PluginName/
        └── plugin.json
```

Each plugin has a `plugin.json` manifest with metadata, dependencies, and configuration. See the [MMGIS Plugin System docs](https://github.com/NASA-AMMOS/MMGIS/blob/development/plugins/README.md) for the full schema.

## Updating

```bash
npm run plugins -- update MMGIS-Plugins
npm run plugins:install
npm run build
```

## Contributing

To propose a new official plugin:

1. Follow the plugin template structure (`npm run plugins -- create tool|backend|component MyPlugin`)
2. Include a complete `plugin.json` with `tier`, `description`, `author`, `license`, and `pluginDependencies`
3. Include tests in a `tests/` directory
4. Open a PR against this repo

For more information, see [CONTRIBUTING](CONTRIBUTING.md).

## License

This repository is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the full text.

Individual plugins may declare their own license in their `plugin.json` manifest. When a plugin includes its own `LICENSE` file, that file governs the plugin's use. In the absence of a plugin-specific license, the repository-level Apache-2.0 license applies.
