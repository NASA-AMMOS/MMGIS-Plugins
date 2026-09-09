import { EventEmitter } from 'events';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { test, expect } from '@playwright/test';
import agentRouter from '../routes/agent';
import { spawnBounded } from '../boundedProcess';
import Config from '../../../../core/backend/Config/models/config';

const {
  sanitizeLayerHints,
  getCachedLayerCatalog,
  setCachedLayerCatalog,
  layerCatalogCache,
  getDifferenceBboxError,
  classifyRasterStatsProcessError,
  getRasterStatsAttempts,
  sanitizeLayerSource,
  selectLayerSummaries,
  normalizeAnalysisTimeValue,
  readOptionalAnalysisTime,
  selectTiffForTime,
  describeAnalyticsLayerAvailability,
  buildRasterDifferenceArgs,
  extractScalarSemantics,
  publicScalarSemantics,
  getBackendScalarSemanticsError,
  getComparisonScalarSemanticsError,
  resolvePythonExecutable,
  publicAgentError,
} = agentRouter._testHelpers;

async function withMissionConfig(config, callback) {
  const originalFindOne = Config.findOne;
  const originalForceConfigPath = process.env.FORCE_CONFIG_PATH;
  delete process.env.FORCE_CONFIG_PATH;
  Config.findOne = async () => ({ config });
  layerCatalogCache.clear();
  try {
    await callback();
  } finally {
    layerCatalogCache.clear();
    Config.findOne = originalFindOne;
    if (originalForceConfigPath == null) delete process.env.FORCE_CONFIG_PATH;
    else process.env.FORCE_CONFIG_PATH = originalForceConfigPath;
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

async function withAgentServer(layerInfo, callback) {
  const app = express();
  app.use((req, res, next) => {
    req.agentLayerInfo = layerInfo;
    next();
  });
  app.use('/api/agent', agentRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}/api/agent`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test.describe('@unit Agent backend safety contracts', () => {
  test('normalizes nested live layer analysis and group context', () => {
    const [rgb, scalar] = sanitizeLayerHints([
      {
        display_name: 'GIBS MODIS True Color',
        source_type: 'tile',
        group_path: ['Base Layers', 'Imagery'],
        visible: true,
        analysis: {
          supported: false,
          scalar: false,
          reason: 'RGB imagery has no meaningful scalar values.',
          operations: [],
          source: 'runtime',
        },
      },
      {
        displayName: 'Sea Ice Concentration',
        sourceType: 'cog',
        groupPath: 'Forecast / Analysis',
        analysis: {
          supported: true,
          scalar: true,
          operations: ['mean', 'statistics', 'threshold'],
          source: 'Frozon',
        },
        time: {
          enabled: true,
          current: '2026-08-15T00:00:00Z',
        },
      },
    ]);

    expect(rgb).toMatchObject({
      displayName: 'GIBS MODIS True Color',
      sourceType: 'tile',
      groupPath: 'Base Layers / Imagery',
      visible: true,
      analyzable: false,
      scalar: false,
      analysisReason: 'RGB imagery has no meaningful scalar values.',
    });
    expect(scalar).toMatchObject({
      displayName: 'Sea Ice Concentration',
      sourceType: 'cog',
      groupPath: 'Forecast / Analysis',
      analyzable: true,
      scalar: true,
      analysisCapabilities: ['mean', 'statistics', 'threshold'],
      analysisSource: 'Frozon',
      time: {
        enabled: true,
        current: '2026-08-15T00:00:00Z',
      },
    });
  });

  test('layer catalog cache expires and remains bounded', () => {
    layerCatalogCache.clear();
    setCachedLayerCatalog('fresh', [{ name: 'A' }], 1000);
    expect(getCachedLayerCatalog('fresh', 1001)).toEqual([{ name: 'A' }]);
    expect(getCachedLayerCatalog('fresh', 10 * 60 * 1000)).toBeNull();

    for (let index = 0; index < 40; index += 1) {
      setCachedLayerCatalog(`mission-${index}`, [{ name: `${index}` }], 2000);
    }
    expect(layerCatalogCache.size).toBeLessThanOrEqual(32);
    expect(getCachedLayerCatalog('mission-0', 2001)).toBeNull();
    expect(getCachedLayerCatalog('mission-39', 2001)).toEqual([
      { name: '39' },
    ]);
    layerCatalogCache.clear();
  });

  test('scrubs model-facing layer sources and summary citations', () => {
    expect(
      sanitizeLayerSource(
        'https://user:password@example.test/data/ice.tif?token=secret#private',
      ),
    ).toBe('https://example.test/data/ice.tif');
    expect(sanitizeLayerSource('C:\\private\\mission\\ice.tif')).toBe(
      '[local .tif source redacted]',
    );
    expect(sanitizeLayerSource('/var/private/mission/ice.nc')).toBe(
      '[local .nc source redacted]',
    );
    expect(sanitizeLayerSource('data:image/png;base64,secret')).toBe('');
    expect(sanitizeLayerSource('blob:https://example.test/secret')).toBe('');

    const [summary] = selectLayerSummaries({
      items: [
        {
          name: 'Sea Ice',
          summary: 'Scalar layer.',
          citation: 'https://example.test/docs?sig=secret#private',
        },
      ],
    });
    expect(summary.citation).toBe('https://example.test/docs');
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  test('rejects malformed comparison bounds and accepts valid geographic bounds', () => {
    expect(getDifferenceBboxError({})).toBeNull();
    expect(getDifferenceBboxError({ b: 'not-a-bbox' })).toMatchObject({
      status: 400,
      code: 'InvalidBoundingBox',
    });
    expect(getDifferenceBboxError({ b: '-200,-90,180,90' })).toMatchObject({
      status: 400,
      code: 'InvalidBoundingBox',
    });
    expect(getDifferenceBboxError({ b: '-180,-90,180,90' })).toBeNull();
  });

  test('statistics attempts are bounded and never launch unsafe full mode', () => {
    const attempts = getRasterStatsAttempts();
    expect(attempts[0]).toMatchObject({
      mode: 'auto',
      tileSize: 1024,
      maxQuantileSamples: 65536,
      maxSamples: 5000,
    });
    expect(attempts.map((attempt) => attempt.mode)).toEqual([
      'auto',
      'sampled',
    ]);
    expect(attempts.some((attempt) => attempt.mode === 'full')).toBe(false);
    for (const attempt of attempts) {
      expect(attempt.maxQuantileSamples).toBeLessThanOrEqual(65536);
      expect(attempt.maxSamples).toBeLessThanOrEqual(5000);
    }
  });

  test('resolves Python portably without spawning import-time probes', () => {
    expect(
      resolvePythonExecutable(
        {
          MMGIS_PYTHON: 'D:\\Python\\python.exe',
          VIRTUAL_ENV: 'D:\\venv',
        },
        'win32',
      ),
    ).toBe('D:\\Python\\python.exe');
    expect(
      resolvePythonExecutable({ VIRTUAL_ENV: 'D:\\venv' }, 'win32'),
    ).toBe(path.win32.join('D:\\venv', 'Scripts', 'python.exe'));
    expect(
      resolvePythonExecutable({ VIRTUAL_ENV: '/opt/venv' }, 'linux'),
    ).toBe(path.posix.join('/opt/venv', 'bin', 'python'));
    expect(resolvePythonExecutable({}, 'win32')).toBe('python');
    expect(resolvePythonExecutable({}, 'linux')).toBe('python3');
  });

  test('advertises provider selection only through the deployment environment', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../plugin.json'), 'utf8'),
    );
    expect(manifest.envs.LLM_PROVIDER).toMatch(/azure.*gemini/i);
    expect(JSON.stringify(manifest.config || {})).not.toContain('llmProvider');
  });

  test('maps upstream invalid payloads to a safe provider error', () => {
    const error = new Error(
      'Invalid payload: Not allowed when agent is specified. [Request ID: secret-provider-id]',
    );
    error.status = 400;
    error.code = 'invalid_payload';
    const mapped = publicAgentError(error, 'Agent planning failed.');
    expect(mapped).toEqual({
      status: 502,
      code: 'CopilotProviderFailed',
      message: "Copilot's language-model provider rejected the request.",
    });
    expect(JSON.stringify(mapped)).not.toContain('secret-provider-id');
    expect(JSON.stringify(mapped)).not.toContain('Not allowed');
  });

  test('maps missing raster CRS failures to a typed client-safe error', () => {
    const processError = new Error('Analysis process failed.');
    processError.code = 'AnalysisProcessFailed';
    processError.stderr =
      'MMGIS_MISSING_RASTER_CRS: Geographic bbox statistics require raster CRS metadata.';
    expect(classifyRasterStatsProcessError(processError)).toMatchObject({
      status: 422,
      code: 'MissingRasterCrs',
      message:
        'Statistics over geographic bounds require CRS metadata for the selected raster.',
    });

    const unrelated = new Error('timeout');
    expect(classifyRasterStatsProcessError(unrelated)).toBe(unrelated);

    const projectionFailure = new Error('Analysis process failed.');
    projectionFailure.stderr =
      'PROJ: proj_create_from_database: DATABASE.LAYOUT.VERSION.MINOR = 2 but a number >= 4 is expected in proj.db';
    expect(classifyRasterStatsProcessError(projectionFailure)).toMatchObject({
      status: 503,
      code: 'RasterProjectionUnavailable',
      message:
        'Raster projection support is temporarily unavailable on the analytics provider.',
    });
  });

  test('bounded subprocess returns output from a successful child', async () => {
    const child = fakeChild();
    const pending = spawnBounded('python', ['script.py'], {
      timeoutMs: 1000,
      maxOutputBytes: 128,
      spawnImpl: () => child,
    });
    child.stdout.emit('data', Buffer.from('{"ok":true}'));
    child.stderr.emit('data', Buffer.from('diagnostic'));
    child.emit('close', 0);

    await expect(pending).resolves.toEqual({
      stdout: '{"ok":true}',
      stderr: 'diagnostic',
    });
  });

  test('bounded subprocess terminates output floods', async () => {
    const child = fakeChild();
    const pending = spawnBounded('python', ['script.py'], {
      timeoutMs: 1000,
      maxOutputBytes: 4,
      spawnImpl: () => child,
    });
    child.stdout.emit('data', Buffer.from('12345'));

    await expect(pending).rejects.toMatchObject({
      code: 'ProcessOutputLimitExceeded',
    });
    expect(child.killed).toBe(true);
  });

  test('bounded subprocess terminates timed-out work', async () => {
    const child = fakeChild();
    const pending = spawnBounded('python', ['script.py'], {
      timeoutMs: 5,
      spawnImpl: () => child,
    });

    await expect(pending).rejects.toMatchObject({ code: 'ProcessTimeout' });
    expect(child.killed).toBe(true);
  });

  test('layer-info route never serializes local paths, internal errors, or URL secrets', async () => {
    await withAgentServer(
      {
        loadedAt: '2026-08-15T00:00:00Z',
        sourcePath: 'C:\\private\\mission\\layer_info.txt',
        items: [
          {
            name: 'Sea Ice',
            summary: 'Scalar concentration.',
            citation: 'https://example.test/info?token=secret#internal',
            source: 'C:\\private\\rasters\\ice.tif',
            sourceType: 'cog',
            analyzable: true,
            analysisCapabilities: ['mean', 'statistics'],
          },
        ],
        index: [],
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/layer-info?mission=Test`);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.items[0]).toMatchObject({
          name: 'Sea Ice',
          citation: 'https://example.test/info',
          sourceType: 'cog',
          analyzable: true,
        });
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain('private');
        expect(serialized).not.toContain('secret');
        expect(serialized).not.toContain('token=');
      },
    );

    await withAgentServer(
      {
        error: { message: 'ENOENT C:\\private\\mission\\config.json' },
        sourcePath: 'C:\\private\\mission\\layer_info.txt',
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/layer-info?mission=Test`);
        expect(response.status).toBe(404);
        const serialized = JSON.stringify(await response.json());
        expect(serialized).not.toContain('ENOENT');
        expect(serialized).not.toContain('private');
      },
    );
  });

  test('difference route rejects malformed bbox before resolving raster sources', async () => {
    await withAgentServer({ items: [], index: [] }, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/analytics/difference?mission=Test&layer_a=A&layer_b=B&b=invalid`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: 'InvalidBoundingBox',
      });
    });
  });

  test('statistics route rejects malformed and partial requested bounds', async () => {
    await withAgentServer({ items: [], index: [] }, async (baseUrl) => {
      const requests = [
        baseUrl +
          '/analytics/statistics?mission=Test&layer_name=A&b=invalid',
        baseUrl +
          '/analytics/statistics?mission=Test&layer_name=A&lon_min=0&lat_min=0&lon_max=10',
      ];

      for (const url of requests) {
        const response = await fetch(url);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'InvalidBoundingBox',
          error: 'The requested geographic bounds are invalid.',
        });
      }
    });
  });

  test('validates one timeline instant and selects the nearest dated asset', () => {
    expect(normalizeAnalysisTimeValue('20240815')).toBe(
      '2024-08-15T00:00:00.000Z',
    );
    expect(
      normalizeAnalysisTimeValue('2024-08-15T01:02:03-05:00'),
    ).toBe('2024-08-15T06:02:03.000Z');
    expect(
      readOptionalAnalysisTime({ datetime: '2024-08-15T00:00:00Z' }),
    ).toBe('2024-08-15T00:00:00.000Z');
    expect(() => normalizeAnalysisTimeValue('latest')).toThrow(
      /single ISO-8601 instant/i,
    );
    expect(() => normalizeAnalysisTimeValue('2024-02-30')).toThrow(
      /single ISO-8601 instant/i,
    );
    expect(() =>
      readOptionalAnalysisTime({
        time: '2024-08-15',
        datetime: '2024-08-16',
      }),
    ).toThrow(/same instant/i);

    expect(
      selectTiffForTime(
        ['ice_20240131.tif', 'ice_20240202.tif', 'undated.tif'],
        '2024-02-01',
      ),
    ).toBe('ice_20240131.tif');
    expect(selectTiffForTime(['undated.tif'], '2024-02-01')).toBeNull();
  });

  test('builds bounded comparison argv with a single negative-west bbox token', () => {
    const args = buildRasterDifferenceArgs({
      pathA: 'A.tif',
      pathB: 'B.tif',
      layerNameA: 'A',
      layerNameB: 'B',
      bbox: [-106.2408, 35, -105, 36],
    });
    expect(args).toContain('--mode');
    expect(args).toContain('auto');
    expect(args).toContain('--tile-size');
    expect(args).toContain('--max-samples');
    expect(args).toContain('--max-quantile-samples');
    expect(args).toContain('--bbox=-106.2408,35,-105,36');
    expect(args).not.toContain('--bbox');
    expect(args).not.toContain('-106.2408,35,-105,36');
  });

  test('reports verified and unverified analytics providers without source-string claims', () => {
    expect(
      describeAnalyticsLayerAvailability(
        {
          sourceType: 'cog',
          sources: ['Layers/ice.tif'],
          scalarSemantics: extractScalarSemantics({ cogUnits: '%' }),
        },
        'Test',
        { resolveRasterPathFromSources: () => 'C:\\safe\\ice.tif' },
      ),
    ).toMatchObject({
      provider: 'mission-raster',
      availability: 'available',
      analyzable: true,
      backend_analyzable: true,
    });
    expect(
      describeAnalyticsLayerAvailability(
        { sourceType: 'url', sources: ['https://tiles.example.test/{z}'] },
        'Test',
        { resolveRasterPathFromSources: () => null },
      ),
    ).toMatchObject({
      provider: 'remote-source',
      availability: 'configured-unverified',
      analyzable: null,
      backend_analyzable: false,
    });
    expect(
      describeAnalyticsLayerAvailability(
        { sourceType: 'stac-collection', sources: ['sea-ice'] },
        'Test',
        { findNewestTiffInCollection: () => null },
      ),
    ).toMatchObject({
      provider: 'stac-collection',
      availability: 'configured-client-resolvable',
      analyzable: null,
    });
  });

  test('rejects unsupported configured scalar semantics and unproven comparison units', () => {
    const transformed = extractScalarSemantics({
      cogTransform: true,
      cogExpression: '(asset_b1*100)',
      cogMin: 0,
      cogMax: 100,
      cogUnits: '%',
      nodata: -9999,
    });
    expect(publicScalarSemantics(transformed)).toEqual({
      value_expression: '(asset_b1*100)',
      transformed: true,
      valid_range: [0, 100],
      configured_nodata: [-9999],
      unit: '%',
      backend_supported: false,
    });
    expect(
      getBackendScalarSemanticsError(
        { scalarSemantics: transformed },
        'SFNO',
      ),
    ).toMatchObject({
      status: 422,
      code: 'BackendScalarSemanticsUnsupported',
    });

    const percent = extractScalarSemantics({ cogUnits: '%' });
    const kelvin = extractScalarSemantics({ cogUnits: 'K' });
    const unknown = extractScalarSemantics({});
    expect(
      getComparisonScalarSemanticsError(
        { name: 'A', scalarSemantics: percent },
        { name: 'B', scalarSemantics: percent },
      ),
    ).toBeNull();
    expect(
      getComparisonScalarSemanticsError(
        { name: 'A', scalarSemantics: percent },
        { name: 'B', scalarSemantics: kelvin },
      ),
    ).toMatchObject({ code: 'IncompatibleRasterSemantics' });
    expect(
      getComparisonScalarSemanticsError(
        { name: 'A', scalarSemantics: unknown },
        { name: 'B', scalarSemantics: unknown },
      ),
    ).toMatchObject({ code: 'UnverifiedRasterSemantics' });
  });

  test('routes reject transformed backend analysis before launching Python', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'mmgis-agent-semantics-'),
    );
    const rasterPath = path.join(directory, 'sfno.tif');
    fs.writeFileSync(rasterPath, 'not-read');
    const config = {
      layers: [
        {
          name: 'SFNO',
          sourceType: 'cog',
          path: rasterPath,
          cogTransform: true,
          cogExpression: '(asset_b1*100)',
          cogMin: 0,
          cogMax: 100,
          cogUnits: '%',
          nodata: -9999,
        },
      ],
    };
    try {
      await withMissionConfig(config, async () => {
        await withAgentServer({ items: [], index: [] }, async (baseUrl) => {
          for (const endpoint of [
            '/analytics/statistics?mission=Test&layer_name=SFNO',
            '/analytics/difference?mission=Test&layer_a=SFNO&layer_b=SFNO',
          ]) {
            const response = await fetch(baseUrl + endpoint);
            expect(response.status).toBe(422);
            expect(await response.json()).toMatchObject({
              code: 'BackendScalarSemanticsUnsupported',
              semantics_applied: false,
              scalar_semantics: {
                value_expression: '(asset_b1*100)',
                valid_range: [0, 100],
                unit: '%',
                backend_supported: false,
              },
            });
          }
        });
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('analytics routes reject malformed timeline values before resolution', async () => {
    await withAgentServer({ items: [], index: [] }, async (baseUrl) => {
      for (const endpoint of [
        '/analytics/statistics?mission=Test&layer_name=A&time=latest',
        '/analytics/resolve-cog?mission=Test&layer_name=A&datetime=2024-02-30',
        '/analytics/difference?mission=Test&layer_a=A&layer_b=B&time=now',
      ]) {
        const response = await fetch(baseUrl + endpoint);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'InvalidAnalysisTime',
        });
      }
    });
  });

  test('analytics layer catalog exposes provider state without claiming remote analyzability', async () => {
    await withMissionConfig(
      {
        layers: [
          {
            name: 'Remote tiles',
            sourceType: 'url',
            url: 'https://tiles.example.test/{z}/{x}/{y}.png?token=secret',
          },
        ],
      },
      async () => {
        await withAgentServer({ items: [], index: [] }, async (baseUrl) => {
          const response = await fetch(
            baseUrl + '/analytics/layers?mission=Test',
          );
          expect(response.status).toBe(200);
          const body = await response.json();
          expect(body.layers[0]).toMatchObject({
            name: 'Remote tiles',
            provider: 'remote-source',
            availability: 'configured-unverified',
            analyzable: null,
            backend_analyzable: false,
          });
          expect(JSON.stringify(body)).not.toContain('token=secret');
        });
      },
    );
  });

  test('scalar semantics guards are wired before backend computations', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../routes/agent.js'),
      'utf8',
    );
    const statsRoute = source.slice(
      source.indexOf('router.get("/analytics/statistics"'),
      source.indexOf('router.get("/analytics/layers"'),
    );
    const differenceRoute = source.slice(
      source.indexOf('router.get("/analytics/difference"'),
      source.indexOf('// --- Conversation endpoints ---'),
    );
    expect(statsRoute.indexOf('getBackendScalarSemanticsError(')).toBeGreaterThan(
      -1,
    );
    expect(statsRoute.indexOf('getBackendScalarSemanticsError(')).toBeLessThan(
      statsRoute.indexOf('runRasterStats('),
    );
    expect(
      differenceRoute.indexOf('getComparisonScalarSemanticsError('),
    ).toBeLessThan(differenceRoute.indexOf('spawnBounded('));
    expect(statsRoute).toContain('semantics_applied: true');
    expect(differenceRoute).toContain('result.semantics_applied = true');
  });
});
