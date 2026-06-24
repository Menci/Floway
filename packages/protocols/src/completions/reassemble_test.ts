import { test } from 'vitest';

import type { CompletionsStreamEvent } from './index.ts';
import { reassembleCompletionsEvents } from './reassemble.ts';
import { assertEquals } from '../test-assert.ts';

const chunk = (text: string, finish_reason: string | null = null, extra: Partial<CompletionsStreamEvent> = {}): CompletionsStreamEvent => ({
  id: 'cmpl_test',
  object: 'text_completion',
  created: 123,
  model: 'text-davinci-003',
  choices: [{ index: 0, text, finish_reason }],
  ...extra,
});

const usageChunk: CompletionsStreamEvent = {
  id: 'cmpl_test',
  object: 'text_completion',
  created: 123,
  model: 'text-davinci-003',
  choices: [],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

const fromArray = async function* (events: CompletionsStreamEvent[]): AsyncGenerator<CompletionsStreamEvent> {
  for (const event of events) yield event;
};

test('reassembleCompletionsEvents concatenates per-choice text and lifts the final usage chunk', async () => {
  const result = await reassembleCompletionsEvents(fromArray([
    chunk('hello'),
    chunk(', '),
    chunk('world', 'stop'),
    usageChunk,
  ]));

  assertEquals(result, {
    id: 'cmpl_test',
    object: 'text_completion',
    created: 123,
    model: 'text-davinci-003',
    choices: [{ index: 0, text: 'hello, world', finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  });
});

test('reassembleCompletionsEvents merges multiple choices by index', async () => {
  const choiceTwo = (text: string, finish_reason: string | null = null): CompletionsStreamEvent => ({
    id: 'cmpl_test',
    object: 'text_completion',
    created: 123,
    model: 'text-davinci-003',
    choices: [{ index: 1, text, finish_reason }],
  });

  const result = await reassembleCompletionsEvents(fromArray([
    chunk('first '),
    choiceTwo('second '),
    chunk('half', 'stop'),
    choiceTwo('half', 'length'),
  ]));

  assertEquals(result.choices, [
    { index: 0, text: 'first half', finish_reason: 'stop' },
    { index: 1, text: 'second half', finish_reason: 'length' },
  ]);
});

test('reassembleCompletionsEvents folds the Zhipu/GLM vLLM-fork final usage chunk as a no-op placeholder', async () => {
  // The Zhipu/GLM fork emits a final `choices: [{ index: 0 }]` (no text,
  // no finish_reason) carrying the usage block instead of OpenAI's
  // `choices: []`. The reassembler folds it as a no-op while still
  // surfacing the usage onto the result.
  const result = await reassembleCompletionsEvents(fromArray([
    chunk('hi'),
    chunk('!', 'stop'),
    {
      id: 'cmpl_test',
      object: 'text_completion',
      created: 123,
      model: 'text-davinci-003',
      choices: [{ index: 0 }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  ]));

  assertEquals(result.choices, [{ index: 0, text: 'hi!', finish_reason: 'stop' }]);
  assertEquals(result.usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('reassembleCompletionsEvents carries system_fingerprint and logprobs through', async () => {
  const fingerprinted: CompletionsStreamEvent = {
    id: 'cmpl_test',
    object: 'text_completion',
    created: 123,
    model: 'text-davinci-003',
    choices: [{ index: 0, text: 'x', finish_reason: null, logprobs: { tokens: ['x'] } }],
    system_fingerprint: 'fp_abc',
  };

  const result = await reassembleCompletionsEvents(fromArray([fingerprinted, chunk('', 'stop')]));

  assertEquals(result.system_fingerprint, 'fp_abc');
  assertEquals(result.choices[0]?.logprobs, { tokens: ['x'] });
});
