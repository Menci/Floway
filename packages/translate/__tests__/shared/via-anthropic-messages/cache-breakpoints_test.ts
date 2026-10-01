import { expect, test } from 'vitest';

import { withLastMessageCacheBreakpoint, withLastSystemCacheBreakpoint, withLastToolCacheBreakpoint } from '../../../src/shared/via-anthropic-messages/cache-breakpoints.ts';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage, AnthropicMessagesTextBlock, AnthropicMessagesTool, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const cacheControlOf = (value: unknown): unknown => (value as { cache_control?: unknown }).cache_control;

test('withLastToolCacheBreakpoint marks the last custom tool, skipping native web search', () => {
  const tools: AnthropicMessagesTool[] = [
    { type: 'custom', name: 'a', input_schema: {} },
    { type: 'custom', name: 'b', input_schema: {} },
    { type: 'web_search_20250305', name: 'web_search' },
  ];
  const marked = withLastToolCacheBreakpoint(tools)!;
  expect(marked[0]).toBe(tools[0]);
  expect(marked[2]).toBe(tools[2]);
  expect(cacheControlOf(tools[1])).toBeUndefined();
  assertEquals(cacheControlOf(tools[0]), undefined);
  assertEquals(cacheControlOf(marked[1]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(tools[2]), undefined);
});

test('withLastMessageCacheBreakpoint promotes a string last message to a text block', () => {
  const messages: AnthropicMessagesMessage[] = [{ role: 'user', content: 'hello' }];
  const marked = withLastMessageCacheBreakpoint(messages);
  assertEquals(marked[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
});

test('withLastMessageCacheBreakpoint marks an image as the trailing block', () => {
  const message: AnthropicMessagesUserMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    ],
  };
  const marked = withLastMessageCacheBreakpoint([message])[0];
  assert(Array.isArray(marked.content));
  assertEquals(cacheControlOf(marked.content[0]), undefined);
  assertEquals(cacheControlOf(marked.content[1]), { type: 'ephemeral' });
});

test('withLastMessageCacheBreakpoint marks a trailing assistant tool_use block', () => {
  const message: AnthropicMessagesAssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }],
  };
  const marked = withLastMessageCacheBreakpoint([message])[0];
  assert(Array.isArray(marked.content));
  assertEquals(cacheControlOf(marked.content[0]), { type: 'ephemeral' });
});

test('withLastMessageCacheBreakpoint falls back to an earlier message when the last has no cacheable block', () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning…' }] },
  ];
  const marked = withLastMessageCacheBreakpoint(messages);
  const userContent = marked[0].content;
  const assistantContent = marked[1].content;
  expect(marked[1]).toBe(messages[1]);
  assert(Array.isArray(userContent) && Array.isArray(assistantContent));
  assertEquals(cacheControlOf(userContent[0]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(assistantContent[0]), undefined);
});

test('withLastSystemCacheBreakpoint is a no-op on undefined or empty input', () => {
  expect(withLastSystemCacheBreakpoint(undefined)).toBeUndefined();
  const empty: AnthropicMessagesTextBlock[] = [];
  expect(withLastSystemCacheBreakpoint(empty)).toBe(empty);
  assertEquals(empty, []);
});

test('withLastSystemCacheBreakpoint marks only the last block when multiple are present', () => {
  const system: AnthropicMessagesTextBlock[] = [
    { type: 'text', text: 'instructions' },
    { type: 'text', text: 'leading note' },
    { type: 'text', text: 'final block' },
  ];
  const marked = withLastSystemCacheBreakpoint(system)!;
  expect(marked[0]).toBe(system[0]);
  expect(marked[1]).toBe(system[1]);
  expect(cacheControlOf(system[2])).toBeUndefined();
  assertEquals(cacheControlOf(system[0]), undefined);
  assertEquals(cacheControlOf(system[1]), undefined);
  assertEquals(cacheControlOf(marked[2]), { type: 'ephemeral' });
});
