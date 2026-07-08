import { test } from 'vitest';

import type { GatewayCtx } from './gateway-ctx.ts';
import { withUpstreamTelemetry } from './upstream-telemetry.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { assertEquals } from '@floway-dev/test-utils';

const baseCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => {
  const downstream = new AbortController();
  return {
    apiKeyId: 'key_1',
    upstreamIds: null,
    wantsStream: true,
    requestStartedAt: 0,

    perfTiming: { firstOutputTokenAt: null },
    runtimeLocation: 'TEST',
    currentColo: 'TEST',
    dump: null,
    responseHeaders: new Headers(),
    abortSignal: downstream.signal,
    downstreamAbortController: downstream,
    backgroundScheduler: promise => { void promise; },
    ...overrides,
  };
};

const collect = async <T>(events: AsyncIterable<ProtocolFrame<T>>): Promise<ProtocolFrame<T>[]> => {
  const out: ProtocolFrame<T>[] = [];
  for await (const frame of events) out.push(frame);
  return out;
};

test('passes all frames through unchanged', async () => {
  const ctx = baseCtx();
  const input: ProtocolFrame<MessagesStreamEvent>[] = [
    eventFrame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'x', stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }),
    eventFrame({ type: 'message_stop' }),
    doneFrame(),
  ];
  const source = async function* () { for (const f of input) yield f; };
  const output = await collect(withUpstreamTelemetry(source(), ctx, 'messages'));
  assertEquals(output.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assertEquals(output[i], input[i]);
  }
});
