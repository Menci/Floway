import { afterEach, expect, test, vi } from 'vitest';

import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { buildChatUpstreamCallOptions } from '../../../../src/data-plane/chat/shared/upstream-call-options.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { streamingProviderCall } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test('stamps parsed model output before a provider waits for its final identity', async () => {
  let now = 110;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  let releaseOutput!: () => void;
  let releaseIdentity!: () => void;
  const outputReady = new Promise<void>(resolve => { releaseOutput = resolve; });
  const identityReady = new Promise<void>(resolve => { releaseIdentity = resolve; });
  const ctx = mockGatewayCtx();
  const candidate = stubModelCandidate();
  const opts = buildChatUpstreamCallOptions(candidate, ctx, new Headers(), 'openaiResponses');
  const raw: ProtocolFrame<unknown>[] = [
    { type: 'event', event: { type: 'response.output_item.added', output_index: 0, item: null } },
    { type: 'event', event: { type: 'response.output_text.delta', output_index: 0, item_id: 'upstream', delta: 'hello' } },
    { type: 'event', event: { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'upstream' } } },
  ];
  const source = await streamingProviderCall(Promise.resolve(new Response('', { headers: { 'content-type': 'text/event-stream' } })), () => (async function* () {
    yield raw[0];
    await outputReady;
    yield raw[1];
    await identityReady;
    yield raw[2];
  })(), 'wire-model', undefined, opts.observeStreamFrame);
  if (!source.ok) throw new Error('Expected upstream stream');
  const held: ProtocolFrame<unknown>[] = [];
  const transformed = (async function* () {
    for await (const frame of source.events) {
      if (frame.type === 'event' && (frame.event as { type: string }).type === 'response.output_text.delta') held.push(frame);
      else {
        yield* held.splice(0);
        yield frame;
      }
    }
  })();
  const result = await providerStreamResultToExecuteResult({ ...source, events: transformed }, candidate, 'openaiResponses', ctx, () => null);
  if (result.type !== 'events') throw new Error('Expected events');
  const iterator = result.events[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual(raw[0]);
  now = 500;
  releaseOutput();
  await vi.waitFor(() => { expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500); });
  expect(held).toEqual([raw[1]]);
  now = 15000;
  releaseIdentity();
  expect((await iterator.next()).value).toEqual(raw[1]);
  expect((await iterator.next()).value).toEqual(raw[2]);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
  expect(ctx.attempt.timing.firstOutputTokenAt).toBe(500);
  await result.finalMetadata;
});
