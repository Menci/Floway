import { describe, expect, test, vi } from 'vitest';

import { providerStreamResultToExecuteResult } from '../../../../src/data-plane/chat/shared/provider-stream-result.ts';
import { RETAINED_RESPONSE_LIMITS } from '../../../../src/data-plane/shared/retained-response.ts';
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

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

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

test('consumer return drains terminal usage before metadata settles', async () => {
  const terminalUsage = { input: 7, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 3 };
  let releaseTerminal!: (frame: ProtocolFrame<{ type: string; usage?: typeof terminalUsage }>) => void;
  const terminal = new Promise<ProtocolFrame<{ type: string; usage?: typeof terminalUsage }>>(resolve => { releaseTerminal = resolve; });
  const events: AsyncIterable<ProtocolFrame<{ type: string; usage?: typeof terminalUsage }>> = (async function* () {
    yield { type: 'event', event: { type: 'response.created' } } as const;
    yield await terminal;
  })();
  const ctx = mockGatewayCtx();
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events),
    stubModelCandidate(),
    'responses',
    ctx,
    event => event.usage ?? null,
  );
  expect(result.type).toBe('events');
  if (result.type !== 'events') return;

  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  const returned = iterator.return?.();
  if (returned === undefined) throw new Error('expected the event iterator to implement return()');
  let metadataSettled = false;
  let returnSettled = false;
  void result.finalMetadata!.then(() => { metadataSettled = true; });
  void returned.then(() => { returnSettled = true; });
  await Promise.resolve();
  expect(metadataSettled).toBe(false);
  expect(returnSettled).toBe(false);

  releaseTerminal({ type: 'event', event: { type: 'response.completed', usage: terminalUsage } });
  await returned;
  expect((await result.finalMetadata!).billableUsage).toEqual(terminalUsage);
});

test('return before the first read still drains the provider and settles metadata', async () => {
  let reads = 0;
  const events: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          reads += 1;
          return reads === 1
            ? { done: false, value: { type: 'event', event: { type: 'response.created' } } }
            : { done: true, value: undefined };
        },
      };
    },
  };
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'responses', mockGatewayCtx(), () => null);
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.return?.();

  expect(reads).toBe(2);
  await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
});

test('iterator factory failure propagates and still settles metadata', async () => {
  const failure = new Error('iterator factory failed');
  const events: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      throw failure;
    },
  };
  const result = await providerStreamResultToExecuteResult(okStreamResult(events), stubModelCandidate(), 'responses', mockGatewayCtx(), () => null);
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

  await expect(result.events[Symbol.asyncIterator]().next()).rejects.toBe(failure);
  await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
});

test('usage observation failure preserves its cause while the retained source drains', async () => {
  const badUsage = new Error('invalid trailing usage');
  const terminalUsage = { input: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 2 };
  let sourceFinished = false;
  const events: AsyncIterable<ProtocolFrame<{ type: string; usage?: typeof terminalUsage }>> = (async function* () {
    try {
      yield { type: 'event', event: { type: 'response.created' } } as const;
      yield { type: 'event', event: { type: 'bad-usage' } } as const;
      yield { type: 'event', event: { type: 'response.completed', usage: terminalUsage } } as const;
    } finally {
      sourceFinished = true;
    }
  })();
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events),
    stubModelCandidate(),
    'responses',
    mockGatewayCtx(),
    event => {
      if (event.type === 'bad-usage') throw badUsage;
      return event.usage ?? null;
    },
  );
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();

  await expect(iterator.return?.()).rejects.toBe(badUsage);
  expect(sourceFinished).toBe(true);
  await expect(result.finalMetadata).resolves.toMatchObject({ billableUsage: terminalUsage });
});

test('a rejecting source next cannot wait forever for source cleanup', async () => {
  vi.useFakeTimers();
  try {
    const sourceFailure = new Error('provider next failed');
    const returnStarted = deferred<void>();
    const neverReturns = new Promise<IteratorResult<ProtocolFrame<unknown>>>(() => {});
    const events: AsyncIterable<ProtocolFrame<unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw sourceFailure; },
          return: () => {
            returnStarted.resolve();
            return neverReturns;
          },
        };
      },
    };
    const executionController = new AbortController();
    const ctx = mockGatewayCtx({ executionController, executionSignal: executionController.signal });
    const result = await providerStreamResultToExecuteResult(
      okStreamResult(events),
      stubModelCandidate(),
      'responses',
      ctx,
      () => null,
    );
    if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

    const pending = result.events[Symbol.asyncIterator]().next();
    await returnStarted.promise;
    await vi.advanceTimersByTimeAsync(RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs);
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.cause).toBe(sourceFailure);
    expect(aggregate.errors[0]).toBe(sourceFailure);
    expect(aggregate.errors[1]).toMatchObject({
      name: 'ProviderStreamCleanupTimeoutError',
      message: `Provider event stream cleanup exceeded its ${RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs}ms deadline`,
    });
    expect(ctx.executionSignal.aborted).toBe(true);
    expect(ctx.executionSignal.reason).toBe(aggregate.errors[1]);
    await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
  } finally {
    vi.useRealTimers();
  }
});

test('a cleanup rejection after the deadline is reported without becoming unhandled', async () => {
  vi.useFakeTimers();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const sourceFailure = new Error('provider next failed');
    const lateCleanupFailure = new Error('provider return failed after timeout');
    const returnStarted = deferred<void>();
    const cleanup = deferred<IteratorResult<ProtocolFrame<unknown>>>();
    const events: AsyncIterable<ProtocolFrame<unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => { throw sourceFailure; },
          return: () => {
            returnStarted.resolve();
            return cleanup.promise;
          },
        };
      },
    };
    const executionController = new AbortController();
    const ctx = mockGatewayCtx({ executionController, executionSignal: executionController.signal });
    const result = await providerStreamResultToExecuteResult(
      okStreamResult(events),
      stubModelCandidate(),
      'responses',
      ctx,
      () => null,
    );
    if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

    const pending = result.events[Symbol.asyncIterator]().next();
    await returnStarted.promise;
    await vi.advanceTimersByTimeAsync(RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);

    cleanup.reject(lateCleanupFailure);
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(consoleError).toHaveBeenCalledWith(
      '[provider-stream] cleanup failed after lifecycle settlement',
      lateCleanupFailure,
    );
    await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
  } finally {
    consoleError.mockRestore();
    vi.useRealTimers();
  }
});

test('source cleanup failure remains attached to the primary read failure', async () => {
  const sourceFailure = new Error('provider next failed');
  const cleanupFailure = new Error('provider return failed');
  const events: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => { throw sourceFailure; },
        return: async () => { throw cleanupFailure; },
      };
    },
  };
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events),
    stubModelCandidate(),
    'responses',
    mockGatewayCtx(),
    () => null,
  );
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

  const error = await result.events[Symbol.asyncIterator]().next().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AggregateError);
  const aggregate = error as AggregateError;
  expect(aggregate.cause).toBe(sourceFailure);
  expect(aggregate.errors).toEqual([sourceFailure, cleanupFailure]);
  await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
});

test('return preempts a pending source read and bounds its uncooperative cleanup', async () => {
  vi.useFakeTimers();
  try {
    const nextStarted = deferred<void>();
    const returnStarted = deferred<void>();
    const neverReads = new Promise<IteratorResult<ProtocolFrame<unknown>>>(() => {});
    const neverReturns = new Promise<IteratorResult<ProtocolFrame<unknown>>>(() => {});
    const events: AsyncIterable<ProtocolFrame<unknown>> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            nextStarted.resolve();
            return neverReads;
          },
          return: () => {
            returnStarted.resolve();
            return neverReturns;
          },
        };
      },
    };
    const executionController = new AbortController();
    const ctx = mockGatewayCtx({ executionController, executionSignal: executionController.signal });
    const result = await providerStreamResultToExecuteResult(
      okStreamResult(events),
      stubModelCandidate(),
      'responses',
      ctx,
      () => null,
    );
    if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);
    const iterator = result.events[Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    await nextStarted.promise;
    const returned = iterator.return?.();
    if (returned === undefined) throw new Error('expected the event iterator to implement return()');
    await expect(pendingNext).resolves.toEqual({ done: true, value: undefined });
    await returnStarted.promise;

    await vi.advanceTimersByTimeAsync(RETAINED_RESPONSE_LIMITS.postDisconnectDrainTimeoutMs);
    await expect(returned).rejects.toMatchObject({ name: 'ProviderStreamCleanupTimeoutError' });
    await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
  } finally {
    vi.useRealTimers();
  }
});

test('cleanup yields to a pre-scheduled execution deadline while draining ready frames', async () => {
  const executionController = new AbortController();
  const executionFailure = new Error('execution deadline reached');
  let reads = 0;
  let returnCalled = false;
  const events: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          reads += 1;
          if (reads > 300) return { done: true, value: undefined };
          return { done: false, value: { type: 'event', event: { type: 'response.in_progress' } } };
        },
        return: async () => {
          returnCalled = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const ctx = mockGatewayCtx({ executionController, executionSignal: executionController.signal });
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events),
    stubModelCandidate(),
    'responses',
    ctx,
    () => null,
  );
  if (result.type !== 'events') throw new Error(`expected events result, got ${result.type}`);

  setTimeout(() => executionController.abort(executionFailure), 0);
  const pending = result.events[Symbol.asyncIterator]().return?.();
  if (pending === undefined) throw new Error('expected the event iterator to implement return()');

  await expect(pending).rejects.toBe(executionFailure);
  expect(reads).toBeLessThan(300);
  expect(returnCalled).toBe(true);
  await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
});

test('normal consumption yields to a pre-scheduled execution deadline across ready frames', async () => {
  const executionController = new AbortController();
  const executionFailure = new Error('execution deadline reached');
  let reads = 0;
  let returnCalled = false;
  const events: AsyncIterable<ProtocolFrame<unknown>> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          reads += 1;
          if (reads > 300) return { done: true, value: undefined };
          return { done: false, value: { type: 'event', event: { type: 'response.in_progress' } } };
        },
        return: async () => {
          returnCalled = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const ctx = mockGatewayCtx({ executionController, executionSignal: executionController.signal });
  const result = await providerStreamResultToExecuteResult(
    okStreamResult(events),
    stubModelCandidate(),
    'responses',
    ctx,
    () => null,
  );

  setTimeout(() => executionController.abort(executionFailure), 0);
  await expect(drainEvents(result)).rejects.toBe(executionFailure);
  expect(reads).toBeLessThan(300);
  expect(returnCalled).toBe(true);
  await expect(result.finalMetadata).resolves.toMatchObject({ modelIdentity: expect.any(Object) });
});
