import { expect, test } from 'vitest';

import { createAnthropicMessagesBillableUsageReader } from '../../../../src/data-plane/chat/anthropic-messages/usage.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';

const read = (events: AnthropicMessagesStreamEvent[]) => {
  const reader = createAnthropicMessagesBillableUsageReader();
  let last = null;
  for (const event of events) {
    const usage = reader(event);
    if (usage !== null) last = usage;
  }
  return last;
};

const start = (usage: Record<string, unknown>): AnthropicMessagesStreamEvent => ({
  type: 'message_start',
  message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage },
} as unknown as AnthropicMessagesStreamEvent);

const delta = (usage: Record<string, unknown>): AnthropicMessagesStreamEvent => ({
  type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage,
} as unknown as AnthropicMessagesStreamEvent);

test('Anthropic Messages billable usage merges input from message_start with output from message_delta', () => {
  expect(read([start({ input_tokens: 10, output_tokens: 0 }), delta({ output_tokens: 7 })]))
    .toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 7 });
});

test('Anthropic Messages billable usage keeps the per-TTL cache-creation split the protocol reports natively', () => {
  expect(read([
    start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }),
    delta({ output_tokens: 7 }),
  ])).toEqual({ input: 10, cacheRead: 30, cacheWrite: 4, cacheWrite1h: 5, output: 7 });
});

test('Anthropic Messages billable usage reports the served speed as the tier', () => {
  expect(read([start({ input_tokens: 1, output_tokens: 1, speed: 'fast' })])?.tier).toBe('fast');
});

// Anthropic states a bucket that does not apply to the request as `null` on
// either usage carrier, and a `message_delta` that nulls the input-side
// counters is not a correction of what `message_start` already billed.
// https://github.com/anthropics/anthropic-sdk-python/issues/994
test('Messages billable usage bills a turn whose upstream nulls its cache counters', () => {
  expect(read([
    start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 9, cache_creation: null }),
    delta({ input_tokens: null, output_tokens: 7, cache_read_input_tokens: null, cache_creation_input_tokens: null }),
  ])).toEqual({ input: 10, cacheRead: 30, cacheWrite: 9, cacheWrite1h: 0, output: 7 });
});
