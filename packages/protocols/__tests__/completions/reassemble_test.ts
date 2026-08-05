import { expect, test } from 'vitest';

import type { CompletionsStreamEvent } from '../../src/completions/index.ts';
import { reassembleCompletionsEvents } from '../../src/completions/reassemble.ts';
import { assertEquals } from '@floway-dev/test-utils';

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

test('reassembleCompletionsEvents preserves empty finish reasons and merges streamed logprobs', async () => {
  const first = chunk('a', null, {
    choices: [{ index: 0, text: 'a', finish_reason: null, logprobs: { tokens: ['a'], token_logprobs: [-1] } }],
  });
  const second = chunk('b', '', {
    choices: [{ index: 0, text: 'b', finish_reason: '', logprobs: { tokens: ['b'], token_logprobs: [-2] } }],
  });
  const result = await reassembleCompletionsEvents(fromArray([first, second]));

  assertEquals(result.choices[0], {
    index: 0,
    text: 'ab',
    finish_reason: '',
    logprobs: { tokens: ['a', 'b'], token_logprobs: [-1, -2] },
  });
});

test('reassembleCompletionsEvents rejects malformed and post-finish choice state', async () => {
  await expect(reassembleCompletionsEvents(fromArray([{ ...usageChunk, choices: null as never }]))).rejects.toThrow('choices must be an array');
  await expect(reassembleCompletionsEvents(fromArray([
    chunk('done', 'stop'),
    chunk('late'),
  ]))).rejects.toThrow('emitted data after finish_reason');
  await expect(reassembleCompletionsEvents(fromArray([chunk('bad', null, {
    choices: [{ index: Number.MAX_SAFE_INTEGER + 1, text: 'bad', finish_reason: null }],
  })]))).rejects.toThrow('non-negative safe integer');
});

test('reassembleCompletionsEvents accepts an explicit empty usage placeholder after finish', async () => {
  const result = await reassembleCompletionsEvents(fromArray([
    chunk('done', 'stop', {
      choices: [{ index: 0, text: 'done', finish_reason: 'stop', logprobs: { tokens: ['done'] } }],
    }),
    {
      ...usageChunk,
      choices: [{ index: 0, text: '', finish_reason: null, logprobs: null }],
    },
  ]));

  assertEquals(result.choices[0], {
    index: 0,
    text: 'done',
    finish_reason: 'stop',
    logprobs: { tokens: ['done'] },
  });
  assertEquals(result.usage, usageChunk.usage);
});

test('reassembleCompletionsEvents accumulates many logprob fragments linearly and isolates nested input', async () => {
  const fragments = Array.from({ length: 512 }, (_, index) => ({
    ...chunk(String(index), index === 511 ? 'stop' : null),
    choices: [{
      index: 0,
      text: String(index),
      finish_reason: index === 511 ? 'stop' : null,
      logprobs: { tokens: [String(index)], top_logprobs: [[{ token: String(index), logprob: -1 }]] },
    }],
  } satisfies CompletionsStreamEvent));
  const result = await reassembleCompletionsEvents(fromArray(fragments));
  const logprobs = result.choices[0]!.logprobs as { tokens: string[]; top_logprobs: Array<Array<{ token: string }>> };

  fragments[0]!.choices[0]!.logprobs!.top_logprobs[0]![0]!.token = 'mutated';
  assertEquals(logprobs.tokens.length, 512);
  assertEquals(logprobs.top_logprobs[0]?.[0]?.token, '0');
});
