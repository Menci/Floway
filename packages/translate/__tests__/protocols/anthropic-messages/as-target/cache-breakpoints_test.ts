import { expect, test } from 'vitest';

import { withLastMessageCacheBreakpoint, withLastSystemCacheBreakpoint, withLastToolCacheBreakpoint } from '../../../../src/protocols/anthropic-messages/as-target/cache-breakpoints.ts';
import { deepFreeze } from '../../../shared/deep-freeze.ts';
import type { AnthropicMessagesAssistantMessage, AnthropicMessagesMessage, AnthropicMessagesTextBlockParam, AnthropicMessagesTool, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals } from '@floway-dev/test-utils';

const cacheControlOf = (value: unknown): unknown => (value as { cache_control?: unknown }).cache_control;

test('withLastToolCacheBreakpoint marks the last custom tool, skipping native web search', () => {
  const tools: AnthropicMessagesTool[] = deepFreeze([
    { type: 'custom', name: 'a', input_schema: { type: 'object' } },
    { type: 'custom', name: 'b', input_schema: { type: 'object' } },
    { type: 'web_search_20250305', name: 'web_search' },
  ]);
  const marked = withLastToolCacheBreakpoint(tools);
  expect(marked[0]).toBe(tools[0]);
  assertEquals(cacheControlOf(marked[1]), { type: 'ephemeral' });
  expect(marked[2]).toBe(tools[2]);
  assertEquals(cacheControlOf(tools[1]), undefined);
});

test('withLastToolCacheBreakpoint returns the declarations unchanged when none is custom', () => {
  const tools: AnthropicMessagesTool[] = deepFreeze([{ type: 'web_search_20250305', name: 'web_search' }]);
  expect(withLastToolCacheBreakpoint(tools)).toBe(tools);
});

test('withLastMessageCacheBreakpoint promotes a string last message to a text block', () => {
  const messages: AnthropicMessagesMessage[] = deepFreeze([{ role: 'user', content: 'hello' }]);
  const marked = withLastMessageCacheBreakpoint(messages, new Set());
  assertEquals(marked[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
  assertEquals(messages[0].content, 'hello');
});

test('withLastMessageCacheBreakpoint marks an image as the trailing block', () => {
  const message: AnthropicMessagesUserMessage = deepFreeze({
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    ],
  });
  const [marked] = withLastMessageCacheBreakpoint([message], new Set());
  assert(Array.isArray(marked.content) && Array.isArray(message.content));
  expect(marked.content[0]).toBe(message.content[0]);
  assertEquals(cacheControlOf(marked.content[1]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(message.content[1]), undefined);
});

test('withLastMessageCacheBreakpoint marks a trailing assistant tool_use block', () => {
  const message: AnthropicMessagesAssistantMessage = deepFreeze({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }],
  });
  const [marked] = withLastMessageCacheBreakpoint([message], new Set());
  assert(Array.isArray(marked.content));
  assertEquals(cacheControlOf(marked.content[0]), { type: 'ephemeral' });
});

test('withLastMessageCacheBreakpoint falls back to an earlier message when the last has no cacheable block', () => {
  const messages: AnthropicMessagesMessage[] = deepFreeze([
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ signature: '', type: 'thinking', thinking: 'reasoning…' }] },
  ]);
  const marked = withLastMessageCacheBreakpoint(messages, new Set());
  const userContent = marked[0].content;
  assert(Array.isArray(userContent));
  assertEquals(cacheControlOf(userContent[0]), { type: 'ephemeral' });
  expect(marked[1]).toBe(messages[1]);
});

test('withLastMessageCacheBreakpoint skips restored native messages', () => {
  const restored: AnthropicMessagesMessage = { role: 'assistant', content: [{ type: 'text', text: 'native' }] };
  const messages: AnthropicMessagesMessage[] = deepFreeze([{ role: 'user', content: 'q' }, restored]);
  const marked = withLastMessageCacheBreakpoint(messages, new Set([restored]));
  expect(marked[1]).toBe(restored);
  assertEquals(marked[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
});

test('withLastSystemCacheBreakpoint marks only the last block when multiple are present', () => {
  const system: AnthropicMessagesTextBlockParam[] = deepFreeze([
    { type: 'text', text: 'instructions' },
    { type: 'text', text: 'leading note' },
    { type: 'text', text: 'final block' },
  ]);
  const marked = withLastSystemCacheBreakpoint(system);
  expect(marked[0]).toBe(system[0]);
  expect(marked[1]).toBe(system[1]);
  assertEquals(cacheControlOf(marked[2]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(system[2]), undefined);
});
