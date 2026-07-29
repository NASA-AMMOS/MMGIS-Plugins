import { test, expect } from '@playwright/test';
import { normalizeName, scoreCandidate } from '../utils/text';

test.describe('Agent utils/text', () => {
  test('normalizeName lowercases and collapses non-alphanumeric runs', () => {
    expect(normalizeName('SWOT Binned Freeboard!')).toBe('swot binned freeboard');
    expect(normalizeName('  multiple   spaces  ')).toBe('multiple spaces');
    expect(normalizeName(null)).toBe('');
  });

  test('scoreCandidate gives a perfect score for exact matches', () => {
    expect(scoreCandidate('SWOT freeboard', 'swot freeboard')).toBe(1);
  });

  test('scoreCandidate favors substring containment', () => {
    const score = scoreCandidate('freeboard', 'SWOT binned Freeboard');
    expect(score).toBeGreaterThanOrEqual(0.8);
  });

  test('scoreCandidate falls back to a low score for unrelated strings', () => {
    const score = scoreCandidate('xyz123', 'completely different label');
    expect(score).toBeLessThan(0.5);
  });

  test('scoreCandidate returns 0 for an empty query', () => {
    expect(scoreCandidate('', 'anything')).toBe(0);
  });
});
