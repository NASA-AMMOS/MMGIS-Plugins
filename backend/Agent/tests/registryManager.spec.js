import { test, expect } from '@playwright/test';
import { loadFileRegistry, seedFromFile } from '../registryManager';
import AgentTool from '../models/agentTool';

test.describe('Agent registryManager', () => {
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
});

// seedFromFile() is the write path that keeps the DB-backed live tool
// registry (what routes/agent.js actually plans against) in sync with
// tool-registry.json. A real Postgres connection isn't available in this
// unit-test context, so AgentTool.findOrCreate is stubbed with an in-memory
// store — this still exercises the real update-vs-insert decision logic in
// seedFromFile() without requiring a DB.
test.describe('Agent registryManager seedFromFile', () => {
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
    const original = AgentTool.findOrCreate;
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
    return {
      store,
      restore: () => {
        AgentTool.findOrCreate = original;
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
});
