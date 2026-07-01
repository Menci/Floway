import { test } from 'vitest';

import { withSpeedFast } from './handle-speed-fast.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent, MessagesUsage } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const baseUsage: MessagesUsage = { input_tokens: 10, output_tokens: 0 };

const makeCtx = (speed?: unknown): MessagesBoundaryCtx => ({
  payload: {
    model: 'claude-opus-4.6-fast',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(speed !== undefined ? { speed: speed as MessagesPayload['speed'] } : {}),
  },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const stubRequest = {};

const messageStart = (usage: MessagesUsage): ProtocolFrame<MessagesStreamEvent> => eventFrame<MessagesStreamEvent>({
  type: 'message_start',
  message: {
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

const messageDelta = (output_tokens: number): ProtocolFrame<MessagesStreamEvent> => eventFrame<MessagesStreamEvent>({
  type: 'message_delta',
  delta: { stop_reason: 'end_turn', stop_sequence: null },
  usage: { output_tokens },
});

const messageStop = (): ProtocolFrame<MessagesStreamEvent> => eventFrame<MessagesStreamEvent>({ type: 'message_stop' });

const streamResult = (frames: ProtocolFrame<MessagesStreamEvent>[]): ExecuteResult<ProtocolFrame<MessagesStreamEvent>> =>
  eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
      for (const frame of frames) yield frame;
    })(),
    testTelemetryModelIdentity,
  );

test('withSpeedFast strips speed=fast from the outbound payload', async () => {
  const ctx = makeCtx('fast');

  await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult([])));

  assertEquals('speed' in ctx.payload, false);
});

test('withSpeedFast strips speed=standard (semantically equivalent to omitted)', async () => {
  const ctx = makeCtx('standard');

  await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult([])));

  assertEquals('speed' in ctx.payload, false);
});

test('withSpeedFast leaves unknown speed values untouched so the upstream rejects them', async () => {
  // Anthropic returns 400 invalid_request_error on unknown enum values rather
  // than silently downgrading; the gateway mirrors that by passing the
  // unknown value through to Copilot, which will surface the same shape of
  // error. We never invent a fall-through here.
  const ctx = makeCtx('priority');

  await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult([])));

  assertEquals(ctx.payload.speed, 'priority');
});

test('withSpeedFast stamps usage.speed=fast on message_start when fast was requested', async () => {
  const ctx = makeCtx('fast');

  const result = await withSpeedFast(ctx, stubRequest, () =>
    Promise.resolve(streamResult([messageStart(baseUsage), messageStop(), doneFrame()])));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  const frames = await collect(result.events);
  assertEquals(frames, [
    messageStart({ ...baseUsage, speed: 'fast' }),
    messageStop(),
    doneFrame(),
  ]);
});

test('withSpeedFast stamps usage.speed=fast on every message_delta carrying usage', async () => {
  const ctx = makeCtx('fast');

  const result = await withSpeedFast(ctx, stubRequest, () =>
    Promise.resolve(streamResult([messageStart(baseUsage), messageDelta(7), messageStop()])));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  const frames = await collect(result.events);
  assertEquals(frames, [
    messageStart({ ...baseUsage, speed: 'fast' }),
    eventFrame<MessagesStreamEvent>({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7, speed: 'fast' },
    }),
    messageStop(),
  ]);
});

test('withSpeedFast leaves the stream untouched when speed is absent', async () => {
  const ctx = makeCtx();
  const frames = [messageStart(baseUsage), messageDelta(3), messageStop()];

  const result = await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult(frames)));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  // Cannot compare references after streaming, so reconstruct the expected list.
  assertEquals(await collect(result.events), frames);
});

test('withSpeedFast leaves the stream untouched when speed=standard (no fast intent to stamp)', async () => {
  const ctx = makeCtx('standard');
  const frames = [messageStart(baseUsage), messageStop()];

  const result = await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult(frames)));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events');
  assertEquals(await collect(result.events), frames);
});

test('withSpeedFast surfaces non-events results (api-error / internal-error) verbatim', async () => {
  const ctx = makeCtx('fast');

  const result = await withSpeedFast(ctx, stubRequest, () =>
    Promise.resolve({
      type: 'internal-error',
      status: 502,
      error: {
        type: 'internal_error',
        name: 'Error',
        message: 'boom',
        stack: '',
        target_api: 'messages',
      },
    }));

  assertEquals(result.type, 'internal-error');
});
