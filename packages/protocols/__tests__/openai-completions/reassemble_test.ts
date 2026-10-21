import { test } from 'vitest';

import type { OpenAICompletionsStreamEvent } from '../../src/openai-completions/index.ts';
import { reassembleOpenAICompletionsEvents } from '../../src/openai-completions/reassemble.ts';
import { assertEquals } from '@floway-dev/test-utils';

const chunk = (text: string, finish_reason: string | null = null, extra: Partial<OpenAICompletionsStreamEvent> = {}): OpenAICompletionsStreamEvent => ({
  id: 'cmpl_test',
  object: 'text_completion',
  created: 123,
  model: 'text-davinci-003',
  choices: [{ index: 0, text, finish_reason }],
  ...extra,
});

const usageChunk: OpenAICompletionsStreamEvent = {
  id: 'cmpl_test',
  object: 'text_completion',
  created: 123,
  model: 'text-davinci-003',
  choices: [],
  usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
};

const fromArray = async function* (events: OpenAICompletionsStreamEvent[]): AsyncGenerator<OpenAICompletionsStreamEvent> {
  for (const event of events) yield event;
};

test('reassembleOpenAICompletionsEvents concatenates per-choice text and lifts the final usage chunk', async () => {
  const result = await reassembleOpenAICompletionsEvents(fromArray([
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

test('reassembleOpenAICompletionsEvents merges multiple choices by index', async () => {
  const choiceTwo = (text: string, finish_reason: string | null = null): OpenAICompletionsStreamEvent => ({
    id: 'cmpl_test',
    object: 'text_completion',
    created: 123,
    model: 'text-davinci-003',
    choices: [{ index: 1, text, finish_reason }],
  });

  const result = await reassembleOpenAICompletionsEvents(fromArray([
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

test('reassembleOpenAICompletionsEvents folds the Zhipu/GLM vLLM-fork final usage chunk as a no-op placeholder', async () => {
  // The Zhipu/GLM fork emits a final `choices: [{ index: 0 }]` (no text,
  // no finish_reason) carrying the usage block instead of OpenAI's
  // `choices: []`. The reassembler folds it as a no-op while still
  // surfacing the usage onto the result.
  const result = await reassembleOpenAICompletionsEvents(fromArray([
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

test('reassembleOpenAICompletionsEvents carries system_fingerprint and logprobs through', async () => {
  const fingerprinted: OpenAICompletionsStreamEvent = {
    id: 'cmpl_test',
    object: 'text_completion',
    created: 123,
    model: 'text-davinci-003',
    choices: [{ index: 0, text: 'x', finish_reason: null, logprobs: { tokens: ['x'] } }],
    system_fingerprint: 'fp_abc',
  };

  const result = await reassembleOpenAICompletionsEvents(fromArray([fingerprinted, chunk('', 'stop')]));

  assertEquals(result.system_fingerprint, 'fp_abc');
  assertEquals(result.choices[0]?.logprobs, { tokens: ['x'] });
});

const tokenLogprobs = (token: string, offset: number) => ({
  tokens: [token],
  token_logprobs: [offset === 0 ? null : -0.5],
  top_logprobs: [offset === 0 ? null : { [token]: -0.5 }],
  text_offset: [offset],
});

const logprobChunk = (index: number, token: string, offset: number): OpenAICompletionsStreamEvent => chunk('', null, {
  choices: [{ index, text: token, finish_reason: null, logprobs: tokenLogprobs(token, offset) }],
});

test.each([undefined, null])('accumulates token logprobs before a terminal %s and usage frame', async logprobs => {
  const events = [
    logprobChunk(0, 'alpha', 0),
    logprobChunk(0, ' beta', 5),
    logprobChunk(0, ' gamma', 10),
    logprobChunk(0, ' delta', 16),
    chunk('', 'stop', { choices: [{ index: 0, text: '', finish_reason: 'stop', logprobs }] }),
    usageChunk,
  ];
  const original = structuredClone(events);
  const result = await reassembleOpenAICompletionsEvents(fromArray(events));

  assertEquals(result.choices, [{
    index: 0,
    text: 'alpha beta gamma delta',
    finish_reason: 'stop',
    logprobs: {
      tokens: ['alpha', ' beta', ' gamma', ' delta'],
      token_logprobs: [null, -0.5, -0.5, -0.5],
      top_logprobs: [null, { ' beta': -0.5 }, { ' gamma': -0.5 }, { ' delta': -0.5 }],
      text_offset: [0, 5, 10, 16],
    },
  }]);
  assertEquals(result.usage, usageChunk.usage);
  assertEquals(events, original);
});

test('keeps interleaved choices and their token offsets separate', async () => {
  const result = await reassembleOpenAICompletionsEvents(fromArray([
    logprobChunk(2, 'two', 0),
    logprobChunk(0, 'one', 0),
    logprobChunk(2, ' second', 3),
    logprobChunk(0, ' first', 3),
  ]));

  assertEquals(result.choices.map(choice => ({ index: choice.index, logprobs: choice.logprobs })), [
    { index: 0, logprobs: { tokens: ['one', ' first'], token_logprobs: [null, -0.5], top_logprobs: [null, { ' first': -0.5 }], text_offset: [0, 3] } },
    { index: 2, logprobs: { tokens: ['two', ' second'], token_logprobs: [null, -0.5], top_logprobs: [null, { ' second': -0.5 }], text_offset: [0, 3] } },
  ]);
});

test('preserves collected arrays across empty, null, and omitted logprob fields', async () => {
  const result = await reassembleOpenAICompletionsEvents(fromArray([
    chunk('', null, { choices: [{ index: 0, logprobs: null }] }),
    logprobChunk(0, 'x', 0),
    chunk('', null, { choices: [{ index: 0, logprobs: { tokens: [], token_logprobs: null, top_logprobs: [] } }] }),
    chunk('', 'stop', { choices: [{ index: 0, finish_reason: 'stop', logprobs: {} }] }),
    { ...usageChunk, choices: [{ index: 0 }] },
  ]));

  assertEquals(result.choices[0]?.logprobs, tokenLogprobs('x', 0));
});

test.each([undefined, null, { tokens: [], token_logprobs: null }])('retains an absent or empty logprob value: %j', async logprobs => {
  const result = await reassembleOpenAICompletionsEvents(fromArray([
    chunk('', 'stop', { choices: [{ index: 0, text: '', finish_reason: 'stop', logprobs }] }),
  ]));

  assertEquals(result.choices[0]?.logprobs, logprobs);
  assertEquals(Object.hasOwn(result.choices[0]!, 'logprobs'), logprobs !== undefined);
});

test('preserves opaque logprob extensions without concatenating their arrays', async () => {
  const result = await reassembleOpenAICompletionsEvents(fromArray([
    chunk('', null, { choices: [{ index: 0, logprobs: { tokens: ['a'], vendor: { values: [1] } } }] }),
    chunk('', 'stop', { choices: [{ index: 0, finish_reason: 'stop', logprobs: { tokens: ['b'], vendor: { values: [2] } } }] }),
  ]));

  assertEquals(result.choices[0]?.logprobs, { tokens: ['a', 'b'], vendor: { values: [2] } });
});
