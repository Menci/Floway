import { beforeEach, test } from 'vitest';

import type { GatewayCtx } from './gateway-ctx.ts';
import { withUpstreamTelemetry } from './upstream-telemetry.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { PerformanceTelemetryContext } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const CONTEXT: PerformanceTelemetryContext = {
  keyId: 'key_1',
  model: 'test-model',
  upstream: 'up_test',
  modelKey: 'test-model',
  stream: true,
  runtimeLocation: 'TEST',
};

const baseCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => {
  const downstream = new AbortController();
  return {
    apiKeyId: 'key_1',
    upstreamIds: null,
    wantsStream: true,
    requestStartedAt: 0,
    runtimeLocation: 'TEST',
    currentColo: 'TEST',
    dump: null,
    abortSignal: downstream.signal,
    downstreamAbortController: downstream,
    backgroundScheduler: promise => { void promise; },
    ...overrides,
  };
};

const drain = async <T>(events: AsyncIterable<ProtocolFrame<T>>): Promise<void> => {
  for await (const _ of events) {
  }
};

let repo: InMemoryRepo;
beforeEach(() => {
  repo = new InMemoryRepo();
  initRepo(repo);
});

const messagesEvents = async function* (events: readonly MessagesStreamEvent[]): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

test('records upstream_success latency on a target-owned terminal frame', async () => {
  const ctx = baseCtx();
  const wrapped = withUpstreamTelemetry(messagesEvents([{ type: 'message_stop' }]), ctx, CONTEXT, 'messages', 250);
  await drain(wrapped);

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 1);
  assertEquals(samples[0]?.requests, 1);
  assertEquals(samples[0]?.errors, 0);
  assertEquals(samples[0]?.totalMsSum, 250);
});

test('records upstream_success error when the protocol terminal is a failure event', async () => {
  const ctx = baseCtx();
  const wrapped = withUpstreamTelemetry(
    messagesEvents([{ type: 'error', error: { type: 'overloaded_error', message: 'rate-limited' } } as MessagesStreamEvent]),
    ctx,
    CONTEXT,
    'messages',
    250,
  );
  await drain(wrapped);

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 1);
  assertEquals(samples[0]?.requests, 0);
  assertEquals(samples[0]?.errors, 1);
  assertEquals(samples[0]?.totalMsSum, 0);
});

test('records upstream_success error on EOF without a terminal frame', async () => {
  const ctx = baseCtx();
  const noTerminal = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
    yield doneFrame();
  };
  const wrapped = withUpstreamTelemetry(noTerminal(), ctx, CONTEXT, 'messages', 250);
  await drain(wrapped);

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 1);
  assertEquals(samples[0]?.errors, 1);
  assertEquals(samples[0]?.requests, 0);
});

test('records upstream_success error when the upstream iterator throws mid-stream', async () => {
  const ctx = baseCtx();
  const explodes = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } });
    throw new Error('upstream connection reset');
  };
  let caught: unknown = null;
  try {
    await drain(withUpstreamTelemetry(explodes(), ctx, CONTEXT, 'messages', 250));
  } catch (e) { caught = e; }
  assertEquals(caught instanceof Error, true);

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 1);
  assertEquals(samples[0]?.errors, 1);
});

test('records nothing when the downstream consumer cancels via AbortSignal', async () => {
  const downstream = new AbortController();
  const ctx = baseCtx({ abortSignal: downstream.signal, downstreamAbortController: downstream });

  const slow = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'first' } });
    // Simulate a still-streaming upstream that the consumer cancels before
    // the terminal frame arrives. The flag must be set BEFORE the iterator
    // ends naturally — that's the cancel-vs-EOF distinction the wrapper
    // explicitly disambiguates.
  };

  const wrapped = withUpstreamTelemetry(slow(), ctx, CONTEXT, 'messages', 250);
  const iterator = wrapped[Symbol.asyncIterator]();
  await iterator.next();
  downstream.abort();
  await drain({
    [Symbol.asyncIterator]: () => iterator,
  });

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 0);
});

test('chat-completions terminal is the protocol DONE sentinel', async () => {
  const ctx = baseCtx();
  const events = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    yield doneFrame();
  };
  const wrapped = withUpstreamTelemetry(events(), ctx, CONTEXT, 'chat-completions', 250);
  await drain(wrapped);

  const samples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(samples.length, 1);
  assertEquals(samples[0]?.requests, 1);
  assertEquals(samples[0]?.totalMsSum, 250);
});
