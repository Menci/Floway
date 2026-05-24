import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertRejects } from '../test-assert.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame } from '@floway-dev/protocols/common';

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents rejects Chat streams without DONE', async () => {
  async function* stream() {
    yield eventFrame({
      id: 'chatcmpl_truncated',
      object: 'chat.completion.chunk',
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'partial' },
          finish_reason: 'stop',
        },
      ],
    } satisfies ChatCompletionChunk);
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Chat Completions stream ended without a DONE sentinel.');
});
