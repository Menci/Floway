import { test } from 'vitest';

import { applyTopLevelCacheControl } from '../../../src/pipelines/anthropic-messages/apply-top-level-cache-control.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: AnthropicMessagesPayload & { cache_control?: { type: 'ephemeral' } }): StageRequest<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
});

test('ports top-level cache_control onto the last cacheable block and drops the root field', async () => {
  const request = requestFor({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  });

  const result = await runStage(applyTopLevelCacheControl, 'anthropicMessages', request);

  assertEquals((result.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(result.payload.messages[2].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
  assertEquals(result.payload.messages[0].content, [{ type: 'text', text: 'first' }]);
});

test('respects an explicit cache_control on the last cacheable block', async () => {
  const explicit = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
  const request = requestFor({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: explicit }] }],
  });

  const result = await runStage(applyTopLevelCacheControl, 'anthropicMessages', request);

  assertEquals((result.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(result.payload.messages[0].content, [{ type: 'text', text: 'hi', cache_control: explicit }]);
});

test('walks past trailing non-cacheable blocks to find the last cacheable one', async () => {
  const request = requestFor({
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ signature: '', type: 'thinking', thinking: 'pondering' }] },
    ],
  });

  const result = await runStage(applyTopLevelCacheControl, 'anthropicMessages', request);

  assertEquals((result.payload as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(result.payload.messages[1].content, [{ signature: '', type: 'thinking', thinking: 'pondering' }]);
  assertEquals(result.payload.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
});
