import { test } from 'vitest';

import { type CopilotCacheableMessage, withCacheControlMarkersAttached } from './attach-cache-control-markers.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assert, assertEquals, assertFalse, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (messages: ChatCompletionsMessage[]): ChatCompletionsBoundaryCtx => ({
  payload: { model: 'gpt-test', messages },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { chatCompletions: {} } }),
});

const markedIndexes = (messages: readonly ChatCompletionsMessage[]): number[] =>
  messages.flatMap((m, i) => ((m as CopilotCacheableMessage).copilot_cache_control ? [i] : []));

test('Chat Completions cache markers attach to first two systems and last two non-systems', async () => {
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

test('Chat Completions cache markers handle a single system message', async () => {
  const ctx = invocation([
    { role: 'system', content: 'only system' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), [0]);
});

test('Chat Completions cache markers attach to last two non-systems when no system message exists', async () => {
  const ctx = invocation([
    { role: 'user', content: 'user 1' },
    { role: 'assistant', content: 'assistant 1' },
    { role: 'user', content: 'user 2' },
    { role: 'assistant', content: 'assistant 2' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), [2, 3]);
});

test('Chat Completions cache markers skip empty string content', async () => {
  const ctx = invocation([
    { role: 'system', content: '' },
    { role: 'user', content: '' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), []);
});

test('Chat Completions cache markers skip empty array content', async () => {
  const ctx = invocation([
    { role: 'system', content: [] },
    { role: 'user', content: [] },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  assertEquals(markedIndexes(ctx.payload.messages), []);
});

test('Chat Completions cache markers only mark first two of five systems', async () => {
  const ctx = invocation([
    { role: 'system', content: 'system A' },
    { role: 'system', content: 'system B' },
    { role: 'system', content: 'system C' },
    { role: 'system', content: 'system D' },
    { role: 'system', content: 'system E' },
    { role: 'user', content: 'user 1' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  // First two systems + last (and only) non-system.
  assertEquals(markedIndexes(ctx.payload.messages), [0, 1, 5]);
  assertFalse((ctx.payload.messages[2] as CopilotCacheableMessage).copilot_cache_control);
  assertFalse((ctx.payload.messages[3] as CopilotCacheableMessage).copilot_cache_control);
  assertFalse((ctx.payload.messages[4] as CopilotCacheableMessage).copilot_cache_control);
});

test('Chat Completions cache markers are independent object instances per message', async () => {
  const ctx = invocation([
    { role: 'system', content: 'system A' },
    { role: 'system', content: 'system B' },
    { role: 'user', content: 'user 1' },
  ]);

  await withCacheControlMarkersAttached(ctx, stubRequest, okEvents);

  const a = (ctx.payload.messages[0] as CopilotCacheableMessage).copilot_cache_control;
  const b = (ctx.payload.messages[1] as CopilotCacheableMessage).copilot_cache_control;
  const c = (ctx.payload.messages[2] as CopilotCacheableMessage).copilot_cache_control;

  assert(a);
  assert(b);
  assert(c);
  assertFalse(a === b, 'system A and system B markers must be distinct objects');
  assertFalse(a === c, 'system A and user 1 markers must be distinct objects');
  assertFalse(b === c, 'system B and user 1 markers must be distinct objects');
});
