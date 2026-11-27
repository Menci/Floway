import { expect, test } from 'vitest';

import { decodeOpenAIChatCompletionsStream, parseOpenAIChatCompletionsStream } from '../../src/openai-chat-completions/stream.ts';
import { sseByteStream, sseFrame, sseFrameBody } from '../common/test-utils.ts';
import type { Result } from '@floway-dev/pipeline';
import { assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseOpenAIChatCompletionsStream rejects upstream OpenAI Chat Completions SSE error payloads', async () => {
  await assertRejects(
    async () => {
      await collect(parseOpenAIChatCompletionsStream(sseFrameBody(
        sseFrame(
          JSON.stringify({
            error: {
              type: 'server_error',
              message: 'upstream chat failed',
            },
          }),
        ),
      )));
    },
    Error,
    'upstream chat failed',
  );
});

test('OpenAI Chat Completions completes at native EOF without a [DONE] sentinel', async () => {
  const event = { id: 'chatcmpl_test', choices: [{ index: 0, delta: { content: 'hello' } }] };
  let reachedEof = false;
  const body = async function* () {
    yield { ok: true, value: new TextEncoder().encode(`data: ${JSON.stringify(event)}`) } as const;
    reachedEof = true;
  };
  const decoded = await collect(decodeOpenAIChatCompletionsStream(body()));
  expect(decoded).toEqual([{ ok: true, value: event }]);
  expect(reachedEof).toBe(true);
});

test.each([
  { field: 'choices', event: { choices: 42 } },
  { field: 'choices[0]', event: { choices: [null] } },
  { field: 'choices[0].delta', event: { choices: [{ index: 0, delta: null }] } },
])('OpenAI Chat Completions rejects malformed $field before yielding a typed chunk', async ({ field, event }) => {
  const body = sseByteStream(sseFrame(JSON.stringify(event), 'chat.completion.chunk'));
  expect(await collect(decodeOpenAIChatCompletionsStream(body))).toMatchObject([
    {
      ok: false,
      error: {
        kind: 'protocol',
        event,
        eventName: 'chat.completion.chunk',
        cause: { message: expect.stringContaining(field) },
      },
    },
  ]);
});

test('OpenAI Chat Completions preserves usage, annotation fields, and open wire strings', async () => {
  const usage = { prompt_tokens: 4, completion_tokens: 20, total_tokens: 24 };
  const empty = { choices: [], usage };
  const placeholder = { choices: [{ index: 0 }], usage };
  const filtered = { choices: [{ index: 0, content_filter_offsets: { check_offset: 2 } }] };
  const delta = { choices: [{ index: 0, delta: { tool_calls: null, unknown_field: 'vendor extension' }, finish_reason: 'vendor_finish' }] };
  const body = sseByteStream(...[empty, placeholder, filtered, delta].map(event => sseFrame(JSON.stringify(event))));
  expect(await collect(decodeOpenAIChatCompletionsStream(body))).toEqual([
    { ok: true, value: empty },
    { ok: true, value: { ...placeholder, choices: [{ index: 0, delta: {} }] } },
    { ok: true, value: { ...filtered, choices: [{ ...filtered.choices[0], delta: {} }] } },
    { ok: true, value: delta },
  ]);
});

test.each(['transport', 'abort'] as const)('OpenAI Chat Completions preserves a %s failure after [DONE]', async kind => {
  const failure = { kind, cause: new Error('source closed early') };
  const body = async function* (): AsyncGenerator<Result<Uint8Array, typeof failure>> {
    yield* sseByteStream(sseFrame('[DONE]'));
    yield { ok: false, error: failure };
  };
  const decoded = await collect(decodeOpenAIChatCompletionsStream(body()));
  expect(decoded).toEqual([{ ok: false, error: failure }]);
  expect(decoded[0]?.ok === false && decoded[0].error).toBe(failure);
});

test('OpenAI Chat Completions leaves bytes with their owner after malformed SSE', async () => {
  let pulls = 0;
  let closed = false;
  const reader = {
    [Symbol.asyncIterator]() { return this; },
    next: async () => {
      pulls++;
      return {
        done: false as const,
        value: { ok: true as const, value: new TextEncoder().encode('event: chunk\ndata: {\n\n') },
      };
    },
    return: async () => {
      closed = true;
      return { done: true as const, value: undefined };
    },
  };
  const decoded = decodeOpenAIChatCompletionsStream(reader);
  expect(await decoded.next()).toMatchObject({
    done: false,
    value: { ok: false, error: { kind: 'protocol', eventName: 'chunk', cause: { cause: expect.any(SyntaxError) } } },
  });
  expect(await decoded.next()).toEqual({ done: true, value: undefined });
  expect(pulls).toBe(1);
  expect(closed).toBe(false);
});

test('OpenAI Chat Completions propagates an unexpected source rejection unchanged', async () => {
  const failure = new Error('unexpected reader failure');
  const body = async function* () {
    yield* sseByteStream(sseFrame('[DONE]'));
    throw failure;
  };
  await expect(collect(decodeOpenAIChatCompletionsStream(body()))).rejects.toBe(failure);
});
