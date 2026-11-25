import { test } from 'vitest';

import { applyTopLevelCacheControl } from '../../../src/pipelines/anthropic-messages/apply-top-level-cache-control.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (payload: AnthropicMessagesPayload & { cache_control?: { type: 'ephemeral' } }): StageFixture<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

test('ports top-level cache_control onto the last cacheable block and drops the root field', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  });

  const ctx = await inspectStages('anthropicMessages', applyTopLevelCacheControl, fixture);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[2].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'first' }]);
});

test('respects an explicit cache_control on the last cacheable block', async () => {
  const explicit = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: explicit }] }],
  });

  const ctx = await inspectStages('anthropicMessages', applyTopLevelCacheControl, fixture);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'hi', cache_control: explicit }]);
});

test('walks past trailing non-cacheable blocks to find the last cacheable one', async () => {
  const fixture = invocation({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ signature: '', type: 'thinking', thinking: 'pondering' }] },
    ],
  });

  const ctx = await inspectStages('anthropicMessages', applyTopLevelCacheControl, fixture);

  assertEquals((ctx.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(ctx.payload.messages[1].content, [{ signature: '', type: 'thinking', thinking: 'pondering' }]);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
});
