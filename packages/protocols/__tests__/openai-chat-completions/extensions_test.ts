import { expect, test } from 'vitest';

import { accumulateOpenAIChatCompletionsExtension, createOpenAIChatCompletionsExtensionAccumulator, finalizeOpenAIChatCompletionsExtensions } from '../../src/openai-chat-completions/extensions.ts';

const accumulate = (entries: Array<[string, unknown]>, scope: 'assistant' | 'tool' = 'assistant') => {
  const state = createOpenAIChatCompletionsExtensionAccumulator(scope);
  for (const [field, value] of entries) accumulateOpenAIChatCompletionsExtension(state, field, value);
  return finalizeOpenAIChatCompletionsExtensions(state);
};

test('unknown complete values preserve the latest explicit value and literal property names', () => {
  const fields = accumulate([
    ['metadata', { old: true }], ['metadata', {}], ['opaque', 'first'], ['opaque', 'second'],
    ['cleared', 1], ['cleared', null], ['disabled', true], ['disabled', false],
    ['__proto__', { retained: true }],
    ['reasoning_items', [{ id: 'old' }]], ['reasoning_items', [{ id: 'new' }]],
  ]);
  expect(fields).toEqual({ metadata: {}, opaque: 'second', cleared: null, disabled: false, ['__proto__']: { retained: true }, reasoning_items: [{ id: 'new' }] });
  expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
});

test('known assistant text aliases concatenate independently', () => {
  expect(accumulate([['reasoning', 'A'], ['reasoning_text', 'B'], ['reasoning', 'C'], ['reasoning_text', 'D']])).toEqual({ reasoning: 'AC', reasoning_text: 'BD' });
  expect(accumulate([['reasoning', 'A'], ['reasoning', 'B']], 'tool')).toEqual({ reasoning: 'B' });
});

test('thinking boundaries require nonempty signatures while unsigned and zero-text blocks survive', () => {
  const fields = accumulate([
    ['thinking_blocks', [{ type: 'thinking', thinking: 'A', signature: null }]],
    ['thinking_blocks', [{ type: 'thinking', thinking: 'B', signature: '' }]],
    ['thinking_blocks', [{ type: 'thinking', thinking: '', signature: 'sig' }]],
    ['thinking_blocks', [{ type: 'thinking', thinking: 'C' }]],
    ['thinking_blocks', [{ type: 'redacted_thinking', data: 'redacted' }]],
    ['thinking_blocks', [{ type: 'thinking', thinking: '' }]],
  ]);
  expect(fields.thinking_blocks).toEqual([
    { type: 'thinking', thinking: 'AB', signature: 'sig' }, { type: 'thinking', thinking: 'C' },
    { type: 'redacted_thinking', data: 'redacted' }, { type: 'thinking', thinking: '' },
  ]);
});

test('OpenRouter reasoning details preserve opaque entries and merge consecutive summary/text fragments', () => {
  const fields = accumulate([
    ['reasoning_details', [{ type: 'reasoning.summary', summary: 'A', index: 0, format: 'first' }]],
    ['reasoning_details', [{ type: 'reasoning.summary', summary: 'B', index: 1, format: 'second' }]],
    ['reasoning_details', [{ type: 'reasoning.encrypted', data: 'one', index: 0 }]],
    ['reasoning_details', [{ type: 'reasoning.encrypted', data: 'two', index: 0 }]],
    ['reasoning_details', [{ type: 'reasoning.text', text: 'C', signature: 'sig' }]],
    ['reasoning_details', [{ type: 'reasoning.text', text: 'D', signature: 'later' }]],
  ]);
  expect(fields.reasoning_details).toEqual([
    { type: 'reasoning.summary', summary: 'AB', index: 0, format: 'first' },
    { type: 'reasoning.encrypted', data: 'one', index: 0 }, { type: 'reasoning.encrypted', data: 'two', index: 0 },
    { type: 'reasoning.text', text: 'CD', signature: 'sig', format: undefined },
  ]);
});

test('assistant provider citations follow LiteLLM completion grouping and plural snapshot precedence', () => {
  expect(accumulate([['provider_specific_fields', { citation: { id: 1 }, mode: 'old' }], ['provider_specific_fields', { citation: { id: 2 }, mode: 'new' }]]))
    .toEqual({ provider_specific_fields: { mode: 'new', citations: [[{ id: 1 }, { id: 2 }]] } });
  expect(accumulate([['provider_specific_fields', { citations: [] }], ['provider_specific_fields', { citation: { id: 1 } }]]))
    .toEqual({ provider_specific_fields: { citations: [] } });
  expect(accumulate([['provider_specific_fields', { citation: [1] }], ['provider_specific_fields', { citation: [2] }]]))
    .toEqual({ provider_specific_fields: { citations: [[1], [2]] } });
  expect(accumulate([['provider_specific_fields', { citation: 1 }], ['provider_specific_fields', { citation: 2 }]], 'tool'))
    .toEqual({ provider_specific_fields: { citation: 2 } });
});
