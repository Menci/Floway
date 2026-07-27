import { test } from 'vitest';

import type { ChatCompletionsStreamEvent, ChatCompletionsResult } from '../../src/chat-completions/index.ts';
import { collectChatCompletionsProtocolEventsToResult } from '../../src/chat-completions/to-result.ts';
import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectChatCompletionsProtocolEventsToResult reassembles synthetic Chat chunks', async () => {
  const expected: ChatCompletionsResult = {
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

  const chunk = (delta: ChatCompletionsStreamEvent['choices'][number]['delta'], finish_reason: 'stop' | null = null): ChatCompletionsStreamEvent => ({
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
    } as ChatCompletionsStreamEvent);
    yield doneFrame();
  }

  assertEquals(await collectChatCompletionsProtocolEventsToResult(events()), expected);
});

test('collectChatCompletionsProtocolEventsToResult rejects Chat streams without DONE', async () => {
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

  await assertRejects(async () => await collectChatCompletionsProtocolEventsToResult(events()), Error, 'Chat Completions stream ended without a DONE sentinel.');
});
