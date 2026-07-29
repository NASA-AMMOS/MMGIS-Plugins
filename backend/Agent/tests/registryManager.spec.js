import { test, expect } from '@playwright/test';
import { loadFileRegistry } from '../registryManager';

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
});
