import { test, expect } from '@playwright/test';
import {
  detectListLayersIntent,
  detectAnalyzableLayersIntent,
} from '../layerIntents';

// These two intents are answered locally (renderers.js:
// buildLayersLineText / buildAnalyzableLayersText) instead of round-tripping
// through the LLM, since "what layers exist" and "which are analyzable" are
// deterministic lookups against the current mission config. Covers every
// phrasing called out in the bug report plus the follow-up request.
test.describe('@unit AgentChat layerIntents: list layers', () => {
  for (const phrase of [
    'list layers',
    'List layers',
    'List layers.',
    'What layers are available?',
    'which layers are available',
    'show me the available layers',
    'display the layers',
    'What datasets are available?',
  ]) {
    test(`detects "${phrase}"`, () => {
      expect(detectListLayersIntent(phrase)).toBe(true);
    });
  }

  for (const phrase of [
    '',
    'turn off all layers',
    'toggle the Land Mask layer',
    'zoom to the Arctic Ocean',
    'which layers can I analyze?',
  ]) {
    test(`does not misfire on "${phrase}"`, () => {
      expect(detectListLayersIntent(phrase)).toBe(false);
    });
  }
});

test.describe('@unit AgentChat layerIntents: analyzable layers', () => {
  for (const phrase of [
    'which layers can I analyze?',
    'Which layers can I analyze?',
    'what layers can i analyze',
    'What datasets support analytics?',
    'what data supports analysis',
    'show analyzable layers',
    'Show me the layers that I can calculate statistics for.',
  ]) {
    test(`detects "${phrase}"`, () => {
      expect(detectAnalyzableLayersIntent(phrase)).toBe(true);
    });
  }

  for (const phrase of [
    '',
    'list layers',
    'turn off all layers',
    'zoom to the Beaufort Sea',
  ]) {
    test(`does not misfire on "${phrase}"`, () => {
      expect(detectAnalyzableLayersIntent(phrase)).toBe(false);
    });
  }
});
