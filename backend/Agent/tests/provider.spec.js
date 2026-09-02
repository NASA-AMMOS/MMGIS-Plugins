import { test, expect } from '@playwright/test';
import {
  parseAgentPlan,
  normalizeActions,
  resolveReplyText,
  describeActionsReply,
  fallbackMessage,
} from '../provider';

// These exercise the pure plan-parsing/reply-resolution helpers directly —
// no Azure/Gemini network calls, no env/credentials required. They cover the
// exact regression this suite was added for: "list layers" and
// "which layers can I analyze?" (and any other action-only plan) must never
// surface the raw JSON plan text as the visible reply, and a malformed or
// empty tool result must never resolve to blank text either.

test.describe('Agent provider parseAgentPlan', () => {
  test('parses a minified JSON plan', () => {
    const plan = parseAgentPlan('{"actions":[{"tool":"list_layers","args":{}}]}');
    expect(plan.actions).toEqual([{ tool: 'list_layers', args: {} }]);
  });

  test('throws a clear error on an empty response', () => {
    expect(() => parseAgentPlan('')).toThrow(/empty response/i);
    expect(() => parseAgentPlan('   ')).toThrow(/empty response/i);
  });

  test('throws a clear error on malformed JSON instead of returning something silently', () => {
    expect(() => parseAgentPlan('{"actions": [')).toThrow(/non-JSON response/i);
  });
});

test.describe('Agent provider normalizeActions', () => {
  test('accepts list_layers and list_analyzable_layers as known tools', () => {
    const actions = normalizeActions([
      { tool: 'list_layers', args: {} },
      { tool: 'list_analyzable_layers', args: {} },
    ]);
    expect(actions.map((a) => a.tool)).toEqual([
      'list_layers',
      'list_analyzable_layers',
    ]);
  });

  test('rejects an unknown tool name with a descriptive error (registry drift / typo)', () => {
    expect(() => normalizeActions([{ tool: 'not_a_real_tool' }])).toThrow(
      /unknown tool/i,
    );
  });

  test('rejects a non-array actions payload', () => {
    expect(() => normalizeActions('not-an-array')).toThrow(/actions.*array/i);
  });

  test('treats a null/missing actions field as an empty plan rather than throwing', () => {
    expect(normalizeActions(null)).toEqual([]);
    expect(normalizeActions(undefined)).toEqual([]);
  });
});

test.describe('Agent provider reply resolution (list layers / analytics regression)', () => {
  test('list_layers with no "reply" field never leaks the raw JSON plan as text', () => {
    const plan = parseAgentPlan('{"actions":[{"tool":"list_layers","args":{}}]}');
    const actions = normalizeActions(plan.actions);
    const reply = resolveReplyText(plan, actions);
    expect(reply).not.toContain('{');
    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply).toMatch(/list_layers/);
  });

  test('list_analyzable_layers with no "reply" field never leaks raw JSON either', () => {
    const plan = parseAgentPlan(
      '{"actions":[{"tool":"list_analyzable_layers","args":{}}]}',
    );
    const actions = normalizeActions(plan.actions);
    const reply = resolveReplyText(plan, actions);
    expect(reply).not.toContain('{');
    expect(reply).toMatch(/list_analyzable_layers/);
  });

  test('a model-provided reply is preserved verbatim', () => {
    const plan = parseAgentPlan(
      '{"actions":[{"tool":"list_layers","args":{}}],"reply":"Here are your layers."}',
    );
    const actions = normalizeActions(plan.actions);
    expect(resolveReplyText(plan, actions)).toBe('Here are your layers.');
  });

  test('an empty plan (no actions, no reply) falls back to the tool-list message, not blank text', () => {
    const plan = parseAgentPlan('{"actions":[]}');
    const actions = normalizeActions(plan.actions);
    const reply = resolveReplyText(plan, actions);
    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply).toBe(fallbackMessage());
  });

  test('describeActionsReply summarizes multiple planned tools without duplicates', () => {
    expect(
      describeActionsReply([
        { tool: 'toggle_layer' },
        { tool: 'toggle_layer' },
        { tool: 'zoom_to' },
      ]),
    ).toBe('Running toggle_layer, zoom_to.');
    expect(describeActionsReply([])).toBe('');
  });
});
