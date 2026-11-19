import { test } from 'vitest';

import { applyLastMessageCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../../../src/protocols/anthropic-messages/as-target/cache-breakpoints.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesTool } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const cacheControlOf = (value: unknown): unknown => (value as { cache_control?: unknown }).cache_control;

test('applyLastToolCacheBreakpoint marks the last custom tool, skipping native web search', () => {
  const tools: AnthropicMessagesTool[] = [
    { type: 'custom', name: 'a', input_schema: { type: 'object' } },
    { type: 'custom', name: 'b', input_schema: { type: 'object' } },
    { type: 'web_search_20250305', name: 'web_search' },
  ];
  applyLastToolCacheBreakpoint(tools);
  assertEquals(cacheControlOf(tools[0]), undefined);
  assertEquals(cacheControlOf(tools[1]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(tools[2]), undefined);
});

test('applyLastMessageCacheBreakpoint falls back to an earlier message when the last has no cacheable block', () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ signature: '', type: 'thinking', thinking: 'reasoning…' }] },
  ];
  applyLastMessageCacheBreakpoint(messages);
  const userContent = messages[0].content;
  const assistantContent = messages[1].content;
  assert(Array.isArray(userContent) && Array.isArray(assistantContent));
  assertEquals(cacheControlOf(userContent[0]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(assistantContent[0]), undefined);
});
