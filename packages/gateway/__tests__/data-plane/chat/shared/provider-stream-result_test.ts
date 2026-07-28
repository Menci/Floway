import { describe, expect, test } from 'vitest';

import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { mockGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const iter = <T>(items: readonly T[]): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() { for (const item of items) yield item; },
});

const okStreamResult = <T>(events: AsyncIterable<ProtocolFrame<T>>): ProviderStreamResult<T> => ({
  ok: true,
  events,
  modelKey: 'test-model-key',
});

const drainEvents = async <T>(result: Awaited<ReturnType<typeof providerStreamResultToExecuteResult<T>>>): Promise<ProtocolFrame<T>[]> => {
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const collected: ProtocolFrame<T>[] = [];
  for await (const frame of result.events) collected.push(frame);
  return collected;
};

describe('providerStreamResultToExecuteResult (first-output-token stamping)', () => {
  test('stamps firstOutputTokenAt on the first generated-token frame (messages thinking_delta)', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'message_start' } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '...' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } },
      { type: 'event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'messages', ctx, () => null);
    const collected = await drainEvents(result);
    expect(collected).toEqual(frames);
    expect(ctx.attempt.firstOutputTokenAt).not.toBe(null);
  });

  test('leaves firstOutputTokenAt null when only envelope frames appear', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { type: 'response.created' } },
      { type: 'event', event: { type: 'response.output_item.added' } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'responses', ctx, () => null);
    await drainEvents(result);
    expect(ctx.attempt.firstOutputTokenAt).toBe(null);
  });

  test('stamps at most once even for many output-content frames', async () => {
    const ctx = mockGatewayCtx();
    const frames: ProtocolFrame<unknown>[] = [
      { type: 'event', event: { choices: [{ delta: { content: 'a' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'b' } }] } },
      { type: 'event', event: { choices: [{ delta: { content: 'c' } }] } },
    ];
    const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'chat-completions', ctx, () => null);
    if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
    const stampsAfterEachFrame: (number | null)[] = [];
    for await (const _ of result.events) stampsAfterEachFrame.push(ctx.attempt.firstOutputTokenAt);
    expect(stampsAfterEachFrame[0]).not.toBe(null);
    // The subsequent frames must observe the exact same stamp — the stamping
    // hook never overwrites once firstOutputTokenAt has been set.
    expect(stampsAfterEachFrame[1]).toBe(stampsAfterEachFrame[0]);
    expect(stampsAfterEachFrame[2]).toBe(stampsAfterEachFrame[0]);
  });
});

test('an abandoned stream still settles its metadata instead of hanging the caller', async () => {
  // Every streaming response resolves its cost through finalMetadata, and the
  // respond layer awaits it in a finally. A transport that walks away without
  // closing the generator would hang that await forever.
  const abort = new AbortController();
  const ctx = { ...mockGatewayCtx(), abortSignal: abort.signal };
  const frames: ProtocolFrame<unknown>[] = [{ type: 'event', event: { type: 'response.created' } }];

  const result = await providerStreamResultToExecuteResult(okStreamResult(iter(frames)), stubModelCandidate(), 'responses', ctx, () => null);
  expect(result.type).toBe('events');
  if (result.type !== 'events') return;

  // Never iterate the events; just abandon them.
  abort.abort();

  expect((await result.finalMetadata!).modelIdentity).toBeDefined();
});
