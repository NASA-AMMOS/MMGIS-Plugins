import { test, expect } from '@playwright/test';
import { isNonSelectableLayerName } from '../nonSelectableLayers';

// Land Mask is a background reference layer users cannot select in the
// live app; Copilot's "list layers" / "which layers can I analyze" answers
// must omit it. This is a deliberate, explicit name-based stopgap (no
// config field currently marks non-selectable layers) — narrowly scoped so
// it doesn't accidentally exclude other reference layers like GIBS Blue
// Marble, which users *can* select even though it's also time-invariant.
test.describe('@unit AgentChat nonSelectableLayers', () => {
  test('flags Land Mask regardless of case/whitespace', () => {
    expect(isNonSelectableLayerName('Land Mask')).toBe(true);
    expect(isNonSelectableLayerName('land mask')).toBe(true);
    expect(isNonSelectableLayerName('  LAND   MASK  ')).toBe(true);
  });

  test('does not flag other reference-only layers the user can select', () => {
    expect(isNonSelectableLayerName('GIBS Blue Marble')).toBe(false);
    expect(isNonSelectableLayerName('GIBS MODIS True Color')).toBe(false);
  });

  test('does not flag real data layers', () => {
    expect(isNonSelectableLayerName('SFNO Prediction Daily 10 km 2022-2024')).toBe(false);
    expect(isNonSelectableLayerName('SFNO Ground Truth Daily 10 km 2022-2024')).toBe(false);
  });

  test('handles empty/missing names without throwing', () => {
    expect(isNonSelectableLayerName('')).toBe(false);
    expect(isNonSelectableLayerName(undefined)).toBe(false);
    expect(isNonSelectableLayerName(null)).toBe(false);
  });
});
