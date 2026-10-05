import { expect, test } from 'vitest';

import { createOpenAIChatCompletionsToAnthropicMessagesStreamState, flushOpenAIChatCompletionsToAnthropicMessagesEvents, mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage, translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents } from '../../src/anthropic-messages-via-openai-chat-completions/events.ts';
import type { OpenAIChatCompletionsUsageEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, assertExists, assertFalse } from '@floway-dev/test-utils';

const chunk = (delta: OpenAIChatCompletionsStreamEvent['choices'][0]['delta'], finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

type OpenAIChatCompletionsUsage = OpenAIChatCompletionsUsageEx;

const usageChunk = (overrides: Partial<OpenAIChatCompletionsUsage> = {}): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    ...overrides,
  },
});

const chunkWithUsage = (
  delta: OpenAIChatCompletionsStreamEvent['choices'][0]['delta'],
  usage: Partial<OpenAIChatCompletionsUsage>,
  finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null,
): OpenAIChatCompletionsStreamEvent => ({
  ...chunk(delta, finishReason),
  usage: {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    ...usage,
  },
});

test('OpenAI Chat Completions refusal deltas become Anthropic Messages refusal stop details', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  const events = [
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: null, refusal: '' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ refusal: 'I cannot help with that.' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(usageChunk(), state),
    ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
  ];

  assertEquals(events.slice(-2), [
    {
      type: 'message_delta',
      delta: {
        container: null,
        stop_reason: 'refusal',
        stop_details: {
          type: 'refusal',
          category: null,
          explanation: 'I cannot help with that.',
        },
        stop_sequence: null,
      },
      usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, input_tokens: 12, output_tokens: 4 },
    },
    { type: 'message_stop' },
  ]);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents merges final usage-only chunk before message_stop', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  const events = [
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: 'answer' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(usageChunk(), state),
    ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
  ];

  assertEquals(events.slice(-2), [
    {
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null,
        input_tokens: 12,
        output_tokens: 4,
      },
    },
    { type: 'message_stop' },
  ]);
});

test('flushOpenAIChatCompletionsToAnthropicMessagesEvents emits pending stop when no usage-only chunk arrives', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();

  translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: 'answer' }), state);
  const finishEvents = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state);

  assertFalse(finishEvents.some(event => event.type === 'message_stop'));
  assertEquals(flushOpenAIChatCompletionsToAnthropicMessagesEvents(state), [
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
      usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents ignores empty tool_calls arrays', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  // A role-only chunk with an empty tool_calls array must not open the message
  // or any content block. Deferring message_start lets a following
  // continuous_usage_stats chunk supply the real input token count.
  const events1 = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', tool_calls: [] }), state);
  assertEquals(events1, []);

  // The first chunk with content opens message_start and the text block.
  const events2 = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ content: 'hello' }), state);
  assertEquals(events2.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta']);

  const events3 = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state);
  const textBlocks = [...events3, ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state)].filter(e => e.type === 'content_block_stop');
  assertEquals(textBlocks.length, 1, 'only one text block should have been closed');
});
test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage maps OpenAI cached_tokens to cache_read_input_tokens', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_tokens_details: { cached_tokens: 60 },
  });
  assertEquals(usage.input_tokens, 40);
  assertEquals(usage.output_tokens, 20);
  assertEquals(usage.cache_read_input_tokens, 60);
});

test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage states cache_read_input_tokens as null when no cache field', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  assertEquals(usage.input_tokens, 100);
  assertEquals(usage.cache_read_input_tokens, null);
});

// OpenAI-shaped upstreams reuse prompt_tokens_details to surface Anthropic-style
// cache_creation_input_tokens. The OpenAI-Chat-Completions-side total already includes both cache
// buckets (cached_tokens reads + cache_creation writes), mirroring how
// prompt_tokens already includes cached_tokens. We subtract both buckets from
// input_tokens and surface cache_creation_input_tokens on the way out so
// Anthropic clients see the same split they would have seen on a native
// Anthropic Messages upstream. The reverse direction at
// packages/translate/src/openai-chat-completions-via-anthropic-messages/events.ts already adds
// cache_creation_input_tokens back into prompt_tokens, so this closes a real
// asymmetry. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage surfaces cache_creation_input_tokens and subtracts it from input_tokens', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
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

test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage surfaces cache_creation_input_tokens alone when cached_tokens is absent', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cache_creation_input_tokens: 50 },
  });
  assertEquals(usage.input_tokens, 30);
  assertEquals(usage.cache_read_input_tokens, null);
  assertEquals(usage.cache_creation_input_tokens, 50);
});

test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage accepts cache_write_tokens from OpenRouter-shaped upstreams', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
  });
  assertEquals(usage.input_tokens, 30);
  assertEquals(usage.cache_read_input_tokens, 20);
  assertEquals(usage.cache_creation_input_tokens, 30);
});

test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage prefers canonical cache_creation_input_tokens', () => {
  const usage = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 80,
    completion_tokens: 10,
    total_tokens: 90,
    prompt_tokens_details: { cache_creation_input_tokens: 30, cache_write_tokens: 20 },
  });
  assertEquals(usage.input_tokens, 50);
  assertEquals(usage.cache_creation_input_tokens, 30);
});

test('mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage rejects malformed inclusive cache counts', () => {
  expect(() => mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage({
    prompt_tokens: 40,
    completion_tokens: 10,
    total_tokens: 50,
    prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
  })).toThrowError(RangeError);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents omits late service tier metadata from message_delta', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  const events = [
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
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
    ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  assertExists(messageDelta?.usage);
  assertFalse('speed' in messageDelta.usage);
  assertFalse('service_tier' in messageDelta.usage);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents omits usage.speed when service_tier is not fast', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  const events = [
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
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
    ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  const usage = messageDelta?.usage;
  assertExists(usage);
  assertFalse('speed' in usage);
  assertFalse('service_tier' in usage);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents omits usage.speed when service_tier is absent', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  const events = [
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant', content: 'hi' }), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state),
    ...translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(usageChunk(), state),
    ...flushOpenAIChatCompletionsToAnthropicMessagesEvents(state),
  ];

  const messageDelta = events.find(event => event.type === 'message_delta');
  const usage = messageDelta?.usage;
  assertExists(usage);
  assertFalse('speed' in usage);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents reports real input_tokens when continuous usage arrives before content', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();

  // vLLM shape: a role-only first chunk, then a usage-only chunk before content.
  assertEquals(translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant' }), state), []);

  const start = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
    usageChunk({ prompt_tokens: 47, completion_tokens: 0, total_tokens: 47 }),
    state,
  );

  assertEquals(start, [
    {
      type: 'message_start',
      message: {
        container: null, diagnostics: null, stop_details: null,
        id: 'msg_chatcmpl_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'gpt-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 47, output_tokens: 0 },
      },
    },
  ]);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents emits cumulative usage updates as continuous usage advances', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();

  translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({ role: 'assistant' }), state);
  translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
    usageChunk({ prompt_tokens: 47, completion_tokens: 0, total_tokens: 47 }),
    state,
  );

  assertEquals(
    translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
      usageChunk({ prompt_tokens: 47, completion_tokens: 1, total_tokens: 48 }),
      state,
    ),
    [
      {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: null, stop_sequence: null },
        usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, input_tokens: 47, output_tokens: 1 },
      },
    ],
  );

  assertEquals(
    translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
      usageChunk({ prompt_tokens: 47, completion_tokens: 4, total_tokens: 51 }),
      state,
    ),
    [
      {
        type: 'message_delta',
        delta: { container: null, stop_details: null, stop_reason: null, stop_sequence: null },
        usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, input_tokens: 47, output_tokens: 4 },
      },
    ],
  );

  // A repeated cumulative counter is not re-emitted.
  assertEquals(
    translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
      usageChunk({ prompt_tokens: 47, completion_tokens: 4, total_tokens: 51 }),
      state,
    ),
    [],
  );

  assertEquals(translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(chunk({}, 'stop'), state), []);
  assertEquals(flushOpenAIChatCompletionsToAnthropicMessagesEvents(state), [
    {
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
      usage: { cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, input_tokens: 47, output_tokens: 4 },
    },
    { type: 'message_stop' },
  ]);
});

test('translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents carries content-chunk usage into message_start before the delta', () => {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();

  // SGLang shape: usage rides on the first content chunk instead of a separate
  // usage-only chunk. message_start must still precede the content delta.
  const events = translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(
    chunkWithUsage(
      { role: 'assistant', content: 'hi' },
      { prompt_tokens: 23, completion_tokens: 1, total_tokens: 24 },
    ),
    state,
  );

  assertEquals(events.map(event => event.type), ['message_start', 'content_block_start', 'content_block_delta']);

  const start = events[0];
  assertEquals(start.type, 'message_start');
  if (start.type === 'message_start') {
    assertEquals(start.message.usage.input_tokens, 23);
    assertEquals(start.message.usage.output_tokens, 1);
  }
});
