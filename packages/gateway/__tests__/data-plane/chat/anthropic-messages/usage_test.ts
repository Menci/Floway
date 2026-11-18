import { expect, test } from 'vitest';

import { createAnthropicMessagesBillableUsageReader } from '../../../../src/data-plane/chat/anthropic-messages/usage.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const read = (events: AnthropicMessagesStreamEventEx[]) => {
  const reader = createAnthropicMessagesBillableUsageReader();
  let last = null;
  for (const event of events) {
    const usage = reader(event);
    if (usage !== null) last = usage;
  }
  return last;
};

const start = (usage: Record<string, unknown>): AnthropicMessagesStreamEventEx => ({
  type: 'message_start',
  message: { container: null, diagnostics: null, stop_details: null, id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage },
} as unknown as AnthropicMessagesStreamEventEx);

const delta = (usage: Record<string, unknown>): AnthropicMessagesStreamEventEx => ({
  type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' }, usage,
} as unknown as AnthropicMessagesStreamEventEx);

test('Anthropic Messages billable usage keeps the per-TTL cache-creation split the protocol reports natively', () => {
  expect(read([
    start({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } }),
    delta({ output_tokens: 7 }),
  ])).toEqual({ input: 10, cacheRead: 30, cacheWrite: 4, cacheWrite1h: 5, output: 7 });
});
