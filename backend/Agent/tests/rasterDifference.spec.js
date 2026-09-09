import path from 'path';
import { spawnSync } from 'child_process';
import { test, expect } from '@playwright/test';

const python =
  process.env.MMGIS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const caseRunner = path.resolve(
  __dirname,
  'fixtures/run_difference_cases.py',
);

function runCases() {
  // PostgreSQL/PostGIS installations sometimes export PROJ_LIB globally to a
  // database version that is incompatible with Rasterio's GDAL build. Tests
  // use Rasterio's bundled projection database, as an isolated production
  // Python environment would.
  const environment = { ...process.env };
  delete environment.PROJ_LIB;
  delete environment.PROJ_DATA;
  environment.PYTHONDONTWRITEBYTECODE = '1';
  const result = spawnSync(python, [caseRunner], {
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 1024 * 1024,
    env: environment,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim());
}

test('@integration raster difference preserves masks, signed data, and native CRS alignment', () => {
  test.skip(
    process.env.MMGIS_RUN_RASTER_INTEGRATION !== 'true',
    'Set MMGIS_RUN_RASTER_INTEGRATION=true and run this Rasterio harness serially.',
  );
  const {
    shifted,
    projected,
    signed,
    west,
    largeTiled,
    largeSampled,
    unsafeFull,
    hugeAutoMode,
  } = runCases();

  // Equal dimensions must not bypass reprojection when transforms differ.
  expect(shifted.error).toBeUndefined();
  expect(shifted.mean).toBeCloseTo(6);
  expect(shifted.total_count).toBe(100);
  expect(shifted.valid_count).toBe(80);
  expect(shifted.bbox_applied).toBe(false);

  // Geographic bounds are transformed into the projected destination grid.
  expect(projected.error).toBeUndefined();
  expect(projected.mean).toBeCloseTo(6);
  expect(projected.bbox_applied).toBe(true);
  expect(projected.requested_bbox).toEqual([2, 2, 5, 5]);
  expect(projected.total_count).toBeGreaterThan(0);
  expect(projected.total_count).toBeLessThan(100);
  expect(projected.valid_count).toBe(projected.total_count);

  // Negative values (including a valid value below -9000) are data, not
  // inferred fill. Asymmetric nodata removes two different cells, and both
  // input means are computed on that exact seven-cell overlapping support.
  expect(signed.error).toBeUndefined();
  expect(signed.mean).toBeCloseTo(2);
  expect(signed.min).toBeCloseTo(2);
  expect(signed.max).toBeCloseTo(2);
  expect(signed.total_count).toBe(9);
  expect(signed.valid_count).toBe(7);
  expect(signed.mean_a).toBeCloseTo(-1434);
  expect(signed.mean_b).toBeCloseTo(-1436);

  // A negative western longitude is passed using --bbox=<value>, which keeps
  // argparse from interpreting the value as another option.
  expect(west.error).toBeUndefined();
  expect(west.bbox_applied).toBe(true);
  expect(west.requested_bbox).toEqual([-108, 2, -105, 5]);
  expect(west.mean).toBeCloseTo(6);

  // Auto uses exact, all-overlap tiled moments above the capped full-read
  // threshold. Quantiles are a bounded deterministic sample and say so.
  expect(largeTiled.error).toBeUndefined();
  expect(largeTiled.method).toBe('tiled');
  expect(largeTiled.mode_selection_reason).toBe(
    'auto-bounded-exact-tiled',
  );
  expect(largeTiled.total_count).toBe(1_100_000);
  expect(largeTiled.processed_pixel_count).toBe(1_100_000);
  expect(largeTiled.valid_count).toBe(1_100_000);
  expect(largeTiled.mean).toBeCloseTo(6);
  expect(largeTiled.mean_a).toBeCloseTo(10);
  expect(largeTiled.mean_b).toBeCloseTo(4);
  expect(largeTiled.mean_is_approximate).toBe(false);
  expect(largeTiled.population_coverage).toBe(
    'all-selected-overlap-pixels',
  );
  expect(largeTiled.quantile_sample_count).toBe(2048);
  expect(largeTiled.quantiles_approximate).toBe(true);

  // Explicit sampling is bounded in both spatial and quantile dimensions and
  // labels every population-derived statistic as approximate.
  expect(largeSampled.error).toBeUndefined();
  expect(largeSampled.method).toBe('sampled');
  expect(largeSampled.processed_pixel_count).toBeLessThanOrEqual(100);
  expect(largeSampled.spatial_sample_count).toBe(
    largeSampled.processed_pixel_count,
  );
  expect(largeSampled.mean).toBeCloseTo(6);
  expect(largeSampled.mean_is_approximate).toBe(true);
  expect(largeSampled.input_means_approximate).toBe(true);
  expect(largeSampled.min_max_approximate).toBe(true);
  expect(largeSampled.quantiles_approximate).toBe(true);

  expect(unsafeFull.error).toMatch(/bounded read limit/i);
  expect(hugeAutoMode).toEqual([
    'sampled',
    'auto-bounded-spatial-sample',
  ]);
});
