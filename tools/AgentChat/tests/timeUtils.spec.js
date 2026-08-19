import { test, expect } from '@playwright/test';
import {
  parseTimeQuery,
  getLayerTimeMetadata,
  withActiveTimelineBounds,
  computeLayerTargetTime,
  detectSpecialTimeKeyword,
  formatLayerTimeAnnouncement,
} from '../timeUtils';

test.describe('@unit timeUtils', () => {
  test('recognizes standalone and natural-language latest/earliest requests', () => {
    expect(detectSpecialTimeKeyword('latest')).toBe('latest');
    expect(detectSpecialTimeKeyword('most recent date')).toBe('latest');
    expect(detectSpecialTimeKeyword('earliest')).toBe('earliest');
    expect(detectSpecialTimeKeyword('go to the first timestamp')).toBe('earliest');
    expect(detectSpecialTimeKeyword('January 2024')).toBeNull();
  });

  test('parseTimeQuery tolerates typos and paraphrasing', () => {
    const parsed = parseTimeQuery('please set time to Jnaury 2023 for me');
    expect(parsed).toBeTruthy();
    expect(parsed.precision).toBe('month');
    expect(parsed.iso).toBe('2023-01-01T00:00:00Z');
  });

  test('parseTimeQuery extracts dates embedded in longer text', () => {
    const parsed = parseTimeQuery('display the data on 2024 March 15th over Beaufort');
    expect(parsed).toBeTruthy();
    expect(parsed.precision).toBe('day');
    expect(parsed.iso).toBe('2024-03-15T00:00:00Z');
  });

  test('parseTimeQuery handles month names', () => {
    const parsed = parseTimeQuery('January 2023');
    expect(parsed).toBeTruthy();
    expect(parsed.precision).toBe('month');
    expect(parsed.iso).toBe('2023-01-01T00:00:00Z');
  });

  test('computeLayerTargetTime snaps month request for daily data', () => {
    const meta = getLayerTimeMetadata({
      time: {
        enabled: true,
        format: '%Y-%m-%d',
        availableStart: '2023-07-01T00:00:00Z',
        availableEnd: '2023-08-01T00:00:00Z',
        start: '2023-07-10T00:00:00Z',
        end: '2023-07-10T00:00:00Z',
      },
    });
    const request = parseTimeQuery('2023-07');
    const resolved = computeLayerTargetTime(meta, request);
    expect(resolved.iso).toBe('2023-07-01T00:00:00Z');
    expect(resolved.notes.some((note) => note.toLowerCase().includes('daily'))).toBe(true);
  });

  test('computeLayerTargetTime clamps out-of-range requests', () => {
    const meta = getLayerTimeMetadata({
      time: {
        enabled: true,
        format: '%Y-%m-%d',
        availableStart: '2024-01-01T00:00:00Z',
        availableEnd: '2024-01-31T00:00:00Z',
        start: '2024-01-15T00:00:00Z',
        end: '2024-01-15T00:00:00Z',
      },
    });
    const request = parseTimeQuery('2023-12-01');
    const resolved = computeLayerTargetTime(meta, request);
    expect(resolved.iso).toBe('2024-01-01T00:00:00Z');
    expect(resolved.outOfRange).toBe('before');
  });

  test('computeLayerTargetTime handles latest keyword', () => {
    const meta = getLayerTimeMetadata({
      time: {
        enabled: true,
        format: '%Y-%m-%d',
        availableStart: '2024-01-01T00:00:00Z',
        availableEnd: '2024-02-01T00:00:00Z',
      },
    });
    const resolved = computeLayerTargetTime(meta, {
      special: 'latest',
      original: 'latest date',
    });
    expect(resolved.iso).toBe('2024-02-01T00:00:00Z');
    expect(resolved.notes.some((note) => note.includes('latest'))).toBe(true);
  });

  test('computeLayerTargetTime handles earliest keyword', () => {
    const meta = getLayerTimeMetadata({
      time: {
        enabled: true,
        format: '%Y-%m-%d',
        availableStart: '2023-05-15T00:00:00Z',
        availableEnd: '2023-08-01T00:00:00Z',
      },
    });
    const resolved = computeLayerTargetTime(meta, {
      special: 'earliest',
      original: 'earliest date',
    });
    expect(resolved.iso).toBe('2023-05-15T00:00:00Z');
  });

  test('does not fabricate temporal support or missing latest/earliest bounds', () => {
    expect(
      getLayerTimeMetadata({ name: 'GIBS MODIS Daily', type: 'wmts' })
    ).toEqual({ enabled: false });
    const withoutBounds = getLayerTimeMetadata({
      name: 'Explicit Time Layer',
      time: { enabled: true, format: '%Y-%m-%d' },
    });
    expect(computeLayerTargetTime(withoutBounds, { special: 'latest' })).toEqual({
      ok: false,
      reason: 'no_max_bound',
    });
    expect(computeLayerTargetTime(withoutBounds, { special: 'earliest' })).toEqual({
      ok: false,
      reason: 'no_min_bound',
    });
  });

  test('uses real active timeline bounds when a time-enabled layer omits its own range', () => {
    const meta = getLayerTimeMetadata({
      time: { enabled: true, format: '%Y-%m-%d' },
    });
    const grounded = withActiveTimelineBounds(meta, {
      startTimestamp: Date.UTC(2023, 0, 1),
      endTimestamp: Date.UTC(2024, 11, 31),
    });
    expect(grounded.timelineBoundsUsed).toBe(true);
    expect(grounded.availableStart).toContain('2023-01-01');
    expect(grounded.availableEnd).toContain('2024-12-31');
    expect(
      computeLayerTargetTime(grounded, {
        special: 'latest',
        original: 'latest',
      })
    ).toMatchObject({ ok: true, iso: '2024-12-31T00:00:00Z' });
  });

  test('formatLayerTimeAnnouncement echoes active timestamp and range', () => {
    const meta = {
      enabled: true,
      cadence: 'day',
      availableStart: '2024-01-01T00:00:00Z',
      availableEnd: '2024-01-31T00:00:00Z',
      currentStart: null,
      currentEnd: '2024-01-15T00:00:00Z',
    };
    const line = formatLayerTimeAnnouncement('Arctic Layer', meta);
    expect(line).toContain('2024-01-01T00:00:00Z – 2024-01-31T00:00:00Z');
    expect(line).toContain('Displaying data for 2024-01-15T00:00:00Z');
  });
});
