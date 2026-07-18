import { expect, test } from 'vitest';

import { createChatCompletionsToMessagesStreamState, flushChatCompletionsToMessagesEvents, mapChatCompletionsUsageToMessagesUsage, translateChatCompletionsChunkToMessagesEvents } from './events.ts';
import { assertEquals, assertFalse } from '../test-assert.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';

const chunk = (delta: ChatCompletionsStreamEvent['choices'][0]['delta'], finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const usageChunk = (): ChatCompletionsStreamEvent => ({
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
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_opaque: 'enc_old' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_opaque: 'enc_only' }), state),
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
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', reasoning_opaque: 'old' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ reasoning_text: 'trace' }), state),
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

// Some OpenAI-shaped upstreams (notably gpt-4o-2024-05-13) interleave a
// `content` delta in the middle of a tool_call's argument fragments. The
// naive translation closes the tool_use block on the first content delta,
// which then makes the trailing argument fragments land against a stopped
// block index — Anthropic clients reject those. We defer the interleaved
// content and flush it as a fresh text block AFTER the tool_use block
// closes for real. Regression scenario ported from
// https://github.com/caozhiyuan/copilot-api/commit/51675f73de7983093c857d68ddd61bcd09f1806a
test('translateChatCompletionsChunkToMessagesEvents defers content interleaved between tool_call argument fragments', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'get_weather', arguments: '' } }] }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ content: 'I will check that.' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ tool_calls: [{ index: 0, function: { arguments: 'ation": "Paris"}' } }] }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'tool_calls'), state),
    ...flushChatCompletionsToMessagesEvents(state),
  ];

  assertEquals(events.slice(1), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_weather', name: 'get_weather', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"loc' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'ation": "Paris"}' },
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
      delta: { type: 'text_delta', text: 'I will check that.' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

// A single chunk delta can carry BOTH `content` and `tool_calls` arrays. If
// we emit the content first, we open a text block, then close it immediately
// because the tool_use block is about to open — and any trailing argument
// fragments for the same tool_call would land against a stopped block index.
// Mirrors caozhiyuan's gating
// (https://github.com/caozhiyuan/copilot-api/blob/main/src/routes/messages/stream-translation.ts#L240):
// `isToolBlockOpen(state) || hasToolCallDelta(delta)` defers the content
// rather than emitting it before the tool_use block opens.
test('translateChatCompletionsChunkToMessagesEvents defers content that shares a chunk with tool_calls before any tool block opens', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(
      chunk({ content: 'foo', tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'f', arguments: '' } }] }),
      state,
    ),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'tool_calls'), state),
    ...flushChatCompletionsToMessagesEvents(state),
  ];

  assertEquals(events.slice(1), [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_x', name: 'f', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
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
      delta: { type: 'text_delta', text: 'foo' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
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
    total_tokens: 120,
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
    total_tokens: 120,
  });
  assertEquals(usage.input_tokens, 100);
  assertEquals(usage.cache_read_input_tokens, undefined);
});

// OpenAI-shaped upstreams reuse prompt_tokens_details to surface Anthropic-style
// cache_creation_input_tokens. The Chat-side total already includes both cache
// buckets (cached_tokens reads + cache_creation writes), mirroring how
// prompt_tokens already includes cached_tokens. We subtract both buckets from
// input_tokens and surface cache_creation_input_tokens on the way out so
// Anthropic clients see the same split they would have seen on a native
// Messages upstream. The reverse direction at
// packages/translate/src/chat-completions-via-messages/events.ts already adds
// cache_creation_input_tokens back into prompt_tokens, so this closes a real
// asymmetry. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
test('mapChatCompletionsUsageToMessagesUsage surfaces cache_creation_input_tokens and subtracts it from input_tokens', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 30, cache_creation_input_tokens: 40 },
  });
  assertEquals(usage.input_tokens, 30);
  assertEquals(usage.output_tokens, 20);
  assertEquals(usage.cache_read_input_tokens, 30);
  assertEquals(usage.cache_creation_input_tokens, 40);
});

test('mapChatCompletionsUsageToMessagesUsage surfaces cache_creation_input_tokens alone when cached_tokens is absent', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cache_creation_input_tokens: 50 },
  });
  assertEquals(usage.input_tokens, 30);
  assertEquals(usage.cache_read_input_tokens, undefined);
  assertEquals(usage.cache_creation_input_tokens, 50);
});

test('mapChatCompletionsUsageToMessagesUsage accepts cache_write_tokens from OpenRouter-shaped upstreams', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
  });
  assertEquals(usage.input_tokens, 30);
  assertEquals(usage.cache_read_input_tokens, 20);
  assertEquals(usage.cache_creation_input_tokens, 30);
});

test('mapChatCompletionsUsageToMessagesUsage prefers canonical cache_creation_input_tokens', () => {
  const usage = mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cache_creation_input_tokens: 30, cache_write_tokens: 20 },
  });
  assertEquals(usage.input_tokens, 50);
  assertEquals(usage.cache_creation_input_tokens, 30);
});

test('mapChatCompletionsUsageToMessagesUsage rejects malformed inclusive cache counts', () => {
  expect(() => mapChatCompletionsUsageToMessagesUsage({
    prompt_tokens: 40,
    completion_tokens: 10,
    total_tokens: 50,
    prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
  })).toThrowError(RangeError);
});

test('translateChatCompletionsChunkToMessagesEvents surfaces service_tier:fast as usage.speed:fast in message_delta', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
    ...translateChatCompletionsChunkToMessagesEvents(
      {
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [],
        service_tier: 'fast',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      state,
    ),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertEquals((messageDelta as { usage: { speed?: string } }).usage.speed, 'fast');
});

test('translateChatCompletionsChunkToMessagesEvents omits usage.speed when service_tier is not fast', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
    ...translateChatCompletionsChunkToMessagesEvents(
      {
        id: 'chatcmpl_test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'gpt-test',
        choices: [],
        service_tier: 'default',
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
      state,
    ),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  const usage = (messageDelta as { usage: Record<string, unknown> }).usage;
  assertFalse('speed' in usage);
  assertEquals(usage.service_tier, 'default');
});

test('translateChatCompletionsChunkToMessagesEvents omits usage.speed when service_tier is absent', () => {
  const state = createChatCompletionsToMessagesStreamState();
  const events = [
    ...translateChatCompletionsChunkToMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateChatCompletionsChunkToMessagesEvents(chunk({}, 'stop'), state),
    ...translateChatCompletionsChunkToMessagesEvents(usageChunk(), state),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertFalse('speed' in (messageDelta as { usage: Record<string, unknown> }).usage);
});
