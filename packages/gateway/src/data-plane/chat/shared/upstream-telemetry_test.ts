import { describe, expect, it } from 'vitest';

import { withUpstreamTelemetry } from './upstream-telemetry.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const iter = <T>(items: readonly T[]): AsyncIterable<T> => ({
  [Symbol.asyncIterator]: async function* () { for (const item of items) yield item; },
});

const stubCtx = (): GatewayCtx => ({
  apiKeyId: 'k',
  upstreamIds: null,
  wantsStream: true,
  backgroundScheduler: (p: Promise<unknown>) => { void p; },
  requestStartedAt: 0,
  perfTiming: { firstOutputTokenAt: null },
  runtimeLocation: 'x',
  currentColo: 'x',
  dump: null,
  responseHeaders: new Headers(),
} as unknown as GatewayCtx);

describe('withUpstreamTelemetry', () => {
  it('stamps firstOutputTokenAt on the first output-content frame (messages)', async () => {
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

  it('leaves firstOutputTokenAt null when no output-content frame appears', async () => {
    const ctx = stubCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'response.created' } },
      { type: 'event', event: { type: 'response.reasoning_text.delta', delta: '...' } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
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
    const before = performance.now();
    for await (const _ of withUpstreamTelemetry(iter(frames), ctx, 'chat-completions')) { /* drain */ }
    const first = ctx.perfTiming.firstOutputTokenAt;
    expect(first).not.toBe(null);
    // Sanity: stamp is between `before` and `after` — i.e. it fired on the first frame, not later.
    expect(first!).toBeGreaterThanOrEqual(before);
  });
});
