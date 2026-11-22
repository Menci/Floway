import { test } from 'vitest';

import { anthropicMessagesStages } from '../../../src/stages/anthropic-messages/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('ports top-level cache_control onto the last cacheable block and drops the root field', async () => {
  const payload: AnthropicMessagesPayload & { cache_control?: { type: 'ephemeral' } } = {
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  };
  const rewritten = (await inspectRequestStage(anthropicMessagesStages, 'apply-top-level-cache-control', payload)).payload;

  assertEquals((rewritten as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(rewritten.messages[2].content, [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }]);
  assertEquals(rewritten.messages[0].content, [{ type: 'text', text: 'first' }]);
});

test('respects an explicit cache_control on the last cacheable block', async () => {
  const explicit = { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' };
  const payload: AnthropicMessagesPayload & { cache_control?: { type: 'ephemeral' } } = {
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: explicit }] }],
  };
  const rewritten = (await inspectRequestStage(anthropicMessagesStages, 'apply-top-level-cache-control', payload)).payload;

  assertEquals((rewritten as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(rewritten.messages[0].content, [{ type: 'text', text: 'hi', cache_control: explicit }]);
});

test('walks past trailing non-cacheable blocks to find the last cacheable one', async () => {
  const payload: AnthropicMessagesPayload & { cache_control?: { type: 'ephemeral' } } = {
    model: 'claude-test',
    max_tokens: 10,
    cache_control: { type: 'ephemeral' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ signature: '', type: 'thinking', thinking: 'pondering' }] },
    ],
  };
  const rewritten = (await inspectRequestStage(anthropicMessagesStages, 'apply-top-level-cache-control', payload)).payload;

  assertEquals((rewritten as { cache_control?: unknown }).cache_control, undefined);
  assertEquals(rewritten.messages[1].content, [{ signature: '', type: 'thinking', thinking: 'pondering' }]);
  assertEquals(rewritten.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
});
