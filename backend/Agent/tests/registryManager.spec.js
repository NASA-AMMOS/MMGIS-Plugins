import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { loadFileRegistry, seedFromFile } from '../registryManager';
import AgentTool from '../models/agentTool';

test.describe('@unit Agent registryManager', () => {
  test('loadFileRegistry returns a well-formed tools array', () => {
    const registry = loadFileRegistry();
    expect(Array.isArray(registry.tools)).toBe(true);
    expect(registry.tools.length).toBeGreaterThan(0);
    for (const tool of registry.tools) {
      expect(typeof tool.name).toBe('string');
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  test('does not include the removed cross_section tool', () => {
    const registry = loadFileRegistry();
    const names = registry.tools.map((t) => t.name);
    expect(names).not.toContain('cross_section');
  });

  test('tool names are unique', () => {
    const registry = loadFileRegistry();
    const names = registry.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('uses one authoritative schema and a category for every tool', () => {
    const rawRegistry = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../tool-registry.json'), 'utf8'),
    );
    for (const tool of rawRegistry.tools) {
      expect(tool.category).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(tool, 'modelParameters')).toBe(
        false,
      );
    }

    const registry = loadFileRegistry();
    for (const tool of registry.tools) {
      expect(tool.category).toBeTruthy();
      expect(tool.modelParameters).toEqual(tool.parameters);
    }
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t]));
    expect(byName.calculate_layer_difference.category).toBe('analytics');
    expect(byName.calculate_layer_mean.category).toBe('analytics');
    expect(byName.list_analyzable_layers.category).toBe('analytics');
    expect(byName.zoom_to.category).toBe('map-navigation');
    expect(byName.set_layer_opacity.category).toBe('layers-visualization');
  });

  test('list_layers and list_analyzable_layers are registered with custom UI renderers', () => {
    const registry = loadFileRegistry();
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t]));
    expect(byName.list_layers?.execution?.adapter).toBe('custom');
    expect(byName.list_layers?.execution?.ui?.type).toBe('layers_line');
    expect(byName.list_analyzable_layers?.execution?.adapter).toBe('custom');
    expect(byName.list_analyzable_layers?.execution?.ui?.type).toBe(
      'list_analyzable_layers',
    );
  });

  test('registers composed analytics, named-region zoom, and safe opacity control', () => {
    const registry = loadFileRegistry();
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t]));

    expect(
      byName.zoom_to.parameters.oneOf.some(
        (schema) => schema.required?.includes('region'),
      ),
    ).toBe(true);
    expect(byName.statistics_first_visible.execution.ui.type).toBe(
      'statistics_first_visible',
    );
    expect(byName.highlight_relative_to_mean.execution.ui.type).toBe(
      'highlight_relative_to_mean',
    );
    expect(byName.set_layer_opacity.execution).toMatchObject({
      adapter: 'mmgisAPI',
      method: 'setLayerOpacity',
      argOrder: ['name', 'opacity'],
      nameResolution: 'displayNameToInternalId',
    });
  });

  test('advertises only data export formats backed by real exporters', () => {
    const registry = loadFileRegistry();
    const dataExport = registry.tools.find((tool) => tool.name === 'data_export');
    const exporterSource = fs.readFileSync(
      path.resolve(__dirname, '../../../tools/AgentChat/dataExport.js'),
      'utf8',
    );
    const switchBody = exporterSource.match(
      /switch\s*\(format\.toLowerCase\(\)\)\s*\{([\s\S]*?)\n\s*default:/,
    )?.[1];
    const implementedFormats = Array.from(
      switchBody?.matchAll(/case\s+'([^']+)':/g) || [],
      (match) => match[1],
    );

    expect(implementedFormats).toEqual(['csv', 'geojson', 'kml', 'json']);
    expect(dataExport.parameters.properties.format.enum).toEqual(
      implementedFormats,
    );
    expect(dataExport.description).not.toMatch(/netcdf/i);
  });

  test('does not advertise unaligned multilayer pixel correlation', () => {
    const registry = loadFileRegistry();
    const multilayer = registry.tools.find(
      (tool) => tool.name === 'multilayer_statistics',
    );

    expect(multilayer.description).not.toMatch(/correlation/i);
    expect(multilayer.parameters.properties.include_correlation).toBeUndefined();
  });

  test('does not advertise fixed default dates for temporal trends', () => {
    const registry = loadFileRegistry();
    const temporal = registry.tools.find(
      (tool) => tool.name === 'temporal_trends',
    );
    expect(temporal.parameters.properties.time_start.description).toMatch(
      /sanitized available.*no fixed default/i,
    );
    expect(temporal.parameters.properties.time_end.description).toMatch(
      /sanitized available.*no fixed default/i,
    );
    expect(
      temporal.parameters.properties.time_start.description,
    ).not.toMatch(/defaults to '2024/i);
    expect(
      temporal.parameters.properties.time_end.description,
    ).not.toMatch(/defaults to '2024/i);
  });

  test('matches spatial and change schemas to descriptive implementations', () => {
    const registry = loadFileRegistry();
    const byName = Object.fromEntries(registry.tools.map((tool) => [tool.name, tool]));
    const analyticsSource = fs.readFileSync(
      path.resolve(__dirname, '../../../tools/AgentChat/advancedStatistics.js'),
      'utf8',
    );
    const spatialStart = analyticsSource.indexOf(
      'export async function calculateSpatialStatistics',
    );
    const spatialEnd = analyticsSource.indexOf(
      'export async function calculateChangeDetection',
    );
    const spatialSource = analyticsSource.slice(spatialStart, spatialEnd);

    expect(spatialStart).toBeGreaterThanOrEqual(0);
    expect(spatialEnd).toBeGreaterThan(spatialStart);
    expect(spatialSource).toContain("Moran's I");
    expect(spatialSource).toContain('Getis-Ord Gi*');
    expect(spatialSource).not.toMatch(/ripley/i);
    expect(
      byName.spatial_statistics.parameters.properties.analysis_type,
    ).toBeUndefined();
    expect(byName.spatial_statistics.description).toMatch(/descriptive/i);

    const change = byName.change_detection;
    expect(change.description).not.toMatch(/signific/i);
    expect(change.parameters.properties.threshold.description).not.toMatch(
      /signific|percent/i,
    );
    expect(change.parameters.properties.threshold.description).toContain(
      "layer's units",
    );
    expect(JSON.stringify(byName.threshold_highlight)).not.toMatch(/signific/i);
  });

  test('keeps optional tool actions out of the static registry; Agent advertises available adapters', () => {
    const registry = loadFileRegistry();
    const byName = Object.fromEntries(
      registry.tools.map((tool) => [tool.name, tool]),
    );
    const rendererSource = fs.readFileSync(
      path.resolve(__dirname, '../../../tools/AgentChat/renderers.js'),
      'utf8',
    );
    const rendererMap = rendererSource.slice(
      rendererSource.indexOf('const RENDERERS ='),
    );
    const providerSource = fs.readFileSync(
      path.resolve(__dirname, '../provider.js'),
      'utf8',
    );

    expect(byName.time_series_animation).toBeUndefined();
    expect(byName.open_animation_tool).toBeUndefined();
    expect(registry.uiProfiles?.open_animation_tool).toBeUndefined();
    expect(rendererMap).not.toMatch(/time_series_animation\s*:/);
    expect(rendererMap).not.toMatch(/open_animation_tool\s*:/);
    expect(providerSource).not.toContain('"tool":"open_animation_tool"');

    expect(byName.run_analysis).toBeUndefined();
    expect(rendererSource).not.toContain('render_run_analysis');
    expect(rendererSource).not.toContain('../Analysis/');
  });

  test('keeps mean/difference areas optional and enforces threshold values', () => {
    const registry = loadFileRegistry();
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t]));
    const ajv = new Ajv({ strict: false });

    const validateMean = ajv.compile(byName.calculate_layer_mean.parameters);
    expect(validateMean({ layer_name: 'Sea Ice' })).toBe(true);
    expect(
      validateMean({
        layer_name: 'Sea Ice',
        geographical_area: 'full layer extent',
      }),
    ).toBe(true);
    expect(byName.calculate_layer_mean.description).toMatch(
      /current view.*named geographic region.*full layer extent/i,
    );
    expect(
      byName.calculate_layer_mean.parameters.properties.geographical_area
        .description,
    ).toMatch(/whole\/full\/entire-layer.*full layer extent/i);

    const validateDifference = ajv.compile(
      byName.calculate_layer_difference.parameters,
    );
    expect(validateDifference({ layer_a: 'A', layer_b: 'B' })).toBe(true);
    expect(
      validateDifference({
        layer_a: 'A',
        layer_b: 'B',
        geographical_area: 'current view',
      }),
    ).toBe(true);

    const validateThreshold = ajv.compile(byName.threshold_highlight.parameters);
    const base = {
      layer_name: 'Sea Ice',
      variable: 'concentration',
    };
    expect(validateThreshold({ ...base, operator: '=', value: 0.5 })).toBe(
      true,
    );
    expect(
      validateThreshold({
        layer_name: 'Sea Ice',
        operator: '>=',
        value: 0.5,
        band: 1,
      }),
    ).toBe(true);
    expect(validateThreshold({ ...base, operator: '==', value: 0.5 })).toBe(
      true,
    );
    expect(
      validateThreshold({
        ...base,
        operator: 'between',
        value_min: 0.2,
        value_max: 0.8,
      }),
    ).toBe(true);
    expect(
      validateThreshold({ ...base, operator: 'between', value: 0.5 }),
    ).toBe(false);
    expect(validateThreshold({ ...base, operator: '>' })).toBe(false);
    expect(
      validateThreshold({ ...base, operator: '>', value: 0.5, band: 0 }),
    ).toBe(false);
  });
});

// seedFromFile() is the write path that keeps the DB-backed live tool
// registry (what routes/agent.js actually plans against) in sync with
// tool-registry.json. A real Postgres connection isn't available in this
// unit-test context, so AgentTool.findOrCreate is stubbed with an in-memory
// store — this still exercises the real update-vs-insert decision logic in
// seedFromFile() without requiring a DB.
test.describe('@unit Agent registryManager seedFromFile', () => {
  function stubAgentTool(initialRows = []) {
    const store = new Map();
    for (const row of initialRows) {
      store.set(row.name, {
        ...row,
        update(fields) {
          Object.assign(this, fields);
          return Promise.resolve(this);
        },
      });
    }
    const originalFindOrCreate = AgentTool.findOrCreate;
    const originalUpdate = AgentTool.update;
    AgentTool.findOrCreate = async ({ where, defaults }) => {
      const name = where.name;
      if (store.has(name)) return [store.get(name), false];
      const row = {
        name,
        ...defaults,
        update(fields) {
          Object.assign(this, fields);
          return Promise.resolve(this);
        },
      };
      store.set(name, row);
      return [row, true];
    };
    AgentTool.update = async (fields, { where }) => {
      const nameCondition = where?.name || {};
      const operator = Object.getOwnPropertySymbols(nameCondition)[0];
      const retainedNames = new Set(operator ? nameCondition[operator] : []);
      let updated = 0;
      for (const row of store.values()) {
        if (
          row.source === where?.source &&
          !retainedNames.has(row.name)
        ) {
          Object.assign(row, fields);
          updated += 1;
        }
      }
      return [updated];
    };
    return {
      store,
      restore: () => {
        AgentTool.findOrCreate = originalFindOrCreate;
        AgentTool.update = originalUpdate;
      },
    };
  }

  test('updates an existing file-seeded row when tool-registry.json changes', async () => {
    const registry = loadFileRegistry();
    const target = registry.tools.find((t) => t.name === 'list_layers');
    const { store, restore } = stubAgentTool([
      {
        name: target.name,
        description: 'STALE — predates a tool-registry.json edit',
        execution: { adapter: 'custom', ui: { type: 'stale_renderer_type' } },
        modelParameters: {},
        parameters: {},
        source: 'file',
        enabled: true,
      },
    ]);
    try {
      await seedFromFile();
    } finally {
      restore();
    }
    const updated = store.get(target.name);
    expect(updated.description).toBe(target.description);
    expect(updated.execution).toEqual(target.execution);
    // enabled is admin-controlled and must never be reset by re-seeding.
    expect(updated.enabled).toBe(true);
  });

  test('does not overwrite a tool an admin added/edited directly (source !== "file")', async () => {
    const registry = loadFileRegistry();
    const target = registry.tools.find((t) => t.name === 'list_layers');
    const adminDescription = 'Admin-customized description via the API';
    const { store, restore } = stubAgentTool([
      {
        name: target.name,
        description: adminDescription,
        execution: { adapter: 'custom', ui: { type: 'admin_custom_type' } },
        modelParameters: {},
        parameters: {},
        source: 'api',
        enabled: true,
      },
    ]);
    try {
      await seedFromFile();
    } finally {
      restore();
    }
    const row = store.get(target.name);
    expect(row.description).toBe(adminDescription);
    expect(row.execution.ui.type).toBe('admin_custom_type');
  });

  test('inserts tools that do not yet have a row', async () => {
    const { store, restore } = stubAgentTool([]);
    try {
      await seedFromFile();
    } finally {
      restore();
    }
    const registry = loadFileRegistry();
    expect(store.size).toBe(registry.tools.length);
    expect(store.get('list_layers')?.source).toBe('file');
    expect(store.get('list_layers')?.enabled).toBe(true);
  });

  test('disables removed file tools without touching API/plugin tools', async () => {
    const { store, restore } = stubAgentTool([
      {
        name: 'cross_section',
        source: 'file',
        enabled: true,
      },
      {
        name: 'mission_plugin__custom_action',
        source: 'api',
        enabled: true,
      },
    ]);
    try {
      await seedFromFile();
    } finally {
      restore();
    }

    expect(store.get('cross_section')?.enabled).toBe(false);
    expect(store.get('mission_plugin__custom_action')).toMatchObject({
      source: 'api',
      enabled: true,
    });
  });
});
