import { expect, test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '../../src/openai-chat-completions/to-result.ts';

test('collectOpenAIChatCompletionsProtocolEventsToResult collects OpenAI Chat Completions streams without DONE', async () => {
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

  const result = await collectOpenAIChatCompletionsProtocolEventsToResult(events());
  expect(result).toMatchObject({ ok: true, value: { choices: [{ message: { content: 'partial' } }] } });
});
