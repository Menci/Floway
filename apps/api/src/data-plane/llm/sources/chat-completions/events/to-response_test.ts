import { test } from 'vitest';

import { collectChatProtocolEventsToCompletion } from './reassemble.ts';
import { assertEquals, assertRejects } from '../../../../../test-assert.ts';
import type { ChatCompletionChunk, ChatCompletionResponse } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

test('collectChatProtocolEventsToCompletion reassembles synthetic Chat chunks', async () => {
  const expected: ChatCompletionResponse = {
    id: 'chatcmpl_1',
    object: 'chat.completion',
    created: 123,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          reasoning_text: 'think',
          content: 'Hello',
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };

  const chunk = (delta: ChatCompletionChunk['choices'][number]['delta'], finish_reason: 'stop' | null = null): ChatCompletionChunk => ({
    id: expected.id,
    object: 'chat.completion.chunk',
    created: expected.created,
    model: expected.model,
    choices: [{ index: 0, delta, finish_reason }],
  });

  async function* events() {
    yield eventFrame(chunk({ role: 'assistant' }));
    yield eventFrame(chunk({ reasoning_text: 'think' }));
    yield eventFrame(chunk({ content: 'Hello' }));
    yield eventFrame(chunk({}, 'stop'));
    yield eventFrame({
      id: expected.id,
      object: 'chat.completion.chunk' as const,
      created: expected.created,
      model: expected.model,
      choices: [],
      usage: expected.usage,
    } as ChatCompletionChunk);
    yield doneFrame();
  }

  assertEquals(await collectChatProtocolEventsToCompletion(events()), expected);
});

test('collectChatProtocolEventsToCompletion rejects Chat streams without DONE', async () => {
  async function* events() {
    yield eventFrame({
      id: 'chatcmpl_truncated',
      object: 'chat.completion.chunk' as const,
      created: 123,
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' as const, content: 'partial' },
          finish_reason: null,
        },
      ],
    });
  }

  await assertRejects(async () => await collectChatProtocolEventsToCompletion(events()), Error, 'Chat Completions stream ended without a DONE sentinel.');
});
