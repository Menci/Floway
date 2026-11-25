import { expect, test } from 'vitest';

import type { OpenAIChatCompletionsAssistantDeltaEx } from '../../src/openai-chat-completions/index.ts';
import { createOpenAIChatCompletionsEventAccumulator } from '../../src/openai-chat-completions/reassemble.ts';

const collect = (...deltas: unknown[]) => {
  const accumulator = createOpenAIChatCompletionsEventAccumulator();
  for (const reasoning_details of deltas) {
    const delta: OpenAIChatCompletionsAssistantDeltaEx = { reasoning_details };
    accumulator.accept({
      id: 'chat', object: 'chat.completion.chunk', created: 1, model: 'model',
      choices: [{ index: 0, delta, finish_reason: null }],
    });
  }
  const result = accumulator.result();
  if (!result.ok) throw result.error.cause;
  return result.value.choices[0].message.reasoning_details;
};

test('merges summary fragments without concatenating repeated discriminants or metadata', () => {
  const frames = [
    [{ type: 'reasoning.summary', summary: ' reading', id: 'summary', index: 0, provider: { first: true } }],
    [{ type: 'reasoning.summary', summary: ' it', id: 'summary', index: 0, format: 'openai-responses-v1', trace: 'trace' }],
    [{ type: 'reasoning.summary', summary: '.', id: 'summary', index: 0, format: 'openai-responses-v1' }],
  ];
  const before = structuredClone(frames);
  expect(collect(...frames)).toEqual([{
    type: 'reasoning.summary', summary: ' reading it.', id: 'summary', index: 0, format: 'openai-responses-v1',
    provider: { first: true }, trace: 'trace',
  }]);
  expect(frames).toEqual(before);
});

test('keeps encrypted details discrete despite repeated indices and separates different types', () => {
  expect(collect(
    [{ type: 'reasoning.summary', summary: 'before', index: 0 }],
    [{ type: 'reasoning.encrypted', data: 'first', id: 'cipher-a', index: 0 }],
    [{ type: 'reasoning.encrypted', data: 'second', id: 'cipher-b', index: 0 }],
    [{ type: 'reasoning.summary', summary: 'after', index: 0 }],
  )).toEqual([
    { type: 'reasoning.summary', summary: 'before', index: 0 },
    { type: 'reasoning.encrypted', data: 'first', id: 'cipher-a', index: 0 },
    { type: 'reasoning.encrypted', data: 'second', id: 'cipher-b', index: 0 },
    { type: 'reasoning.summary', summary: 'after', index: 0 },
  ]);
});

test('preserves unknown vendor details and opaque non-array values without guessing their delta semantics', () => {
  const first = { type: 'vendor.reasoning', data: 'one', index: 0, metadata: { first: true } };
  const second = { type: 'vendor.reasoning', data: 'two', index: 0, metadata: { second: true } };
  expect(collect([first], [second])).toEqual([first, second]);
  expect(collect([null, 'opaque', { metadata: ['value'] }])).toEqual([null, 'opaque', { metadata: ['value'] }]);
  expect(collect({ vendor: ['value'] })).toEqual({ vendor: ['value'] });
});
