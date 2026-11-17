import { test } from 'vitest';

import { withSpeedFast } from '../../../src/interceptors/anthropic-messages/handle-speed-fast.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx, AnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const baseUsage: AnthropicMessagesUsage = { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 10, output_tokens: 0 };

const makeCtx = (speed?: unknown): AnthropicMessagesBoundaryCtx => ({
  payload: {
    model: 'claude-opus-4.6-fast',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(speed !== undefined ? { speed: speed as AnthropicMessagesPayload['speed'] } : {}),
  },
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const stubRequest = {};

const messageStart = (usage: AnthropicMessagesUsage): ProtocolFrame<AnthropicMessagesStreamEventEx> => eventFrame<AnthropicMessagesStreamEventEx>({
  type: 'message_start',
  message: {
    container: null, diagnostics: null, stop_details: null,
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-opus-4.6-fast',
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
});

const messageDelta = (output_tokens: number): ProtocolFrame<AnthropicMessagesStreamEventEx> => eventFrame<AnthropicMessagesStreamEventEx>({
  type: 'message_delta',
  delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
  usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens },
});

const messageStop = (): ProtocolFrame<AnthropicMessagesStreamEventEx> => eventFrame<AnthropicMessagesStreamEventEx>({ type: 'message_stop' });

const streamResult = (frames: ProtocolFrame<AnthropicMessagesStreamEventEx>[]): ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>> =>
  eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
      for (const frame of frames) yield frame;
    })(),
    testTelemetryModelIdentity,
  );

test('withSpeedFast strips speed=standard (semantically equivalent to omitted)', async () => {
  const ctx = makeCtx('standard');

  await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult([])));

  assertEquals('speed' in ctx.payload, false);
});

test('withSpeedFast keeps fast mode metadata on message_start and leaves message_delta unchanged', async () => {
  const ctx = makeCtx('fast');

  const result = await withSpeedFast(ctx, stubRequest, () =>
    Promise.resolve(streamResult([messageStart(baseUsage), messageDelta(7), messageStop()])));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  const frames = await collect(result.events);
  assertEquals(frames, [
    messageStart({ ...baseUsage, speed: 'fast' }),
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'message_delta',
      delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 7 },
    }),
    messageStop(),
  ]);
});

test('withSpeedFast leaves the stream untouched when speed=standard (no fast intent to stamp)', async () => {
  const ctx = makeCtx('standard');
  const frames = [messageStart(baseUsage), messageStop()];

  const result = await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult(frames)));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  assertEquals(await collect(result.events), frames);
});
