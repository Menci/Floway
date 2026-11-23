import { test } from 'vitest';

import type { CopilotCacheableMessage } from '../../../src/stages/openai-chat-completions/attach-cache-control-markers.ts';
import { openAIChatCompletionsStages } from '../../../src/stages/openai-chat-completions/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals } from '@floway-dev/test-utils';

const markedIndexes = (messages: readonly OpenAIChatCompletionsMessage[]): number[] =>
  messages.flatMap((m, i) => ((m as CopilotCacheableMessage).copilot_cache_control ? [i] : []));

test('OpenAI Chat Completions cache markers attach to first two systems and last two non-systems', async () => {
  const payload = (await inspectRequestStage<OpenAIChatCompletionsPayloadEx>(openAIChatCompletionsStages, 'attach-cache-control-markers', {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'system A' },
      { role: 'system', content: 'system B' },
      { role: 'user', content: 'user 1' },
      { role: 'assistant', content: 'assistant 1' },
      { role: 'user', content: 'user 2' },
      { role: 'assistant', content: 'assistant 2' },
    ],
  })).payload;

  assertEquals(markedIndexes(payload.messages), [0, 1, 4, 5]);
  for (const index of [0, 1, 4, 5]) {
    assertEquals((payload.messages[index] as CopilotCacheableMessage).copilot_cache_control, { type: 'ephemeral' });
  }
});

test('OpenAI Chat Completions cache markers skip empty string content', async () => {
  const payload = (await inspectRequestStage<OpenAIChatCompletionsPayloadEx>(openAIChatCompletionsStages, 'attach-cache-control-markers', {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: '' },
      { role: 'user', content: '' },
    ],
  })).payload;

  assertEquals(markedIndexes(payload.messages), []);
});
