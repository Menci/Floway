import { describe, expect, it } from 'vitest';

import { withUpstreamTelemetry } from './upstream-telemetry.ts';
import type { GatewayCtx } from '../../chat/shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const iter = <T>(items: readonly T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() { for (const item of items) yield item; },
});

const stubCtx = (): GatewayCtx => ({
  apiKeyId: 'k',
  upstreamIds: null,
  wantsStream: true,
  backgroundScheduler: (p: Promise<unknown>) => { void p; },
  perfTiming: { firstOutputTokenAt: null, upstreamCallStartedAt: null },
  runtimeLocation: 'x',
  currentColo: 'x',
  dump: null,
  responseHeaders: new Headers(),
} as unknown as GatewayCtx);

describe('withUpstreamTelemetry', () => {
  it('stamps firstOutputTokenAt on the first generated-token frame (messages thinking_delta)', async () => {
    const ctx = stubCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'message_start' } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } } },
    ];
    const collected: ProtocolFrame<unknown>[] = [];
    for await (const f of withUpstreamTelemetry(iter(frames), ctx, 'messages')) collected.push(f);
    expect(collected).toEqual(frames);
    expect(ctx.perfTiming.firstOutputTokenAt).not.toBe(null);
  });

  it('leaves firstOutputTokenAt null when only envelope frames appear', async () => {
    const ctx = stubCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'response.created' } },
      { type: 'event', event: { type: 'response.output_item.added' } },
    ];
    for await (const _ of withUpstreamTelemetry(iter(frames), ctx, 'responses')) { /* drain */ }
    expect(ctx.perfTiming.firstOutputTokenAt).toBe(null);
  });

  it('stamps at most once even for many output-content frames', async () => {
    const ctx = stubCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { choices: [{ delta: { content: 'a' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'b' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'c' } }] } },
    ];
    const stampsAfterEachFrame: (number | null)[] = [];
    for await (const _ of withUpstreamTelemetry(iter(frames), ctx, 'chat-completions')) {
      stampsAfterEachFrame.push(ctx.perfTiming.firstOutputTokenAt);
    }
    expect(stampsAfterEachFrame[0]).not.toBe(null);
    // The subsequent frames must observe the exact same stamp — the wrapper
    // never overwrites once firstOutputTokenAt has been set.
    expect(stampsAfterEachFrame[1]).toBe(stampsAfterEachFrame[0]);
    expect(stampsAfterEachFrame[2]).toBe(stampsAfterEachFrame[0]);
  });
});
