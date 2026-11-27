import { test } from 'vitest';

import { type CopilotCacheableMessage, attachCacheControlMarkers } from '../../../src/pipelines/openai-chat-completions/attach-cache-control-markers.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const invocation = (messages: OpenAIChatCompletionsMessage[]): StageFixture<'openaiChatCompletions'> => ({
  payload: { model: 'gpt-test', messages },
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiChatCompletions: {} } }),
});

const markedIndexes = (messages: readonly OpenAIChatCompletionsMessage[]): number[] =>
  messages.flatMap((m, i) => ((m as CopilotCacheableMessage).copilot_cache_control ? [i] : []));

test('OpenAI Chat Completions cache markers attach to first two systems and last two non-systems', async () => {
  const fixture = invocation([
    { role: 'system', content: 'system A' },
    { role: 'system', content: 'system B' },
    { role: 'user', content: 'user 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'user', content: 'user 2' },
    { role: 'assistant', content: 'assistant 2' },
  ]);

  const ctx = await inspectStages('openaiChatCompletions', attachCacheControlMarkers, fixture);

  assertEquals(markedIndexes(ctx.payload.messages), [0, 1, 4, 5]);
  for (const index of [0, 1, 4, 5]) {
    assertEquals((ctx.payload.messages[index] as CopilotCacheableMessage).copilot_cache_control, { type: 'ephemeral' });
  }
});

test('OpenAI Chat Completions cache markers skip empty string content', async () => {
  const fixture = invocation([
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ]);

  const ctx = await inspectStages('openaiChatCompletions', attachCacheControlMarkers, fixture);

  assertEquals(markedIndexes(ctx.payload.messages), []);
});
