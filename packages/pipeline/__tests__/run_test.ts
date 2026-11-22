import { describe, expect, it } from 'vitest';

import { pipeline } from '../src/compose.ts';
import { createDumpDecoder } from '../src/dump-decoder.ts';
import { createDumpEncoder } from '../src/dump-encoder.ts';
import { StageScopeClosedError, StreamLeakError } from '../src/errors.ts';
import { runPipeline } from '../src/run.ts';
import { dispatch, handoff, terminal, defineStage } from '../src/stage.ts';
import type { ManagedStream, RawRunEvent } from '../src/types.ts';

const error = (message: string): Error => new Error(message);

describe('runPipeline', () => {
  it('runs stages as continuations and feeds each next call back through the remaining stages', async () => {
    const seen: string[] = [];
    const first = defineStage<{ input: string }, { value: string }, string, string, never, Record<never, never>>({
      name: 'first',
      provides: ['value'],
      execute: async (facts, next) => {
        seen.push(`first:${facts.input}`);
        return await next({ value: 'one' });
      },
    });
    const second = defineStage<{ input: string; value: string }, Record<never, never>, string, string, never, Record<never, never>>({
      name: 'second',
      execute: async (facts, next) => {
        seen.push(`second:${facts.value}`);
        return await next();
      },
    });
    const result = pipeline<{ input: string }>('continuation')
      .use(first)
      .use(second)
      .end(terminal<{ input: string; value: string }, string, Record<never, never>>('end', async facts => facts.value));
    await expect(runPipeline(result, { input: 'x' })).resolves.toBe('one');
    expect(seen).toEqual(['first:x', 'second:one']);
  });

  it('isolates retry branches from the stage entry facts and discards losing streams', async () => {
    const discarded: number[] = [];
    let attempts = 0;
    const retry = defineStage<
      { input: string },
      { attempt: number },
      number,
      number,
      never,
      Record<never, never>
    >({
      name: 'retry',
      provides: ['attempt'],
      execute: async (facts, next, env) => {
        attempts++;
        const loser = env.createStream({ async *iterate() { yield 0; } });
        await env.discard(loser);
        discarded.push((facts as { attempt?: number }).attempt ?? -1);
        return await next({ attempt: attempts });
      },
    });
    const target = defineStage<{ input: string; attempt: number }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'target',
      execute: async (_facts, next) => await next(),
    });
    const result = pipeline<{ input: string }>('retry')
      .use(retry)
      .use(target)
      .end(terminal<{ input: string; attempt: number }, number, Record<never, never>>('end', async facts => facts.attempt));
    await expect(runPipeline(result, { input: 'x' })).resolves.toBe(1);
    expect(discarded).toEqual([-1]);
  });

  it('builds every failover branch from the same immutable entry facts', async () => {
    const seen: { attempt?: number }[] = [];
    const failures = defineStage<
      { input: string; attempt?: number },
      { attempt: number },
      number,
      number,
      never,
      Record<never, never>
    >({
      name: 'failover',
      provides: ['attempt'],
      execute: async (facts, next) => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          seen.push({ attempt: facts.attempt });
          try {
            return await next({ attempt });
          } catch (caught) {
            if (attempt === 3) throw caught;
          }
        }
        throw new Error('unreachable');
      },
    });
    let downstreamCalls = 0;
    const flaky = defineStage<{ input: string; attempt: number }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'flaky',
      execute: async (facts, next) => {
        downstreamCalls++;
        if (facts.attempt < 3) throw new Error(`attempt ${facts.attempt}`);
        return await next();
      },
    });
    const result = pipeline<{ input: string }>('failover')
      .use(failures)
      .use(flaky)
      .end(terminal<{ input: string; attempt: number }, number, Record<never, never>>('end', async facts => facts.attempt));
    await expect(runPipeline(result, { input: 'x' })).resolves.toBe(3);
    expect(seen).toEqual([{ attempt: undefined }, { attempt: undefined }, { attempt: undefined }]);
    expect(downstreamCalls).toBe(3);
  });

  it('rejects a stream hidden in a stage result that the continuation never consumes', async () => {
    const leak = defineStage<{ input: string }, Record<never, never>, string, string, never, Record<never, never>>({
      name: 'leak',
      execute: async (_facts, _next, env) => {
        env.createStream({ async *iterate() { yield 1; } });
        return 'done';
      },
    });
    const result = pipeline<{ input: string }>('leak')
      .use(leak)
      .end(terminal<{ input: string }, string, Record<never, never>>('end', async () => 'never'));
    await expect(runPipeline(result, { input: 'x' })).rejects.toBeInstanceOf(StreamLeakError);
  });

  it('combines a stage failure with a leaked stream cleanup failure', async () => {
    const failure = error('stage failure');
    const leak = defineStage<{ input: string }, Record<never, never>, string, string, never, Record<never, never>>({
      name: 'leak-and-throw',
      execute: async (_facts, _next, env) => {
        env.createStream({ async *iterate() { yield 1; } });
        throw failure;
      },
    });
    const result = pipeline<{ input: string }>('leak-and-throw')
      .use(leak)
      .end(terminal<{ input: string }, never, Record<never, never>>('end', async () => { throw new Error('unreachable'); }));
    const caught = await runPipeline(result, { input: 'x' }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toContain(failure);
    expect((caught as AggregateError).errors.some(value => value instanceof StreamLeakError)).toBe(true);
  });

  it('finalizes intended exported streams when stage exit will throw', async () => {
    let exportedCloseMode: string | undefined;
    const broken = defineStage<
      { input: string },
      Record<never, never>,
      number,
      { revoked: ManagedStream<number>; events: ManagedStream<number> },
      never,
      Record<never, never>
    >({
      name: 'broken-export',
      execute: async (_facts, _next, env) => {
        const revoked = env.createStream({ async *iterate() { yield 0; } });
        env.wrapStream(revoked, { transform: source => source });
        const events = env.createStream({
          async *iterate() { yield 1; },
          onClose: info => { exportedCloseMode = info.how; },
        });
        return { revoked, events };
      },
    });
    const result = pipeline<{ input: string }>('broken-export')
      .use(broken)
      .end(terminal<{ input: string }, number, Record<never, never>>(
        'unreachable',
        async () => 0,
      ));
    const caught = await runPipeline(result, { input: 'x' }).catch(value => value);
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toContainEqual(expect.objectContaining({
      name: 'StreamOwnershipError',
      streamId: expect.any(Number),
    }));
    expect(exportedCloseMode).toBe('closed');
  });

  it('settles an un-awaited continuation and reports its returned stream as a leak on the caller stage', async () => {
    const leak = defineStage<{ input: string }, { value: string }, { body: ManagedStream<number> }, string, never, Record<never, never>>({
      name: 'stray-next',
      provides: ['value'],
      execute: async (_facts, next) => {
        void next({ value: 'stray' });
        return 'orphaned';
      },
    });
    const producer = defineStage<{ input: string; value: string }, Record<never, never>, string, { body: ManagedStream<number> }, never, Record<never, never>>({
      name: 'produce',
      execute: async (_facts, next, env) => {
        await next();
        return { body: env.createStream({ async *iterate() { yield 1; } }) };
      },
    });
    const result = pipeline<{ input: string }>('stray')
      .use(leak)
      .use(producer)
      .end(terminal<{ input: string; value: string }, string, Record<never, never>>('end', async () => 'done'));
    await expect(runPipeline(result, { input: 'x' })).rejects.toMatchObject({
      name: 'StreamLeakError',
      stageName: 'stray-next',
    });
  });

  it('supports lazy continuation streams that bind next after the stage returned', async () => {
    const orchestrator = defineStage<{ input: string }, { turn: number }, number, ManagedStream<number>, never, Record<never, never>>({
      name: 'orchestrator',
      provides: ['turn'],
      execute: async (_facts, next, env) => env.createStream({
        async *iterate(_signal, streamEnv) {
          const nextTurn = streamEnv.bind(next);
          await nextTurn({ turn: 2 });
          yield 2;
        },
      }),
    });
    const after = defineStage<{ input: string; turn: number }, { received: number }, number, number, never, Record<never, never>>({
      name: 'after',
      provides: ['received'],
      execute: async (facts, next) => {
        expect(facts.turn).toBe(2);
        return await next({ received: 2 });
      },
    });
    const result = pipeline<{ input: string }>('lazy')
      .use(orchestrator)
      .use(after)
      .end(terminal<{ input: string; turn: number; received: number }, number, Record<never, never>>('end', async facts => facts.received));
    const stream = await runPipeline(result, { input: 'x' }) as ManagedStream<number>;
    const values: number[] = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([2]);
  });

  it('lets a lazy continuation create and discard a stream after stage execution returned', async () => {
    let discarded = false;
    const orchestrator = defineStage<{ input: string }, { turn: number }, number, ManagedStream<number>, never, Record<never, never>>({
      name: 'lazy-create',
      provides: ['turn'],
      execute: async (_facts, next, stageEnv) => stageEnv.createStream({
        async *iterate(_signal, streamEnv) {
          const nextTurn = streamEnv.bind(next);
          await nextTurn({ turn: 1 });
          const temporary = streamEnv.createStream({
            async *iterate() {
              yield 0;
            },
            onClose: () => {
              discarded = true;
            },
          });
          await streamEnv.discard(temporary);
          yield 1;
        },
      }),
    });
    const after = defineStage<{ input: string; turn: number }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'after-lazy-create',
      execute: async (_facts, next) => await next(),
    });
    const result = pipeline<{ input: string }>('lazy-create')
      .use(orchestrator)
      .use(after)
      .end(terminal<{ input: string; turn: number }, number, Record<never, never>>('end', async () => 1));
    const stream = await runPipeline(result, { input: 'x' }) as unknown as ManagedStream<number>;
    const values: number[] = [];
    for await (const value of stream) values.push(value);
    expect(values).toEqual([1]);
    expect(discarded).toBe(true);
  });

  it('reports a leaked stream acquired inside a lazy continuation when the exported stream finalizes', async () => {
    const orchestrator = defineStage<{ input: string }, { turn: number }, { events: ManagedStream<number> }, ManagedStream<number>, never, Record<never, never>>({
      name: 'lazy-leak',
      provides: ['turn'],
      execute: async (_facts, next, env) => env.createStream({
        async *iterate(_signal, streamEnv) {
          // Acquire Turn 2 stream via next() after execute() returned, then forget to consume/close it!
          await streamEnv.bind(next)({ turn: 2 });
          yield 2;
        },
      }),
    });
    const turnTwo = defineStage<{ input: string; turn: number }, Record<never, never>, number, { events: ManagedStream<number> }, never, Record<never, never>>({
      name: 'turn-two',
      execute: async (_facts, next, env) => {
        await next();
        return { events: env.createStream({ async *iterate() { yield 99; } }) };
      },
    });
    const result = pipeline<{ input: string }>('lazy-leak')
      .use(orchestrator)
      .use(turnTwo)
      .end(terminal<{ input: string; turn: number }, number, Record<never, never>>('end', async () => 1));
    const stream = await runPipeline(result, { input: 'x' }) as ManagedStream<number>;
    const errorValue = await (async () => {
      let last: unknown;
      try {
        for await (const _value of stream) void _value;
      } catch (error) {
        last = error;
      }
      return last;
    })();
    expect(errorValue).toBeInstanceOf(StreamLeakError);
  });

  it('keeps concurrent lazy stream custody isolated until each stream finishes', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    let streamA!: ManagedStream<number>;
    let streamB!: ManagedStream<number>;
    const lazyPair = defineStage<
      { input: string },
      { turn: number },
      number,
      { a: ManagedStream<number>; b: ManagedStream<number> },
      never,
      Record<never, never>
    >({
      name: 'lazy-pair',
      provides: ['turn'],
      execute: async (_facts, next, env) => {
        streamA = env.createStream({
          async *iterate(_signal, streamEnv) {
            await gateA;
            const temporary = streamEnv.createStream({ async *iterate() { yield 0; } });
            await streamEnv.discard(temporary);
            await streamEnv.bind(next)({ turn: 1 });
            yield 1;
          },
        });
        streamB = env.createStream({
          async *iterate() {
            yield 2;
          },
        });
        return { a: streamA, b: streamB };
      },
    });
    const after = defineStage<{ input: string; turn: number }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'lazy-pair-after',
      execute: async (_facts, next) => await next(),
    });
    const result = pipeline<{ input: string }>('lazy-pair')
      .use(lazyPair)
      .use(after)
      .end(terminal<{ input: string; turn: number }, number, Record<never, never>>('end', async () => 0));
    const exported = await runPipeline(result, { input: 'x' }) as { a: ManagedStream<number>; b: ManagedStream<number> };
    expect(exported.a).toBe(streamA);
    expect(exported.b).toBe(streamB);
    const aIterator = streamA[Symbol.asyncIterator]();
    const pendingA = aIterator.next();
    for await (const value of streamB) expect(value).toBe(2);
    releaseA();
    await expect(pendingA).resolves.toEqual({ value: 1, done: false });
    await expect(aIterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('rejects the unbound stage next after execution returned while a lazy stream remains open', async () => {
    let unboundNext!: () => Promise<unknown>;
    let stream!: ManagedStream<number>;
    const stage = defineStage<{ input: string }, { turn: number }, number, ManagedStream<number>, never, Record<never, never>>({
      name: 'unbound-next',
      provides: ['turn'],
      execute: async (_facts, next, env) => {
        unboundNext = next as () => Promise<unknown>;
        stream = env.createStream({ async *iterate() { yield 1; } });
        return stream;
      },
    });
    const result = pipeline<{ input: string }>('unbound-next')
      .use(stage)
      .end(terminal<{ input: string; turn: number }, number, Record<never, never>>(
        'end',
        async () => 0,
      ));
    await runPipeline(result, { input: 'x' });
    await expect(unboundNext()).rejects.toBeInstanceOf(StageScopeClosedError);
    await stream.close();
  });

  it('traces dispatch and sub-runs with the correct parent and edge kinds', async () => {
    const events: RawRunEvent[] = [];
    const sub = pipeline<{ value: number }>('sub')
      .end(terminal<{ value: number }, number, Record<never, never>>('sub-end', async facts => facts.value));
    const spawner = defineStage<{ input: string }, Record<never, never>, number, number, never, Record<never, never>>({
      name: 'spawner',
      execute: async (_facts, next, env) => {
        const value = await env.spawnSubRun(sub, { value: 7 });
        return await next(value as never) as number;
      },
    });
    const target = pipeline<{ value: number }>('dispatch-target')
      .end(terminal<{ value: number }, number, Record<never, never>>('target-end', async facts => facts.value));
    const root = pipeline<{ input: string }>('root')
      .use(spawner)
      .end(dispatch<{ input: string }, number, Record<never, never>>('dispatch', () => handoff(target, { value: 9 })));
    await runPipeline(root, { input: 'x' }, {
      traceSink: { push: event => events.push(event) },
      clock: () => 1,
    });
    const enters = events.filter((event): event is Extract<RawRunEvent, { k: 'enter' }> => event.k === 'enter');
    const subrun = enters.find(event => event.edgeKind === 'subrun');
    const dispatchEnter = enters.find(event => event.edgeKind === 'dispatch');
    expect(subrun).toBeDefined();
    expect(dispatchEnter).toBeDefined();
    expect(subrun?.parentStageId).toBe(enters.find(event => event.name === 'spawner')?.stageId);
    expect(dispatchEnter?.parentStageId).toBe(enters.find(event => event.name === 'dispatch')?.stageId);
    expect(enters.every((event, index) => event.seq > (enters[index - 1]?.seq ?? 0))).toBe(true);
    expect(events.every((event, index) => event.tMs >= (events[index - 1]?.tMs ?? 0))).toBe(true);
  });

  it('keeps the merged subrun signal alive until its exported stream finalizes', async () => {
    const parent = new AbortController();
    let sourceAborted = false;
    const sub = pipeline<{ input: string }>('sub-stream')
      .end(terminal<{ input: string }, ManagedStream<number>, Record<never, never>>(
        'sub-stream-end',
        async (_facts, env) => env.createStream({
          async *iterate(signal) {
            signal.addEventListener('abort', () => { sourceAborted = true; }, { once: true });
            yield 1;
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        }),
      ));
    const spawner = defineStage<{ input: string }, Record<never, never>, ManagedStream<number>, ManagedStream<number>, never, Record<never, never>>({
      name: 'spawn-stream',
      execute: async (_facts, _next, env) => await env.spawnSubRun(sub, { input: 'sub' }) as ManagedStream<number>,
    });
    const root = pipeline<{ input: string }>('spawn-root')
      .use(spawner)
      .end(terminal<{ input: string }, ManagedStream<number>, Record<never, never>>('unreachable', async () => undefined as never));
    const stream = await runPipeline(root, { input: 'x' }, { signal: parent.signal }) as ManagedStream<number>;
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    const pending = iterator.next();
    parent.abort('stop');
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(sourceAborted).toBe(true);
  });

  it('does not mutate a frozen input or a reused base fact object', async () => {
    const input = { input: 'x' };
    const first = defineStage<typeof input, { left: number }, number, number, never, Record<never, never>>({
      name: 'left',
      execute: async (_facts, next) => await next({ left: 1 }),
    });
    const second = defineStage<typeof input & { left: number }, { right: number }, number, number, never, Record<never, never>>({
      name: 'right',
      execute: async (facts, next) => {
        expect(Object.isFrozen(facts)).toBe(true);
        return await next({ right: 2 });
      },
    });
    const result = pipeline<typeof input>('frozen')
      .use(first)
      .use(second)
      .end(terminal<typeof input & { left: number; right: number }, number, Record<never, never>>('end', async () => 3));
    await expect(runPipeline(result, input)).resolves.toBe(3);
    expect(input).toEqual({ input: 'x' });
  });

  it('holds the producer lease until a root-exported stream closes', async () => {
    const events: RawRunEvent[] = [];
    let released = false;
    const emitted: string[] = [];
    const result = pipeline<{ input: string }>('lease')
      .end(terminal<{ input: string }, ManagedStream<number>, Record<never, never>>(
        'end',
        async (_facts, env) => env.createStream({ async *iterate() { yield 1; } }),
      ));
    const stream = await runPipeline(result, { input: 'x' }, {
      traceSink: {
        push: event => {
          events.push(event);
          if (event.k === 'done') emitted.push('done');
        },
        acquireProducerLease: () => () => {
          released = true;
          emitted.push('released');
        },
      },
    }) as ManagedStream<number>;
    expect(events.some(event => event.k === 'done')).toBe(false);
    for await (const _value of stream) void _value;
    await stream.close().catch(() => undefined);
    await Promise.resolve();
    expect(events.at(-1)?.k).toBe('done');
    expect(released).toBe(true);
    expect(emitted).toEqual(['done', 'released']);
  });

  it('releases the lease after a root stream fails during iteration cleanup', async () => {
    const closeError = new Error('close failed');
    let released = false;
    const result = pipeline<{ input: string }>('lease-failure')
      .end(terminal<{ input: string }, ManagedStream<number>, Record<never, never>>(
        'end',
        async (_facts, env) => env.createStream({
          async *iterate() {
            yield 1;
          },
          onClose: async () => {
            throw closeError;
          },
        }),
      ));
    const stream = await runPipeline(result, { input: 'x' }, {
      traceSink: {
        push: () => undefined,
        acquireProducerLease: () => () => {
          released = true;
        },
      },
    }) as ManagedStream<number>;
    await expect((async () => {
      for await (const _value of stream) void _value;
    })()).rejects.toBe(closeError);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(released).toBe(true);
  });

  it('waits for every root stream and emits done with their terminal errors', async () => {
    const events: RawRunEvent[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => { releaseA = resolve; });
    let streamA!: ManagedStream<number>;
    let streamB!: ManagedStream<number>;
    const root = pipeline<{ input: string }>('root-errors')
      .end(terminal<{ input: string }, { a: ManagedStream<number>; b: ManagedStream<number> }, Record<never, never>>(
        'roots',
        async (_facts, env) => {
          streamA = env.createStream({ async *iterate() { await gateA; yield 1; } });
          streamB = env.createStream({
            async *iterate() { yield 2; },
            onClose: () => { throw new Error('root-b close failed'); },
          });
          return { a: streamA, b: streamB };
        },
      ));
    const result = await runPipeline(root, { input: 'x' }, {
      traceSink: { push: event => events.push(event) },
      clock: () => 1,
    }) as { a: ManagedStream<number>; b: ManagedStream<number> };
    const bIterator = result.b[Symbol.asyncIterator]();
    await bIterator.next();
    await expect(bIterator.return!()).rejects.toThrow('root-b close failed');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events.some(event => event.k === 'done')).toBe(false);
    releaseA();
    for await (const _value of result.a) void _value;
    await new Promise(resolve => setTimeout(resolve, 0));
    const doneEvent = events.findLast((event): event is Extract<RawRunEvent, { k: 'done' }> => event.k === 'done');
    expect(doneEvent).toMatchObject({ ok: false, error: expect.objectContaining({ message: 'root-b close failed' }) });
  });

  it('snapshots nested byte leaves in deferred enter, leave, log, and frame events', async () => {
    const events: RawRunEvent[] = [];
    const enterBytes = new Uint8Array([1]);
    const outcomeBytes = new Uint8Array([2]);
    const frameBytes = new Uint8Array([3]);
    const stage = defineStage<
      { payload: { data: Uint8Array }; other: { stable: number } },
      Record<never, never>,
      number,
      { body: { data: Uint8Array }; stable: { value: number } },
      never,
      Record<never, never>
    >({
      name: 'snapshot-stage',
      execute: async (facts, _next, env) => {
        const stable = { value: 9 };
        env.log.info('snapshot', { body: { data: outcomeBytes } });
        const stream = env.createStream({ async *iterate() { yield { data: frameBytes }; } });
        const frame = await stream[Symbol.asyncIterator]().next();
        if (frame.done) throw new Error('expected frame');
        await stream.close();
        facts.payload.data[0] = 7;
        (frame.value as { data: Uint8Array }).data[0] = 9;
        return { body: { data: new Uint8Array([8]) }, stable };
      },
    });
    const result = pipeline<{ payload: { data: Uint8Array }; other: { stable: number } }>('snapshots')
      .use(stage)
      .end(terminal<
        { payload: { data: Uint8Array }; other: { stable: number } },
        number,
        Record<never, never>
      >('end', async () => 0));
    const outcome = await runPipeline(result, { payload: { data: enterBytes }, other: { stable: 1 } }, {
      traceSink: { push: event => events.push(event) },
      clock: () => 1,
    });
    outcome.body.data[0] = 10;
    const enter = events.find((event): event is Extract<RawRunEvent, { k: 'enter' }> => event.k === 'enter' && event.name === 'snapshot-stage');
    const leave = events.find((event): event is Extract<RawRunEvent, { k: 'leave' }> => event.k === 'leave' && event.stageId === enter?.stageId);
    const log = events.find((event): event is Extract<RawRunEvent, { k: 'log' }> => event.k === 'log');
    const frame = events.find((event): event is Extract<RawRunEvent, { k: 'frame' }> => event.k === 'frame');
    expect((enter?.facts.payload as { data: Uint8Array }).data[0]).toBe(1);
    expect((leave?.outcome as { body: { data: Uint8Array } }).body.data[0]).toBe(8);
    expect((log?.fields?.body as { data: Uint8Array }).data[0]).toBe(2);
    expect((frame?.value as { data: Uint8Array }).data[0]).toBe(3);
    expect((leave?.outcome as { stable: object }).stable).toBe(outcome.stable);
  });

  it('snapshots mutable bytes separately for every trace event', async () => {
    const bytes = new Uint8Array([1]);
    const events: RawRunEvent[] = [];
    const stage = defineStage<
      { readonly input: string },
      Record<never, never>,
      number,
      number,
      never,
      Record<never, never>
    >({
      name: 'mutable-bytes',
      execute: async (_facts, _next, env) => {
        const stream = env.createStream({
          async *iterate() {
            yield bytes;
            bytes[0] = 2;
            yield { bytes };
          },
        });
        for await (const _value of stream) void _value;
        return 0;
      },
    });
    const result = pipeline<{ readonly input: string }>('fresh-snapshots')
      .use(stage)
      .end(terminal<{ readonly input: string }, number, Record<never, never>>('end', async () => 0));
    await runPipeline(result, { input: 'x' }, { traceSink: { push: event => events.push(event) } });

    const decoder = createDumpDecoder();
    const encoder = createDumpEncoder();
    const encoded = events.flatMap(event => encoder.encodeBatch([event]));
    const values = decoder.pushEvents(encoded).streams.get(1)?.frames.map(frame => frame.value);
    expect(values).toEqual([
      new Uint8Array([1]),
      { bytes: new Uint8Array([2]) },
    ]);
  });

  it('traces a throwing terminal preparation and skips its execute', async () => {
    const failure = error('prepare failed');
    const events: RawRunEvent[] = [];
    let executed = false;
    const result = pipeline<{ readonly input: string }>('prepare-failure').end(
      terminal<{ readonly input: string }, number, Record<never, never>>({
        name: 'prepared-terminal',
        prepare: () => { throw failure; },
        execute: async () => {
          executed = true;
          return 0;
        },
      }),
    );

    await expect(runPipeline(result, { input: 'x' }, {
      traceSink: { push: event => events.push(event) },
    })).rejects.toBe(failure);
    expect(executed).toBe(false);
    const enter = events.find((event): event is Extract<RawRunEvent, { readonly k: 'enter' }> =>
      event.k === 'enter' && event.name === 'prepared-terminal');
    const fail = events.find((event): event is Extract<RawRunEvent, { readonly k: 'fail' }> =>
      event.k === 'fail' && event.stageId === enter?.stageId);
    expect(enter?.facts).toEqual({ input: 'x' });
    expect(fail?.error).toBe(failure);
  });
});
