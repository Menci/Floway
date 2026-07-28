import { expect, test } from 'vitest';

import { createMessagesBillableUsageReader } from '../../../../src/data-plane/chat/messages/usage.ts';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

const read = (events: MessagesStreamEvent[]) => {
  const reader = createMessagesBillableUsageReader();
  let last = null;
  for (const event of events) {
    const usage = reader(event);
    if (usage !== null) last = usage;
  }
  return last;
};

const start = (usage: Record<string, unknown>): MessagesStreamEvent => ({
  type: 'message_start',
  message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage },
} as unknown as MessagesStreamEvent);

const delta = (usage: Record<string, unknown>): MessagesStreamEvent => ({
  type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage,
} as unknown as MessagesStreamEvent);

test('Messages billable usage merges input from message_start with output from message_delta', () => {
  expect(read([start({ input_tokens: 10, output_tokens: 0 }), delta({ output_tokens: 7 })]))
    .toEqual({ input: 10, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 7 });
});

test('Messages billable usage keeps the per-TTL cache-creation split the protocol reports natively', () => {
  expect(read([
    start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }),
    delta({ output_tokens: 7 }),
  ])).toEqual({ input: 10, cacheRead: 30, cacheWrite: 4, cacheWrite1h: 5, output: 7 });
});

test('Messages billable usage reports the served speed as the tier', () => {
  expect(read([start({ input_tokens: 1, output_tokens: 1, speed: 'fast' })])?.tier).toBe('fast');
});
