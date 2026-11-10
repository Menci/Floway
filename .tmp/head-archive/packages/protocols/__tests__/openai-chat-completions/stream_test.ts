import { test } from 'vitest';

import { parseOpenAIChatCompletionsStream } from '../../src/openai-chat-completions/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseOpenAIChatCompletionsStream parses OpenAI Chat Completions SSE chunks and done sentinel', async () => {
  const frames = await collect(parseOpenAIChatCompletionsStream(sseFrameBody(
    sseFrame(
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
    ),
    sseFrame('[DONE]'),
  )));

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

test('parseOpenAIChatCompletionsStream rejects malformed OpenAI Chat Completions SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parseOpenAIChatCompletionsStream(sseFrameBody(
        sseFrame('not json'),
      )));
    },
    Error,
    'Malformed upstream OpenAI Chat Completions SSE JSON: not json',
  );
});

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
    'Upstream OpenAI Chat Completions SSE error: server_error: upstream chat failed',
  );
});
