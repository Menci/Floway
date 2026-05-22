import { test } from 'vitest';

import { applyLastMessageCacheBreakpoint, applyLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { assert, assertEquals } from '../../test-assert.ts';
import type { MessagesAssistantMessage, MessagesMessage, MessagesTool, MessagesUserMessage } from '@floway-dev/protocols/messages';

const cacheControlOf = (value: unknown): unknown => (value as { cache_control?: unknown }).cache_control;

test('applyLastToolCacheBreakpoint marks the last custom tool, skipping native web search', () => {
  const tools: MessagesTool[] = [
    { type: 'custom', name: 'a', input_schema: {} },
    { type: 'custom', name: 'b', input_schema: {} },
    { type: 'web_search_20250305', name: 'web_search' },
  ];
  applyLastToolCacheBreakpoint(tools);
  assertEquals(cacheControlOf(tools[0]), undefined);
  assertEquals(cacheControlOf(tools[1]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(tools[2]), undefined);
});

test('applyLastMessageCacheBreakpoint promotes a string last message to a text block', () => {
  const messages: MessagesMessage[] = [{ role: 'user', content: 'hello' }];
  applyLastMessageCacheBreakpoint(messages);
  assertEquals(messages[0].content, [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }]);
});

test('applyLastMessageCacheBreakpoint marks an image as the trailing block', () => {
  const message: MessagesUserMessage = {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    ],
  };
  applyLastMessageCacheBreakpoint([message]);
  assert(Array.isArray(message.content));
  assertEquals(cacheControlOf(message.content[0]), undefined);
  assertEquals(cacheControlOf(message.content[1]), { type: 'ephemeral' });
});

test('applyLastMessageCacheBreakpoint marks a trailing assistant tool_use block', () => {
  const message: MessagesAssistantMessage = {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }],
  };
  applyLastMessageCacheBreakpoint([message]);
  assert(Array.isArray(message.content));
  assertEquals(cacheControlOf(message.content[0]), { type: 'ephemeral' });
});

test('applyLastMessageCacheBreakpoint falls back to an earlier message when the last has no cacheable block', () => {
  const messages: MessagesMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning…' }] },
  ];
  applyLastMessageCacheBreakpoint(messages);
  const userContent = messages[0].content;
  const assistantContent = messages[1].content;
  assert(Array.isArray(userContent) && Array.isArray(assistantContent));
  assertEquals(cacheControlOf(userContent[0]), { type: 'ephemeral' });
  assertEquals(cacheControlOf(assistantContent[0]), undefined);
});
