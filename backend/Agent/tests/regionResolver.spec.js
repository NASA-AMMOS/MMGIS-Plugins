import { test, expect } from '@playwright/test';
import { resolveRegion } from '../regionResolver';

// These exercise resolveRegion's SPECIAL_REGIONS preset branch only, which
// resolves synchronously without any network call — no fetch mocking needed.
test.describe('Agent regionResolver presets', () => {
  test('resolves a named hemisphere to its bbox', async () => {
    const result = await resolveRegion('northern hemisphere');
    expect(result).toBeTruthy();
    expect(result.label).toBe('Northern Hemisphere');
    expect(result.bbox).toEqual([-180, 0, 180, 90]);
    expect(result.method).toBe('preset');
  });

  test('resolves the Arctic Circle preset', async () => {
    const result = await resolveRegion('Arctic Circle');
    expect(result).toBeTruthy();
    expect(result.label).toBe('Arctic Circle');
    expect(result.bbox).toEqual([-180, 66.5622, 180, 90]);
  });

  test('parses a trailing (Nkm) buffer and records it on the response', async () => {
    const result = await resolveRegion('Southern Hemisphere (100km)');
    expect(result).toBeTruthy();
    expect(result.label).toBe('Southern Hemisphere');
    expect(result.bufferKm).toBe(100);
    expect(Array.isArray(result.bboxParts)).toBe(true);
    expect(result.bboxParts.length).toBeGreaterThan(0);
  });

  test('returns null for an empty query', async () => {
    const result = await resolveRegion('');
    expect(result).toBeNull();
  });
});
