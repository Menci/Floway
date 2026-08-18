import { test } from 'vitest';

import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult } from '../../src/openai-chat-completions/index.ts';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '../../src/openai-chat-completions/to-result.ts';
import { doneFrame, eventFrame } from '../../src/common/index.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectOpenAIChatCompletionsProtocolEventsToResult reassembles synthetic Chat chunks', async () => {
  const expected: OpenAIChatCompletionsResult = {
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

  const chunk = (delta: OpenAIChatCompletionsStreamEvent['choices'][number]['delta'], finish_reason: 'stop' | null = null): OpenAIChatCompletionsStreamEvent => ({
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
    } as OpenAIChatCompletionsStreamEvent);
    yield doneFrame();
  }

  assertEquals(await collectOpenAIChatCompletionsProtocolEventsToResult(events()), expected);
});

test('collectOpenAIChatCompletionsProtocolEventsToResult rejects Chat streams without DONE', async () => {
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

  await assertRejects(async () => await collectOpenAIChatCompletionsProtocolEventsToResult(events()), Error, 'OpenAI Chat Completions stream ended without a DONE sentinel.');
});
