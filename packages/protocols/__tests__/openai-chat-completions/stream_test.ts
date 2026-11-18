import { test } from 'vitest';

import { parseOpenAIChatCompletionsStream } from '../../src/openai-chat-completions/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
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
    'Upstream OpenAI Chat Completions SSE error: server_error: upstream chat failed',
  );
});
