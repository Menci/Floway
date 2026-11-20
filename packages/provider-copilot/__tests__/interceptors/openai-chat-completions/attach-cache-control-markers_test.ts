import { test } from 'vitest';

import { type CopilotCacheableMessage, withCacheControlMarkersAttached } from '../../../src/interceptors/openai-chat-completions/attach-cache-control-markers.ts';
import type { OpenAIChatCompletionsBoundaryCtx } from '../../../src/interceptors/openai-chat-completions/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (messages: OpenAIChatCompletionsMessage[]): OpenAIChatCompletionsBoundaryCtx => ({
  payload: { model: 'gpt-test', messages },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiChatCompletions: {} } }),
});

const markedIndexes = (messages: readonly OpenAIChatCompletionsMessage[]): number[] =>
  messages.flatMap((m, i) => ((m as CopilotCacheableMessage).copilot_cache_control ? [i] : []));

test('OpenAI Chat Completions cache markers attach to first two systems and last two non-systems', async () => {
  const ctx = invocation([
    { role: 'system', content: 'system A' },
    { role: 'system', content: 'system B' },
    { role: 'user', content: 'user 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'user', content: 'user 2' },
    { role: 'assistant', content: 'assistant 2' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), [0, 1, 4, 5]);
  for (const index of [0, 1, 4, 5]) {
    assertEquals((ctx.payload.messages[index] as CopilotCacheableMessage).copilot_cache_control, { type: 'ephemeral' });
  }
});

test('OpenAI Chat Completions cache markers skip empty string content', async () => {
  const ctx = invocation([
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), []);
});
