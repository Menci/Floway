import { test } from 'vitest';

import { chatCompletionsStreamFramesToEvents } from './emit.ts';
import { assertEquals, assertRejects } from '../../../../test-assert.ts';
import { sseFrame } from '@floway-dev/protocols/common';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('chatCompletionsStreamFramesToEvents parses Chat SSE chunks and done sentinel', async () => {
  const frames = await collect(
    chatCompletionsStreamFramesToEvents(
      (async function* () {
        yield sseFrame(
          JSON.stringify({
            id: 'chatcmpl_1',
            object: 'chat.completion.chunk',
            created: 123,
            model: 'gpt-test',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant' },
                finish_reason: null,
              },
            ],
          }),
        );
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  assertEquals(frames, [
    {
      type: 'event',
      event: {
        id: 'chatcmpl_1',
        object: 'chat.completion.chunk',
        created: 123,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null,
          },
        ],
      },
    },
    { type: 'done' },
  ]);
});

test('chatCompletionsStreamFramesToEvents rejects malformed Chat SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(
        chatCompletionsStreamFramesToEvents(
          (async function* () {
            yield sseFrame('not json');
          })(),
        ),
      );
    },
    Error,
    'Malformed upstream Chat Completions SSE JSON: not json',
  );
});

test('chatCompletionsStreamFramesToEvents rejects upstream Chat SSE error payloads', async () => {
  await assertRejects(
    async () => {
      await collect(
        chatCompletionsStreamFramesToEvents(
          (async function* () {
            yield sseFrame(
              JSON.stringify({
                error: {
                  type: 'server_error',
                  message: 'upstream chat failed',
                },
              }),
            );
          })(),
        ),
      );
    },
    Error,
    'Upstream Chat Completions SSE error: server_error: upstream chat failed',
  );
});
