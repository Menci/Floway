import { test } from 'vitest';

import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../../../src/protocols/anthropic-messages/as-target/cache-breakpoints.ts';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage, AnthropicMessagesTextBlockParam, AnthropicMessagesTool } from '@floway-dev/protocols/anthropic-messages';
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

test('applyLastMessageCacheBreakpoint marks a trailing assistant tool_use block', () => {
  const message: AnthropicMessagesAssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }],
  };
  applyLastMessageCacheBreakpoint([message]);
  assert(Array.isArray(message.content));
  assertEquals(cacheControlOf(message.content[0]), { type: 'ephemeral' });
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

test('applyLastSystemCacheBreakpoint marks only the last block when multiple are present', () => {
  const system: AnthropicMessagesTextBlockParam[] = [
    { type: 'text', text: 'instructions' },
    { type: 'text', text: 'leading note' },
    { type: 'text', text: 'final block' },
  ];
  applyLastSystemCacheBreakpoint(system);
  assertEquals(cacheControlOf(system[0]), undefined);
  assertEquals(cacheControlOf(system[1]), undefined);
  assertEquals(cacheControlOf(system[2]), { type: 'ephemeral' });
});
