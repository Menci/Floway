import { test } from 'vitest';

import { translateToSourceEvents } from '../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertRejects } from '@floway-dev/test-utils';

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
    } satisfies OpenAIChatCompletionsStreamEvent);
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream OpenAI Chat Completions stream ended without a DONE sentinel.');
});
