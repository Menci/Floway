import { expect, test } from 'vitest';

import { parseOpenAICompletionsStream } from '../../src/openai-completions/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';

test('parses Completions chunks up to the done sentinel', async () => {
  const chunk = { id: 'cmpl_1', object: 'text_completion', created: 1, model: 'model', choices: [{ index: 0, text: 'hello' }] };
  const body = sseFrameBody(sseFrame(JSON.stringify(chunk)), sseFrame('[DONE]'), sseFrame('not JSON'));

  expect(await Array.fromAsync(parseOpenAICompletionsStream(body))).toEqual([
    { type: 'event', event: chunk }, { type: 'done' },
  ]);
});

test('carries a Completions error payload as the terminal frame', async () => {
  const error = { error: { type: 'server_error', message: 'unavailable' } };
  const body = sseFrameBody(sseFrame(JSON.stringify(error)), sseFrame('[DONE]'));

  expect(await Array.fromAsync(parseOpenAICompletionsStream(body))).toMatchObject([
    { type: 'error', cause: { message: 'unavailable', cause: error } },
  ]);
});
