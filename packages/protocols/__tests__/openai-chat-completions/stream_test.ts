import { expect, test } from 'vitest';

import { parseOpenAIChatCompletionsStream } from '../../src/openai-chat-completions/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';

test('parseOpenAIChatCompletionsStream yields an upstream SSE error as its last frame', async () => {
  const error = { error: { type: 'server_error', message: 'upstream chat failed' } };
  const frames = parseOpenAIChatCompletionsStream(sseFrameBody(sseFrame(JSON.stringify(error)), sseFrame('[DONE]')));

  expect(await Array.fromAsync(frames)).toEqual([
    { type: 'error', cause: { message: 'Upstream OpenAI Chat Completions SSE error: server_error: upstream chat failed', cause: error } },
  ]);
});
