import { test, expect } from '@playwright/test';
import {
  resolveAssistantReply,
  EMPTY_ASSISTANT_REPLY_MESSAGE,
} from '../replyGuard';

// Requirement: Copilot must never silently render an empty assistant
// bubble. This is the client-side last line of defense — the backend
// (provider.js) is expected to always send a readable reply, but the UI
// must not go blank even if that guarantee is ever violated.
test.describe('@unit AgentChat replyGuard', () => {
  test('prefers a non-empty reply over text', () => {
    expect(resolveAssistantReply('Here are your layers.', 'fallback text')).toBe(
      'Here are your layers.',
    );
  });

  test('falls back to text when reply is empty', () => {
    expect(resolveAssistantReply('', 'Planned: list_layers.')).toBe(
      'Planned: list_layers.',
    );
    expect(resolveAssistantReply(undefined, 'Planned: list_layers.')).toBe(
      'Planned: list_layers.',
    );
  });

  test('falls back to the empty-response message when both reply and text are blank', () => {
    expect(resolveAssistantReply('', '')).toBe(EMPTY_ASSISTANT_REPLY_MESSAGE);
    expect(resolveAssistantReply(null, undefined)).toBe(
      EMPTY_ASSISTANT_REPLY_MESSAGE,
    );
    expect(resolveAssistantReply('   ', '   ')).toBe(
      EMPTY_ASSISTANT_REPLY_MESSAGE,
    );
  });

  test('trims whitespace-only reply/text instead of treating them as content', () => {
    expect(resolveAssistantReply('   ', 'Actual content')).toBe(
      'Actual content',
    );
  });
});
