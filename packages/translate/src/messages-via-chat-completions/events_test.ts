import { test } from 'vitest';

import { createChatCompletionsToMessagesStreamState, flushChatCompletionsToMessagesEvents, mapChatCompletionsUsageToMessagesUsage, translateChatCompletionsChunkToMessagesEvents } from './events.ts';
import { assertEquals, assertFalse } from '../test-assert.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';

const chunk = (delta: ChatCompletionChunk['choices'][0]['delta'], finishReason: ChatCompletionChunk['choices'][0]['finish_reason'] = null): ChatCompletionChunk => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const usageChunk = (): ChatCompletionChunk => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
  },
});

test('translateChatCompletionsChunkToMessagesEvents emits opaque-only reasoning as redacted_thinking at finish', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_opaque: 'enc_only' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 3), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'enc_only' },
    },
    { type: 'content_block_stop', index: 0 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents emits opaque-only reasoning after closing prior text block', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'answer' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'enc' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 6), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'answer' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: 'enc' },
    },
    { type: 'content_block_stop', index: 1 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents preserves opaque reasoning before later text', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_opaque: 'enc' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 6), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'enc' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
    { type: 'content_block_stop', index: 1 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents keeps text and opaque in one thinking block', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'sig' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 5), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
    { type: 'content_block_stop', index: 0 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents emits early opaque after later thinking text', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_opaque: 'sig' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 5), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
    { type: 'content_block_stop', index: 0 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents keeps late opaque with prior reasoning text', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'sig' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 7), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents preserves later opaque-only reasoning after earlier thinking', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ content: 'answer' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'sig1' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'sig2' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 10), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig1' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'sig2' },
    },
    { type: 'content_block_stop', index: 2 },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents omits signature for text-only reasoning', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_text: 'trace' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
  ];

  assertEquals(events.slice(1, 4), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    },
    { type: 'content_block_stop', index: 0 },
  ]);
  assertFalse(events.some(event => event.type === 'content_block_delta' && event.delta.type === 'signature_delta'));
});

test('translateChatCompletionsChunkToMessagesEvents merges final usage-only chunk before message_stop', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'answer' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
    ...translateChatCompletionsChunkToMessagesEvents(usageChunk(), state),
  ];

  assertEquals(events.slice(-2), [
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: 12,
        output_tokens: 4,
      },
    },
    { type: 'message_stop' },
  ]);
});

test('flushChatCompletionsToMessagesEvents emits pending stop when no usage-only chunk arrives', () => {
  const state = createChatCompletionsToMessagesStreamState();

  translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'answer' }), state);
  const finishEvents = translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state);

  assertFalse(finishEvents.some(event => event.type === 'message_stop'));
  assertEquals(flushChatCompletionsToMessagesEvents(state), [
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

test('translateChatCompletionsChunkToMessagesEvents ignores empty tool_calls arrays', () => {
  const state = createChatCompletionsToMessagesStreamState();
  // First chunk with role: "assistant" and empty tool_calls.
  // Before the fix (choice.delta.tool_calls), empty [] was truthy and
  // entered the tool-calls branch, which could close an open text block
  // prematurely. After the fix (choice.delta.tool_calls?.length), empty
  // arrays are treated as absent.
  const events1 = translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', tool_calls: [] }), state);
  // First event should be message_start (from role), not any tool-call handling.
  // No content yet, so no content_block_start.
  assertEquals(events1.length, 1);
  assertEquals(events1[0].type, 'message_start');

  // Second chunk with content — should start a text block normally.
  const events2 = translateChatCompletionsChunkToMessagesEvents(chunk({ content: 'hello' }), state);
  assertEquals(events2.length, 2);
  assertEquals(events2[0].type, 'content_block_start');
  assertEquals(events2[1].type, 'content_block_delta');

  // Finish with stop.
  const events3 = translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state);
  const textBlocks = events3.filter(e => e.type === 'content_block_stop');
  assertEquals(textBlocks.length, 1, 'only one text block should have been closed');
});

test('mapChatCompletionsUsageToMessagesUsage maps OpenAI cached_tokens to cache_read_input_tokens', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 60 },
  });
  assertEquals(usage.input_tokens, 40);
  assertEquals(usage.output_tokens, 20);
  assertEquals(usage.cache_read_input_tokens, 60);
});

test('mapChatCompletionsUsageToMessagesUsage omits cache_read_input_tokens when no cache field', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
  });
  assertEquals(usage.input_tokens, 100);
  assertEquals(usage.cache_read_input_tokens, undefined);
});
