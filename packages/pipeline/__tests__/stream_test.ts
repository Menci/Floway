import { describe, expect, it, vi } from 'vitest';

import { pipeline } from '../src/compose.ts';
import {
  ConcurrentStreamReadError,
  DuplicateStreamCloseError,
  StreamOwnershipError,
} from '../src/errors.ts';
import { runPipeline } from '../src/run.ts';
import { terminal } from '../src/stage.ts';
import { RunStreamCoordinator, createStageScope } from '../src/stream.ts';
import type { ManagedStream, RawRunEvent, StreamEndHow } from '../src/types.ts';

const never = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

const scopeFor = (signal = new AbortController().signal) => createStageScope({
  stageId: 1,
  stageName: 'stream-test',
  signal,
}, new RunStreamCoordinator());

describe('ManagedStream lifecycle', () => {
  it('exhausts normally and records the close mode', async () => {
    const scope = scopeFor();
    let closed: StreamEndHow | undefined;
    const stream = scope.createStream({
      async *iterate() {
        yield 1;
        yield 2;
      },
      onClose: info => {
        closed = info.how;
      },
    });
    const values: number[] = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([1, 2]);
    expect(stream.state).toBe('closed');
    expect(closed).toBe('exhausted');
    await scope.finish([], []);
  });

  it('aborts immediately on early break and closes exactly once', async () => {
    const scope = scopeFor();
    let aborted = false;
    let closed: StreamEndHow | undefined;
    const stream = scope.createStream({
      async *iterate(signal) {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        yield 1;
        await never(signal);
      },
      onClose: info => {
        closed = info.how;
      },
    });
    for await (const value of stream) {
      expect(value).toBe(1);
      break;
    }
    expect(aborted).toBe(true);
    expect(closed).toBe('closed');
    await expect(stream.close()).rejects.toBeInstanceOf(DuplicateStreamCloseError);
    await scope.finish([], []);
  });

  it('links the parent abort signal to a pending source read', async () => {
    const parent = new AbortController();
    const scope = scopeFor(parent.signal);
    let sourceAborted = false;
    const stream = scope.createStream({
      async *iterate(signal) {
        signal.addEventListener('abort', () => { sourceAborted = true; }, { once: true });
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        yield 1;
      },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    parent.abort('stop');
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(sourceAborted).toBe(true);
    await scope.finish([], []);
  });

  it('supports one explicit close and joins later discard calls', async () => {
    const scope = scopeFor();
    let closeCount = 0;
    const stream = scope.createStream({
      async *iterate() {
        yield 1;
      },
      onClose: () => {
        closeCount++;
      },
    });
    await stream.close();
    await scope.discard(stream);
    await expect(stream.close()).rejects.toBeInstanceOf(DuplicateStreamCloseError);
    expect(closeCount).toBe(1);
    await scope.finish([], []);
  });

  it('does not start the source when a stream is closed before iteration', async () => {
    const scope = scopeFor();
    let started = false;
    const stream = scope.createStream({
      async *iterate() {
        started = true;
        yield 1;
      },
    });
    await stream.close();
    expect(started).toBe(false);
    expect(stream.state).toBe('closed');
    await scope.finish([], []);
  });

  it('wakes an outstanding read when closed explicitly', async () => {
    const scope = scopeFor();
    const stream = scope.createStream({
      async *iterate(signal) {
        yield 1;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        yield 2;
      },
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    const pending = iterator.next();
    await stream.close('stop');
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    await scope.finish([], []);
  });

  it('returns the source iterator before onClose exactly once when discarded', async () => {
    const scope = scopeFor();
    let settled = false;
    let returnCount = 0;
    let streamSignal!: AbortSignal;
    const order: string[] = [];
    const stream = scope.createStream({
      iterate: signal => {
        streamSignal = signal;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<number>>((_resolve, reject) => {
              if (streamSignal.aborted) reject(streamSignal.reason);
              else streamSignal.addEventListener('abort', () => reject(streamSignal.reason), { once: true });
            }),
            return: async () => {
              returnCount++;
              order.push('return');
              settled = true;
              return { value: undefined, done: true };
            },
          }),
        };
      },
      onClose: () => {
        expect(settled).toBe(true);
        order.push('onClose');
      },
    });
    const iterator = stream[Symbol.asyncIterator]();
    const read = iterator.next();
    await Promise.resolve();
    await stream.close('stop');
    await expect(read).resolves.toEqual({ value: undefined, done: true });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
    expect(order).toEqual(['return', 'onClose']);
    expect(returnCount).toBe(1);
    await scope.finish([], []);
  });

  it('collects a source return failure alongside onClose and does not expose openIterator', async () => {
    const scope = scopeFor();
    const returnError = new Error('return failed');
    const closeError = new Error('close failed');
    const stream = scope.createStream({
      iterate: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: 1, done: false }),
          return: async () => { throw returnError; },
        }),
      }),
      onClose: async () => { throw closeError; },
    });
    expect((stream as ManagedStream<number> & { openIterator?: unknown }).openIterator).toBeUndefined();
    const rejectOpenIterator = (candidate: ManagedStream<number>) => {
      // @ts-expect-error openIterator is an internal authorization path.
      candidate.openIterator(true);
    };
    void rejectOpenIterator;
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    const error = await iterator.return!().catch(caught => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([returnError, closeError]);
    await scope.finish([], []).catch(() => undefined);
  });

  it('revokes an inner handle after wrapping and rejects every public access', async () => {
    const scope = scopeFor();
    const inner = scope.createStream({
      async *iterate() {
        yield 1;
      },
    });
    const order: string[] = [];
    const outer = scope.wrapStream(inner, {
      onClose: () => {
        order.push('outer');
      },
      async *transform(source) {
        yield* source;
      },
    });
    await expect(inner.close()).rejects.toBeInstanceOf(StreamOwnershipError);
    await expect(scope.discard(inner)).rejects.toBeInstanceOf(StreamOwnershipError);
    await expect((async () => {
      for await (const _value of inner) void _value;
    })()).rejects.toBeInstanceOf(StreamOwnershipError);
    expect(inner.owned).toBe(false);

    const innerClose = scope.createStream({
      async *iterate() {
        yield 2;
      },
      onClose: () => {
        order.push('inner');
      },
    });
    const wrapped = scope.wrapStream(innerClose, {
      onClose: () => {
        order.push('wrapped');
      },
      transform: source => source,
    });
    await wrapped.close();
    expect(order).toEqual(['wrapped', 'inner']);
    await outer.close();
    await scope.finish([], []);
  });

  it('closes adopted streams when the wrapper closes before iteration', async () => {
    const scope = scopeFor();
    let adoptedClosed = false;
    const adopted = scope.createStream({
      async *iterate() {
        yield 1;
      },
      onClose: () => {
        adoptedClosed = true;
      },
    });
    const outer = scope.createStream({
      adopt: [adopted],
      async *iterate() {
        yield 2;
      },
    });
    await outer.close();
    expect(adoptedClosed).toBe(true);
    await scope.finish([], []);
  });

  it('rejects concurrent reads', async () => {
    const scope = scopeFor();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stream = scope.createStream({
      iterate: (): AsyncIterable<number> => ({
        [Symbol.asyncIterator]: () => {
          let first = true;
          return {
            next: async () => {
              if (first) {
                first = false;
                await gate;
                return { value: 1, done: false };
              }
              return { value: undefined, done: true };
            },
          };
        },
      }),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toBeInstanceOf(ConcurrentStreamReadError);
    release();
    await expect(first).resolves.toEqual({ value: 1, done: false });
    await iterator.return!();
    await scope.finish([], []);
  });

  it('closes with errored and combines source and cleanup failures', async () => {
    const scope = scopeFor();
    const sourceError = new Error('source');
    const closeError = new Error('close');
    const stream = scope.createStream({
      async *iterate() {
        throw sourceError;
        yield 1;
      },
      onClose: async info => {
        expect(info.how).toBe('errored');
        throw closeError;
      },
    });
    const error = await (async () => {
      try {
        for await (const _value of stream) void _value;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([sourceError, closeError]);
    await scope.finish([], []).catch(() => undefined);
  });

  it('discard works for open streams and joins finalization after break', async () => {
    const scope = scopeFor();
    const open = scope.createStream({ async *iterate() { yield 1; } });
    await scope.discard(open);
    expect(open.state).toBe('closed');

    const iterated = scope.createStream({ async *iterate() { yield 1; yield 2; } });
    for await (const value of iterated) {
      expect(value).toBe(1);
      break;
    }
    await scope.discard(iterated);
    await scope.finish([], []);
  });

  it('surfaces a return-time cleanup failure on break and preserves both errors when the loop body throws', async () => {
    const scope = scopeFor();
    const closeError = new Error('return close failure');
    const breakStream = scope.createStream({
      async *iterate() {
        yield 1;
        yield 2;
      },
      onClose: async () => {
        throw closeError;
      },
    });
    await expect((async () => {
      for await (const value of breakStream) {
        expect(value).toBe(1);
        break;
      }
    })()).rejects.toBe(closeError);

    const scope2 = scopeFor();
    const bodyError = new Error('loop body failure');
    const closeError2 = new Error('masked close failure');
    const throwStream = scope2.createStream({
      async *iterate() {
        yield 1;
        yield 2;
      },
      onClose: async () => {
        throw closeError2;
      },
    });
    let caughtBody: unknown;
    try {
      for await (const _value of throwStream) {
        throw bodyError;
      }
    } catch (error) {
      caughtBody = error;
    }
    expect(caughtBody).toBe(bodyError);
    const combined = await scope2.finish([], [caughtBody]).catch((error: unknown) => error);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([bodyError, closeError2]);
  });

  it('keeps a revoked handle typed as the original stream', () => {
    const scope = scopeFor();
    const inner: ManagedStream<number> = scope.createStream({ async *iterate() { yield 1; } });
    const outer = scope.wrapStream(inner, { transform: source => source });
    expect(outer.streamId).not.toBe(inner.streamId);
  });

  it('cancels wrapped abort-aware inner streams without deadlocking and runs outer cleanup before inner cleanup', async () => {
    const scope = scopeFor();
    const order: string[] = [];
    const inner = scope.createStream<number>({
      iterate: signal => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<number>>((_resolve, reject) => {
            if (signal.aborted) {
              reject(signal.reason ?? new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
          }),
          return: async () => {
            order.push('inner.return');
            return { value: undefined, done: true };
          },
        }),
      }),
      onClose: () => {
        order.push('inner.onClose');
      },
    });
    const outer = scope.wrapStream(inner, {
      async *transform(source) {
        try {
          for await (const item of source) {
            yield item;
          }
        } finally {
          order.push('outer.finally');
        }
      },
      onClose: () => {
        order.push('outer.onClose');
      },
    });

    const iter = outer[Symbol.asyncIterator]();
    const pendingNext = iter.next();
    await new Promise(resolve => setTimeout(resolve, 5));
    await outer.close('client-disconnected');
    await expect(pendingNext).resolves.toEqual({ value: undefined, done: true });
    expect(outer.state).toBe('closed');
    expect(inner.state).toBe('closed');
    expect(order).toEqual(['outer.finally', 'outer.onClose', 'inner.return', 'inner.onClose']);
    await scope.finish([], []);
  });

  it('finalizes the stream when iterator.next() throws synchronously', async () => {
    const scope = scopeFor();
    const syncErr = new Error('sync next failure');
    let closedHow: string | undefined;
    const stream = scope.createStream<number>({
      iterate: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            throw syncErr;
          },
        }),
      }),
      onClose: ({ how }) => {
        closedHow = how;
      },
    });

    const iter = stream[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBe(syncErr);
    expect(stream.state).toBe('closed');
    expect(closedHow).toBe('errored');
    await scope.finish([], []);
  });

  it('runs generator finally cleanup when a yielded frame fails boundary freeze validation', async () => {
    const scope = scopeFor();
    let finallyRan = 0;
    const stream = scope.createStream<unknown>({
      async *iterate() {
        try {
          yield new Map([['bad', 1]]);
        } finally {
          finallyRan++;
        }
      },
    });

    await expect((async () => {
      for await (const _item of stream) void _item;
    })()).rejects.toMatchObject({ name: 'InvalidFactValueError' });
    expect(stream.state).toBe('closed');
    expect(finallyRan).toBe(1);
    await scope.finish([], []);
  });

  it('tees both branches at different speeds and finalizes the inner stream after both complete', async () => {
    const events: RawRunEvent[] = [];
    const coordinator = new RunStreamCoordinator({
      trace: {
        push: event => events.push(event),
        nextSeq: () => events.length + 1,
        clock: () => 0,
      },
    });
    const scope = createStageScope({
      stageId: 1,
      stageName: 'tee',
      signal: new AbortController().signal,
    }, coordinator);
    let innerClosed: StreamEndHow | undefined;
    const inner = scope.createStream({
      async *iterate() {
        yield 1;
        await new Promise(resolve => setTimeout(resolve, 2));
        yield 2;
        yield 3;
      },
      onClose: ({ how }) => {
        innerClosed = how;
      },
    });
    const [left, right] = scope.teeStream(inner, { labels: ['left', 'right'] });
    const leftValues: number[] = [];
    const rightValues: number[] = [];
    const leftIterator = left[Symbol.asyncIterator]();
    const rightIterator = right[Symbol.asyncIterator]();
    expect(await leftIterator.next()).toEqual({ value: 1, done: false });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await rightIterator.next()).toEqual({ value: 1, done: false });
    for (;;) {
      const next = await rightIterator.next();
      if (next.done) break;
      rightValues.push(next.value);
    }
    for (;;) {
      const next = await leftIterator.next();
      if (next.done) break;
      leftValues.push(next.value);
    }
    expect(leftValues).toEqual([2, 3]);
    expect(rightValues).toEqual([2, 3]);
    expect(left.state).toBe('closed');
    expect(right.state).toBe('closed');
    expect(inner.state).toBe('closed');
    expect(innerClosed).toBe('exhausted');
    expect(left.label).toBe('left');
    expect(right.label).toBe('right');
    const leftEvent = events.find(event => event.k === 'stream' && event.streamId === left.streamId);
    const rightEvent = events.find(event => event.k === 'stream' && event.streamId === right.streamId);
    expect(leftEvent).toMatchObject({ wraps: inner.streamId, label: 'left' });
    expect(rightEvent).toMatchObject({ wraps: inner.streamId, label: 'right' });
    await scope.finish([], []);
  });

  it('keeps the inner stream alive after one branch is discarded while the other reads in background', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: RawRunEvent[] = [];
    let sourceAborted = false;
    let innerClosed: StreamEndHow | undefined;
    const received: number[] = [];
    let inner!: ManagedStream<number>;
    const pending: Promise<unknown>[] = [];
    const run = pipeline<{ readonly input: string }>('tee-discard').end(
      terminal<{ readonly input: string }, string, Record<never, never>>('tee-end', async (_facts, env) => {
        inner = env.createStream({
          async *iterate(signal) {
            signal.addEventListener('abort', () => { sourceAborted = true; }, { once: true });
            yield 1;
            await gate;
            yield 2;
          },
          onClose: ({ how }) => {
            innerClosed = how;
          },
        });
        const [left, right] = env.teeStream(inner);
        env.consumeInBackground(right, async source => {
          for await (const value of source) received.push(value);
        });
        await env.discard(left);
        expect(sourceAborted).toBe(false);
        return 'result';
      }),
    );
    await expect(runPipeline(run, { input: 'x' }, {
      waitUntil: promise => pending.push(promise),
      traceSink: { push: event => events.push(event) },
    })).resolves.toBe('result');
    expect(events.some(event => event.k === 'done')).toBe(false);
    expect(received).toEqual([1]);
    release();
    await Promise.all(pending);
    expect(received).toEqual([1, 2]);
    expect(sourceAborted).toBe(true);
    expect(inner.state).toBe('closed');
    expect(innerClosed).toBe('exhausted');
    const doneIndex = events.findIndex(event => event.k === 'done');
    const innerEndIndex = events.findIndex(event => event.k === 'end' && event.streamId === inner.streamId);
    expect(doneIndex).toBeGreaterThan(innerEndIndex);
    expect(events.at(-1)).toMatchObject({ k: 'done', ok: true });
  });

  it('reports a tee branch leaked when only the other branch is exported', async () => {
    const scope = scopeFor();
    const inner = scope.createStream({ async *iterate() { yield 1; } });
    const [left, right] = scope.teeStream(inner);
    await expect(scope.finish([right], [])).rejects.toMatchObject({
      name: 'StreamLeakError',
      leakedStreamIds: [left.streamId],
    });
    expect(left.state).toBe('closed');
    expect(right.state).toBe('closed');
    expect(inner.state).toBe('closed');
  });

  it('aborts and finalizes the inner stream when both branches close before pulling', async () => {
    const scope = scopeFor();
    let sourceAborted = false;
    let finalized = 0;
    const inner = scope.createStream({
      iterate: signal => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<number>>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              sourceAborted = true;
              reject(signal.reason ?? new Error('aborted'));
            }, { once: true });
          }),
        }),
      }),
      onClose: () => {
        finalized++;
      },
    });
    const [left, right] = scope.teeStream(inner);
    const leftRead = left[Symbol.asyncIterator]().next();
    const rightRead = right[Symbol.asyncIterator]().next();
    await Promise.resolve();
    await left.close();
    expect(sourceAborted).toBe(false);
    await right.close();
    await expect(leftRead).resolves.toEqual({ value: undefined, done: true });
    await expect(rightRead).resolves.toEqual({ value: undefined, done: true });
    expect(sourceAborted).toBe(true);
    expect(inner.state).toBe('closed');
    expect(finalized).toBe(1);
    await scope.finish([], []);
  });

  it('settles background consumers before emitting done while returning the pipeline result immediately', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const events: RawRunEvent[] = [];
    let releaseLease!: () => void;
    let leaseReleased = false;
    const run = pipeline<{ readonly input: string }>('background-settlement').end(
      terminal<{ readonly input: string }, string, Record<never, never>>('background-end', async (_facts, env) => {
        const stream = env.createStream({
          async *iterate() {
            yield 'first';
            await gate;
            yield 'last';
          },
        });
        env.consumeInBackground(stream, async source => {
          for await (const _value of source) {
            // Drain the observer before the run emits done.
          }
        });
        return 'result';
      }),
    );
    await expect(runPipeline(run, { input: 'x' }, {
      traceSink: {
        push: event => events.push(event),
        acquireProducerLease: () => {
          leaseReleased = false;
          releaseLease = () => { leaseReleased = true; };
          return releaseLease;
        },
      },
    })).resolves.toBe('result');
    expect(events.some(event => event.k === 'done')).toBe(false);
    expect(leaseReleased).toBe(false);
    release();
    await vi.waitFor(() => expect(events.some(event => event.k === 'done')).toBe(true));
    expect(events.at(-1)).toMatchObject({ k: 'done', ok: true });
    expect(leaseReleased).toBe(true);
  });

  it('provides a lazy streamEnv to wrapStream transforms and aborts lazy sub-runs on stream close', async () => {
    let subRunAborted = false;
    let startedSubRun!: () => void;
    const subRunStarted = new Promise<void>(resolve => { startedSubRun = resolve; });
    const slowSubPipeline = pipeline<{ readonly query: string }>('slow-sub').end(
      terminal<{ readonly query: string }, string, { readonly prefix: string }>('slow-sub-end', async (facts, env) => {
        startedSubRun();
        return await new Promise<string>((resolve, reject) => {
          if (env.signal.aborted) {
            subRunAborted = true;
            reject(env.signal.reason ?? new Error('aborted'));
            return;
          }
          env.signal.addEventListener('abort', () => {
            subRunAborted = true;
            reject(env.signal.reason ?? new Error('aborted'));
          }, { once: true });
          void resolve;
          void facts;
        });
      }),
    );

    const host = pipeline<Record<never, never>>('wrap-lazy-host').end(
      terminal<Record<never, never>, ManagedStream<string>, { readonly prefix: string }>('wrap-lazy-end', async (_facts, env) => {
        const inner = env.createStream<string>({
          label: 'inner',
          async *iterate() {
            yield 'seed';
          },
        });
        return env.wrapStream(inner, {
          label: 'outer',
          async *transform(source, _signal, streamEnv) {
            for await (const item of source) {
              yield `${streamEnv.prefix}:${item}`;
              yield await streamEnv.spawnSubRun(slowSubPipeline, { query: item });
            }
          },
        });
      }),
    );

    const out = await runPipeline(host, {}, { services: { prefix: 'svc' } });
    const iterator = out[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 'svc:seed', done: false });
    const pendingSecond = iterator.next();
    await subRunStarted;
    await out.close('downstream-cancelled');
    await expect(pendingSecond).resolves.toEqual({ value: undefined, done: true });
    expect(subRunAborted).toBe(true);
  });
});
