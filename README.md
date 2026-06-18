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

| Plugin    | Type | Tier         | Description                                                                   | Notes                            |
| --------- | ---- | ------------ | ----------------------------------------------------------------------------- | -------------------------------- |
| Analysis  | tool | experimental | A graphing and analysis tool for data visualization and statistical analysis. | Backend server not yet released. |
| Chemistry | tool | official     | Display chemistry percentages via graphs of a clicked point.                  |                                  |
| Isochrone | tool | official     | Find the range of locations accessible to an explorer within a given time     |                                  |
| Segment   | tool | experimental | Segment map features using SAM3 AI model with text prompts.                   | Backend server not yet released. |

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
