import { test } from 'vitest';

import { type Interceptor, runInterceptors } from './interceptors.ts';
import { assertEquals } from '../../test-assert.ts';
import { eventResult, type ExecuteResult } from './shared/errors/result.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

const collectFrames = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const frames: T[] = [];
  for await (const frame of events) frames.push(frame);
  return frames;
};

const testTelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

type TestResult = ExecuteResult<ProtocolFrame<string>>;
type TestRequest = { traceId: string };

test('runInterceptors lets an interceptor patch context before run and patch result after run', async () => {
  const ctx = { payload: { value: 'original' } };
  const request: TestRequest = { traceId: 't1' };

  const interceptor: Interceptor<typeof ctx, TestRequest, TestResult> = async (current, _request, run) => {
    current.payload.value = 'patched';
    const patched = current.payload.value;
    const result = await run();
    if (result.type !== 'events') return result;

    return {
      ...result,
      events: (async function* () {
        for await (const frame of result.events) {
          yield frame.type === 'event' ? eventFrame(`${frame.event}:${patched}`) : frame;
        }
      })(),
    };
  };

  const result = await runInterceptors(ctx, request, [interceptor], () => Promise.resolve(makeResult(ctx.payload.value)));

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');
  assertEquals(ctx.payload.value, 'patched');
  assertEquals(await collectFrames(result.events), [eventFrame('patched:patched')]);
});

test('runInterceptors composes interceptors in nested order', async () => {
  const calls: string[] = [];
  const ctx = { payload: { value: 'ok' } };
  const request: TestRequest = { traceId: 't2' };

  const outer: Interceptor<typeof ctx, TestRequest, TestResult> = async (_ctx, _request, run) => {
    calls.push('outer-before');
    const result = await run();
    calls.push('outer-after');
    return result;
  };
  const inner: Interceptor<typeof ctx, TestRequest, TestResult> = async (_ctx, _request, run) => {
    calls.push('inner-before');
    const result = await run();
    calls.push('inner-after');
    return result;
  };

  await runInterceptors(ctx, request, [outer, inner], () => {
    calls.push('terminal');
    return Promise.resolve(makeResult(ctx.payload.value));
  });

  assertEquals(calls, ['outer-before', 'inner-before', 'terminal', 'inner-after', 'outer-after']);
});

test('runInterceptors lets an interceptor inspect an upstream error and retry', async () => {
  const ctx = { payload: { value: 'broken' } };
  const request: TestRequest = { traceId: 't3' };
  let attempts = 0;

  const interceptor: Interceptor<typeof ctx, TestRequest, TestResult> = async (current, _request, run) => {
    const first = await run();
    if (first.type !== 'upstream-error') return first;

    current.payload.value = 'fixed';
    return await run();
  };

  const result = await runInterceptors(ctx, request, [interceptor], () => {
    attempts += 1;
    return Promise.resolve(
      attempts === 1
        ? {
            type: 'upstream-error' as const,
            status: 400,
            headers: new Headers(),
            body: new TextEncoder().encode('{"error":{"message":"broken"}}'),
          }
        : makeResult(ctx.payload.value),
    );
  });

  assertEquals(attempts, 2);
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('expected events result');
  assertEquals(await collectFrames(result.events), [eventFrame('fixed')]);
});

const makeResult = (value: string): TestResult =>
  eventResult(
    (async function* () {
      yield eventFrame(value);
    })(),
    testTelemetryModelIdentity,
  );
