import { test } from 'vitest';

import { withTopLevelCacheControlApplied } from './apply-top-level-cache-control.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload & { cache_control?: { type: 'ephemeral' } }): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

test('ports top-level cache_control onto the last cacheable block and drops the root field', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[2].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'first' }]);
});

test('respects an explicit cache_control on the last cacheable block', async () => {
  const explicit = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: explicit }] }],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'hi', cache_control: explicit }]);
});

test('promotes string message content so the auto-marker has a block to land on', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: 'plain' }],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } }]);
});

test('walks past trailing non-cacheable blocks to find the last cacheable one', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering' }] },
    ],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[1].content, [{ type: 'thinking', thinking: 'pondering' }]);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
});

test('drops top-level cache_control when no cacheable block exists', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'no text yet' }] }],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'thinking', thinking: 'no text yet' }]);
});

test('no-op when payload has no top-level cache_control', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });

  await withTopLevelCacheControlApplied(ctx, stubRequest, okEvents);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'hi' }]);
});
