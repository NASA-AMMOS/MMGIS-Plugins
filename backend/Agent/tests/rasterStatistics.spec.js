import path from 'path';
import { spawnSync } from 'child_process';
import { test, expect } from '@playwright/test';

const python =
  process.env.MMGIS_PYTHON ||
  (process.platform === 'win32' ? 'python' : 'python3');
const caseRunner = path.resolve(
  __dirname,
  'fixtures/run_statistics_cases.py',
);

function runCases() {
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

test('@integration raster statistics enforce bounded modes and CRS semantics', () => {
  test.skip(
    process.env.MMGIS_RUN_RASTER_INTEGRATION !== 'true',
    'Set MMGIS_RUN_RASTER_INTEGRATION=true and run this Rasterio harness serially.',
  );
  const cases = runCases();

  expect(cases.small.status).toBe(0);
  expect(cases.small.stdout).toMatchObject({
    method: 'full',
    requested_mode: 'auto',
    mode_selection_reason: 'auto-safe-small-window',
    population_coverage: 'all-valid-pixels',
    mean_is_approximate: false,
    quantile_method: 'exact',
    quantiles_approximate: false,
    valid_count: 16,
    mean: 7.5,
    median: 7.5,
  });

  expect(cases.large.status).toBe(0);
  expect(cases.large.stdout).toMatchObject({
    method: 'tiled',
    requested_mode: 'auto',
    mode_selection_reason: 'auto-bounded-exact-tiled',
    population_coverage: 'all-valid-pixels',
    mean_is_approximate: false,
    quantile_method: 'deterministic_priority_sample',
    quantile_sample_count: 2048,
    quantile_sample_limit: 2048,
    quantiles_approximate: true,
    valid_count: 1100000,
    mean: 2,
    std: 0,
    q25: 2,
    median: 2,
    q75: 2,
  });

  expect(cases.largeFileMode).toEqual([
    'tiled',
    'auto-bounded-exact-tiled',
  ]);
  expect(cases.exceptionalMode).toEqual([
    'sampled',
    'auto-bounded-spatial-sample',
  ]);

  expect(cases.unreferencedWhole.status).toBe(0);
  expect(cases.unreferencedWhole.stdout).toMatchObject({
    method: 'full',
    valid_count: 16,
    mean: 7.5,
  });
  expect(cases.unreferencedBbox.status).toBe(2);
  expect(cases.unreferencedBbox.stderr).toContain(
    'MMGIS_MISSING_RASTER_CRS',
  );

  expect(cases.unsafeFull.status).toBe(3);
  expect(cases.unsafeFull.stderr).toContain('MMGIS_UNSAFE_FULL_READ');
});
