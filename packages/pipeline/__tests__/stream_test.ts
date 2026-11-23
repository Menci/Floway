import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  compose,
  ConcurrentStreamReadError,
  defineEnding,
  defineStage,
  DuplicateStreamCloseError,
  InvalidFactValueError,
  link,
  run,
  StageScopeClosedError,
  streamIdOf,
  StreamLeakError,
  StreamOwnershipError,
} from '../src/index.ts';
import type { Deferred, EndingScope, ManagedStream, Next, ReleasingInner, RootEnv, RunEvent, Scope, StageScope, StaticTarget, StreamEnd } from '../src/index.ts';

type Body = { body: ManagedStream<number> };
type Turn = { turn: number };
const options = { services: {}, finalizationTimeoutMs: 200 };
const empty = { needs: [], consumes: [], provides: [] };

const bodyPipeline = (execute: (scope: Scope) => Body | Promise<Body>) => compose<Body>()('pipeline', {
  entry: [], exit: ['body'],
  stages: [],
  ending: defineEnding<{}, Body>({
    name: 'stream stage', request: { needs: [] }, return: { provides: ['body'] },
    execute: async (_facts, scope) => await execute(scope),
  }),
});

const echoTurn = defineEnding<Turn, Body>({
  name: 'echo', request: { needs: ['turn'] }, return: { provides: ['body'] },
  execute: async ({ turn }, scope) => ({
    body: scope.createStream({ label: `turn ${turn}`, async *iterate() { yield turn; } }),
  }),
});

describe('stream release and cancellation', () => {
  it('lets onClose drain the inner after the wrapper iterator settles', async () => {
    const order: string[] = [];
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'inner',
        async *iterate(scope) {
          const { signal } = scope;
          yield 1;
          expect(signal.aborted).toBe(false);
          yield 2;
          yield 3;
        },
        onClose: end => { order.push(`inner ${end.how}`); },
      });
      const body = scope.wrapStream(inner, {
        label: 'wrapper',
        async *transform(source, scope) {
          const { signal } = scope;
          try {
            yield* source;
          } finally {
            expect(signal.aborted).toBe(true);
            order.push('wrapper iterator settled');
          }
        },
        onClose: async (end, inner) => {
          order.push(`wrapper ${end.how}`);
          if (!inner) throw new Error('Expected to retain the inner stream');
          for await (const frame of inner) order.push(`frame ${frame}`);
        },
      });
      expect(() => inner[Symbol.asyncIterator]()).toThrow(StreamOwnershipError);
      return { body };
    }), {}, options);
    const { body } = await handle.result;
    for await (const frame of body) {
      expect(frame).toBe(1);
      break;
    }
    expect(order).toEqual(['wrapper iterator settled', 'wrapper released', 'frame 2', 'frame 3', 'inner exhausted']);
    await expect(body.close()).rejects.toBeInstanceOf(DuplicateStreamCloseError);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('stops a blocked wrapper pull and hands the same pending frame to the release hook', async () => {
    const pulling = Promise.withResolvers<void>();
    const frame = Promise.withResolvers<number>();
    const events: string[] = [];
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'inner', async *iterate(scope) {
          const { signal } = scope;
          pulling.resolve();
          yield await frame.promise;
          expect(signal.aborted).toBe(false);
          yield 8;
        },
      });
      return {
        body: scope.wrapStream(inner, {
          label: 'wrapper',
          async *transform(source) {
            try { yield* source; } finally { events.push('settled'); }
          },
          onClose: async (_end, inner) => {
            if (!inner) throw new Error('Missing inner');
            events.push('close');
            frame.resolve(7);
            expect((await Array.fromAsync(inner)).join('')).toBe('78');
          },
        }),
      };
    }), {}, options);
    const { body } = await handle.result;
    const read = body[Symbol.asyncIterator]().next();
    await pulling.promise;
    await body.close();
    await expect(read).resolves.toMatchObject({ done: true });
    expect(events).toEqual(['settled', 'close']);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('lets the release hook close the inner while its retained read is blocked', async () => {
    const pulling = Promise.withResolvers<AbortSignal>();
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'blocked inner', async *iterate(scope) {
          const { signal } = scope;
          pulling.resolve(signal);
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          yield 1;
        },
      });
      return {
        body: scope.wrapStream(inner, {
          label: 'outer', transform: source => source,
          onClose: async (_end, inner) => {
            if (!inner) throw new Error('Expected the inner cursor');
            const read = inner.next();
            await inner.close();
            await expect(read).resolves.toMatchObject({ done: true });
          },
        }),
      };
    }), {}, options);
    const { body } = await handle.result;
    const pending = body[Symbol.asyncIterator]().next();
    const signal = await pulling.promise;
    expect(signal.aborted).toBe(false);
    await body.close();
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it.each(['classifies', 'discards'] as const)('%s a rejected retained read after the inner has ended', async disposition => {
    const pulling = Promise.withResolvers<void>();
    const upstream = Promise.withResolvers<number>();
    const unwinding = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const innerEnded = Promise.withResolvers<Extract<RunEvent, { k: 'end' }>>();
    const readError = new Error('raw read failed');
    let innerId: number | undefined;
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'inner', async *iterate() {
          pulling.resolve();
          yield await upstream.promise;
        },
      });
      innerId = streamIdOf(inner);
      return {
        body: scope.wrapStream(inner, {
          label: 'outer', async *transform(source) {
            try {
              yield* source;
            } finally {
              unwinding.resolve();
              await resume.promise;
            }
          },
          ...(disposition === 'classifies' ? {
            onClose: async (_end, inner) => {
              expect(inner).not.toBeNull();
              await expect(inner!.next()).rejects.toBe(readError);
            },
          } : {}),
        }),
      };
    }), {}, {
      ...options, events: event => {
        if (event.k === 'end' && event.streamId === innerId) innerEnded.resolve(event);
      },
    });
    const { body } = await handle.result;
    const read = body[Symbol.asyncIterator]().next();
    await pulling.promise;
    const release = body.close();
    await unwinding.promise;
    upstream.reject(readError);
    const end = await innerEnded.promise;
    resume.resolve();
    await expect(release).resolves.toBeUndefined();
    await expect(read).resolves.toMatchObject({ done: true });
    expect(end).toMatchObject({ how: 'errored', error: { message: 'raw read failed' } });
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it.each(['classifies', 'rethrows'] as const)('%s an error on the release hook’s first read', async disposition => {
    const readError = new Error('release read failed');
    const events: RunEvent[] = [];
    let innerId: number | undefined;
    let classification: string | undefined;
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream<number>({ label: 'inner', async *iterate() { throw readError; } });
      innerId = streamIdOf(inner);
      return {
        body: scope.wrapStream(inner, {
          label: 'outer', transform: source => source,
          onClose: async (_end, inner) => {
            try {
              await inner!.next();
            } catch (error) {
              if (disposition === 'rethrows') throw error;
              expect(error).toBe(readError);
              classification = 'unreadable';
            }
          },
        }),
      };
    }), {}, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    if (disposition === 'rethrows') {
      await expect(body.close()).rejects.toBe(readError);
      await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'Error', message: readError.message } });
    } else {
      await body.close();
      expect(classification).toBe('unreadable');
      await expect(handle.done).resolves.toEqual({ ok: true });
    }
    expect(events).toContainEqual(expect.objectContaining({
      k: 'end', streamId: innerId, how: 'errored', error: expect.objectContaining({ message: readError.message }),
    }));
  });

  it('releases the inner by default after the outer hook, aborting its own signal', async () => {
    const order: string[] = [];
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'inner', async *iterate(scope) {
          const { signal } = scope;
          signal.addEventListener('abort', () => order.push('inner abort'), { once: true });
          yield 1;
          throw new Error('An unobserved body was drained');
        },
        onClose: end => { order.push(`inner ${end.how}`); },
      });
      return {
        body: scope.wrapStream(inner, {
          label: 'outer', transform: source => source,
          onClose: end => { order.push(`outer ${end.how}`); },
        }),
      };
    }), {}, options);
    const { body } = await handle.result;
    const iterator = body[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await body.close();
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(order).toEqual(['outer released', 'inner abort', 'inner released']);
  });

  it('aborts both signals eagerly on cancellation and wakes a pending read', async () => {
    const controller = new AbortController();
    const reason = new Error('disconnect');
    const pulling = Promise.withResolvers<void>();
    const aborted: string[] = [];
    const ends: StreamEnd[] = [];
    const handle = run(bodyPipeline(scope => {
      const inner = scope.createStream({
        label: 'inner', async *iterate(scope) {
          const { signal } = scope;
          pulling.resolve();
          await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted.push('inner'); resolve(); }, { once: true }));
          yield 1;
        },
        onClose: end => { ends.push(end); },
      });
      return {
        body: scope.wrapStream(inner, {
          label: 'outer', transform: (source, scope) => {
            const { signal } = scope;
            signal.addEventListener('abort', () => aborted.push('outer'), { once: true });
            return source;
          },
          onClose: (end, inner) => { expect(inner).toBeNull(); ends.push(end); },
        }),
      };
    }), {}, { ...options, signal: controller.signal });
    const { body } = await handle.result;
    const pending = body[Symbol.asyncIterator]().next();
    await pulling.promise;
    controller.abort(reason);
    expect(aborted.toSorted()).toEqual(['inner', 'outer']);
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(ends).toEqual([{ how: 'cancelled', reason }, { how: 'cancelled', reason }]);
  });

  it('rejects concurrent reads, duplicate closes and a second iterator', async () => {
    const frame = Promise.withResolvers<number>();
    const handle = run(bodyPipeline(scope => ({
      body: scope.createStream({
        label: 'body', async *iterate() { yield await frame.promise; },
      }),
    })), {}, options);
    const { body } = await handle.result;
    const iterator = body[Symbol.asyncIterator]();
    const read = iterator.next();
    await expect(iterator.next()).rejects.toBeInstanceOf(ConcurrentStreamReadError);
    expect(() => body[Symbol.asyncIterator]()).toThrow(DuplicateStreamCloseError);
    frame.resolve(1);
    await expect(read).resolves.toEqual({ done: false, value: 1 });
    const closing = body.close();
    await expect(body.close()).rejects.toBeInstanceOf(DuplicateStreamCloseError);
    await closing;
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('records frozen frames by identity and rethrows the original read error', async () => {
    const frame = { nested: { value: 1 } };
    const error = new Error('read broke');
    const events: RunEvent[] = [];
    const ending = defineEnding<{}, { body: ManagedStream<typeof frame> }>({
      name: 'reader', request: { needs: [] }, return: { provides: ['body'] },
      execute: async (_facts, scope) => ({
        body: scope.createStream({
          label: 'body', async *iterate() {
            yield frame;
            throw error;
          },
        }),
      }),
    });
    const pipeline = compose<{ body: ManagedStream<typeof frame> }>()('reader', { entry: [], exit: ['body'], stages: [], ending });
    const handle = run(pipeline, {}, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    const reader = body[Symbol.asyncIterator]();
    const first = await reader.next();
    expect(first.value).toBe(frame);
    expect(Object.isFrozen(frame.nested)).toBe(true);
    const recorded = events.find(event => event.k === 'frame');
    expect(recorded?.value).toBe(frame);
    await expect(reader.next()).rejects.toBe(error);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { message: 'read broke' } });
  });

  it('rejects stream/deferred handles in frames and settlement values after ordinary fact validation', async () => {
    type Nested = { deferred: Deferred<number> };
    type Output = { nested: Nested; body: ManagedStream<{ nested: Nested }>; invalid: Deferred<unknown> };
    const ending = defineEnding<{}, Output>({
      name: 'handles', request: { needs: [] }, return: { provides: ['nested', 'body', 'invalid'] },
      execute: async (_facts, scope) => {
        const nested = { deferred: scope.defer('value', Promise.resolve(1)) };
        const body = scope.createStream({ label: 'body', async *iterate() { yield { nested }; } });
        const invalid = scope.defer('body handle', Promise.resolve({ body }));
        return { nested, body, invalid };
      },
    });
    const pipeline = compose<Output>()('handles', { entry: [], exit: ['nested', 'body', 'invalid'], stages: [], ending });
    const handle = run(pipeline, {}, options);
    const { body, invalid, nested } = await handle.result;
    expect(Object.isFrozen(nested)).toBe(true);
    await expect(body[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'InvalidFactValueError', path: 'stream(body).frame.nested.deferred' });
    await expect(invalid.promise).rejects.toBeInstanceOf(InvalidFactValueError);
    await expect(handle.done).resolves.toMatchObject({ ok: false });
  });

  it('fails leaked scopes by stream identity even when another run shares its stream ID', async () => {
    const first = run(bodyPipeline(scope => ({
      body: scope.createStream({
        label: 'other run', async *iterate() { yield 1; },
      }),
    })), {}, options);
    const { body: foreign } = await first.result;
    const events: RunEvent[] = [];
    const second = run(bodyPipeline(scope => {
      const leaked = scope.createStream({ label: 'local leak', async *iterate() { yield 2; } });
      expect(streamIdOf(leaked)).toBe(streamIdOf(foreign));
      return { body: foreign };
    }), {}, { ...options, events: event => events.push(event) });
    await expect(second.result).rejects.toBeInstanceOf(StreamOwnershipError);
    await expect(second.done).resolves.toMatchObject({ ok: false, error: { name: 'StreamOwnershipError' } });
    expect(events).toContainEqual(expect.objectContaining({ k: 'end', how: 'errored' }));
    await expect(Array.fromAsync(foreign)).resolves.toEqual([1]);
    await expect(first.done).resolves.toEqual({ ok: true });
  });
});

describe('producer custody', () => {
  it('admits a producer’s lifecycle methods between pulls and seals the outer scope on return', async () => {
    const gate = Promise.withResolvers<void>();
    type Continuation = { body: ManagedStream<number>; value: Deferred<number> };
    const admitted = Promise.withResolvers<{ work: Promise<Continuation> }>();
    const child = compose<Turn & Body>()('sub-run', { entry: ['turn'], exit: ['body'], stages: [], ending: echoTurn });
    let outer: StageScope<Turn, Body> | undefined;
    let producer: StageScope<Turn, Body> | undefined;
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'independent producer', through: { request: { ...empty, provides: ['turn'] }, response: { ...empty, needs: ['body'] } },
      return: { provides: ['body'] },
      execute: async (facts, scope) => {
        outer = scope;
        const body = scope.createStream({
          label: 'turns',
          async *iterate(scope) {
            producer = scope;
            const work = gate.promise.then(async () => {
              const { body } = await scope.next({ ...facts, turn: 2 });
              const sub = scope.run(child, { turn: 3 });
              const third = (await sub.result).body;
              const tail = scope.createStream({ label: 'tail', async *iterate() { yield 4; } });
              const merged = scope.wrapStream({ body, third, tail }, {
                label: 'continuation', async *transform(sources) {
                  yield* sources.body;
                  yield* sources.third;
                  yield* sources.tail;
                },
              });
              const value = scope.deferred<number>('total', merged);
              value.resolve(await scope.defer('measure', Promise.resolve(5)).promise);
              return { body: merged, value: value.deferred };
            });
            admitted.resolve({ work });
            yield 1;
            const { body, value } = await work;
            yield* body;
            yield await value.promise;
          },
        });
        return { body };
      },
    });
    const pipeline = compose<Turn & Body>()('turns', { entry: ['turn'], exit: ['body'], stages: [stage], ending: echoTurn });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    expect(() => outer!.next({ turn: 2 })).toThrow(StageScopeClosedError);
    expect(() => outer!.run(child, { turn: 2 })).toThrow(StageScopeClosedError);
    expect(() => outer!.createStream({ label: 'late', async *iterate() { yield 0; } })).toThrow(StageScopeClosedError);
    expect(() => outer!.wrapStream(body, { label: 'late', transform: source => source })).toThrow(StageScopeClosedError);
    expect(() => outer!.defer('late', Promise.resolve(0))).toThrow(StageScopeClosedError);
    expect(() => outer!.deferred('late', body)).toThrow(StageScopeClosedError);
    const reader = body[Symbol.asyncIterator]();
    await expect(reader.next()).resolves.toEqual({ done: false, value: 1 });
    gate.resolve();
    const { work } = await admitted.promise;
    await expect(work).resolves.toMatchObject({ body: { label: 'continuation' } });
    expect(producer).not.toBe(outer);
    const rest = await Array.fromAsync({ [Symbol.asyncIterator]: () => reader });
    expect(rest).toEqual([2, 3, 4, 5]);
    expect(() => producer!.next({ turn: 2 })).toThrow(StageScopeClosedError);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('rebinds an ending’s into calls to its producer scope', async () => {
    type Targets = { child: StaticTarget<Turn, Body, {}> };
    const child = compose<Turn & Body>()('echo', { entry: ['turn'], exit: ['body'], stages: [], ending: echoTurn });
    let outer: EndingScope<Targets> | undefined;
    const ending = defineEnding<Turn, Body, Targets>({
      name: 'producer ending', request: { needs: ['turn'] },
      into: { child: { request: empty, response: { ...empty, needs: ['body'] } } },
      return: { provides: ['body'] },
      execute: async (facts, scope) => {
        outer = scope;
        return {
          body: scope.createStream({
            label: 'ending body', async *iterate(scope) { yield* (await scope.into.child(facts)).body; },
          }),
        };
      },
    });
    const pipeline = compose<Turn & Body>()('ending', {
      entry: ['turn'], exit: ['body'], stages: [], ending, targets: { child },
    });
    link([pipeline]);
    const handle = run(pipeline, { turn: 3 }, options);
    const { body } = await handle.result;
    expect(() => outer!.into.child({ turn: 3 })).toThrow(StageScopeClosedError);
    await expect(Array.fromAsync(body)).resolves.toEqual([3]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('interrupts a pending child with the producer panic and drops custody without a leak', async () => {
    const boom = new Error('producer panic');
    const stopped = Promise.withResolvers<unknown>();
    const childEnd = Promise.withResolvers<StreamEnd>();
    const ending = defineEnding<Turn, Body>({
      name: 'pending child', request: { needs: ['turn'] }, return: { provides: ['body'] },
      execute: async (_facts, scope) => {
        scope.createStream({
          label: 'child-owned', async *iterate() { yield 1; }, onClose: childEnd.resolve,
        });
        return await new Promise<never>((_resolve, reject) => {
          scope.signal.addEventListener('abort', () => {
            stopped.resolve(scope.signal.reason);
            reject(scope.signal.reason);
          }, { once: true });
        });
      },
    });
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'panicking producer', through: { request: empty, response: { ...empty, needs: ['body'] } },
      return: { provides: ['body'] },
      execute: async (facts, scope) => ({
        body: scope.createStream<number>({
          label: 'panicking stream',
          async *iterate(scope) {
            scope.createStream({ label: 'producer-owned', async *iterate() { yield 1; } });
            void scope.next(facts);
            throw boom;
          },
        }),
      }),
    });
    const pipeline = compose<Turn & Body>()('panic', { entry: ['turn'], exit: ['body'], stages: [stage], ending });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    await expect(body[Symbol.asyncIterator]().next()).rejects.toBe(boom);
    await expect(stopped.promise).resolves.toBe(boom);
    await expect(childEnd.promise).resolves.toEqual({ how: 'errored', error: boom });
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'Error', message: boom.message } });
  });

  it('continues a ReAct turn in the wrapper transform after leave and drains both child streams', async () => {
    const events: RunEvent[] = [];
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        const body = scope.wrapStream(first.body, {
          label: 'tools',
          async *transform(source, scope) {
            yield* source;
            const second = await scope.next({ ...facts, turn: 2 });
            yield* second.body;
          },
          onClose: () => { expect(() => scope.next(facts)).toThrow(StageScopeClosedError); },
        });
        return { ...first, body };
      },
    });
    const pipeline = compose<Turn & Body>()('tools', { entry: ['turn'], exit: ['body'], stages: [stage], ending: echoTurn });
    const handle = run(pipeline, { turn: 1 }, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    expect(events).toContainEqual(expect.objectContaining({ k: 'leave', stageId: 1 }));
    expect(events).not.toContainEqual(expect.objectContaining({ k: 'closed', stageId: 1 }));
    await expect(Array.fromAsync(body)).resolves.toEqual([1, 2]);
    await expect(handle.done).resolves.toEqual({ ok: true });
    const returnIndex = events.findIndex(event => event.k === 'leave' && event.stageId === 1);
    const nextIndex = events.findIndex(event => event.k === 'enter' && event.parentStageId === 1 && event.facts.turn === 2);
    const closeIndex = events.findIndex(event => event.k === 'closed' && event.stageId === 1);
    expect(nextIndex).toBeGreaterThan(returnIndex);
    expect(closeIndex).toBeGreaterThan(nextIndex);
  });

  it('reports an unconsumed second-turn stream as a producer leak', async () => {
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        return {
          body: scope.wrapStream(first.body, {
            label: 'tools', async *transform(source, scope) {
              yield* source;
              await scope.next({ ...facts, turn: 2 });
            },
          }),
        };
      },
    });
    const pipeline = compose<Turn & Body>()('tools', { entry: ['turn'], exit: ['body'], stages: [stage], ending: echoTurn });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    await expect(Array.fromAsync(body)).rejects.toBeInstanceOf(StreamLeakError);
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'StreamLeakError', message: expect.stringContaining('turn 2') } });
  });

  it('releases a second-turn read only after the wrapper settles and runs its hook', async () => {
    const pulling = Promise.withResolvers<AbortSignal>();
    const order: string[] = [];
    const ending = defineEnding<Turn, Body>({
      name: 'turn', request: { needs: ['turn'] }, return: { provides: ['body'] },
      execute: async ({ turn }, scope) => ({
        body: scope.createStream({
          label: `turn ${turn}`, async *iterate(scope) {
            const { signal } = scope;
            if (turn === 1) {
              yield 1;
              return;
            }
            pulling.resolve(signal);
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          },
          onClose: end => { order.push(`turn ${turn} ${end.how}`); },
        }),
      }),
    });
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        return {
          body: scope.wrapStream(first.body, {
            label: 'tools', async *transform(source, scope) {
              try {
                yield* source;
                const second = await scope.next({ ...facts, turn: 2 });
                yield* second.body;
              } finally {
                order.push('transform settled');
              }
            },
            onClose: () => { order.push('wrapper hook'); },
          }),
        };
      },
    });
    const pipeline = compose<Turn & Body>()('tools', { entry: ['turn'], exit: ['body'], stages: [stage], ending });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    const reader = body[Symbol.asyncIterator]();
    await expect(reader.next()).resolves.toEqual({ done: false, value: 1 });
    const pending = reader.next();
    const signal = await pulling.promise;
    expect(signal.aborted).toBe(false);
    await body.close();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(signal.aborted).toBe(true);
    expect(order).toEqual(['turn 1 exhausted', 'transform settled', 'wrapper hook', 'turn 2 released']);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('cancels a ReAct call still awaiting headers when the producer releases', async () => {
    const starting = Promise.withResolvers<AbortSignal>();
    const ending = defineEnding<Turn, Body>({
      name: 'turn', request: { needs: ['turn'] }, return: { provides: ['body'] },
      execute: async ({ turn }, scope) => {
        if (turn === 2) await new Promise<never>((_resolve, reject) => {
          scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true });
          starting.resolve(scope.signal);
        });
        return { body: scope.createStream({ label: 'first', async *iterate() { yield 1; } }) };
      },
    });
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        return {
          body: scope.wrapStream(first.body, {
            label: 'tools', async *transform(source, scope) {
              yield* source;
              const { body } = await scope.next({ ...facts, turn: 2 });
              yield* body;
            },
          }),
        };
      },
    });
    const pipeline = compose<Turn & Body>()('tools', { entry: ['turn'], exit: ['body'], stages: [stage], ending });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    const reader = body[Symbol.asyncIterator]();
    await expect(reader.next()).resolves.toEqual({ done: false, value: 1 });
    const pending = reader.next();
    const signal = await starting.promise;
    expect(signal.aborted).toBe(false);
    await body.close();
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ done: true });
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('closes a pass-through stage before its child-owned stream ends', async () => {
    let captured: Next<Turn, Body> | undefined;
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'pass-through', through: { request: empty, response: { ...empty, needs: ['body'] } },
      execute: async (facts, scope) => {
        captured = scope.next;
        return await scope.next(facts);
      },
    });
    const pipeline = compose<Turn & Body>()('pass-through', { entry: ['turn'], exit: ['body'], stages: [stage], ending: echoTurn });
    const handle = run(pipeline, { turn: 1 }, options);
    const { body } = await handle.result;
    expect(() => captured!({ turn: 1 })).toThrow(StageScopeClosedError);
    await expect(Array.fromAsync(body)).resolves.toEqual([1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });
});

describe('host and child cancel domains', () => {
  it.each(['next', 'into'] as const)('interrupts a child %s stream and fetch while its caller keeps running', async edge => {
    type Request = { operation?: 'body' | 'headers' };
    type ChildRequest = { operation: 'body' | 'headers' };
    type Answer = { parent: string };
    const headers = Promise.withResolvers<AbortSignal>();
    const frames = Promise.withResolvers<AbortSignal>();
    const reason = new Error('generation interrupted');
    const declaration = {
      request: { ...empty, provides: ['operation'] }, response: { needs: ['body'], consumes: ['body'], provides: ['parent'] },
    };
    const child = defineEnding<ChildRequest, Body>({
      name: 'child', request: { needs: ['operation'] }, return: { provides: ['body'] },
      execute: async ({ operation }, scope) => {
        if (operation === 'headers') await new Promise<never>((_resolve, reject) => {
          scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true });
          headers.resolve(scope.signal);
        });
        return {
          body: scope.createStream({
            label: 'generation', async *iterate(scope) {
              const { signal } = scope;
              frames.resolve(signal);
              await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
              yield 1;
            },
          }),
        };
      },
    });
    const execute = async (facts: Request, call: Next<ChildRequest, Body>, scope: Scope): Promise<Answer> => {
      const interrupt = new AbortController();
      const childOptions = { signal: interrupt.signal };
      const { body, ...response } = await call({ ...facts, operation: 'body' }, childOptions);
      const read = body[Symbol.asyncIterator]().next();
      const pending = call({ ...facts, operation: 'headers' }, childOptions);
      const [fetchSignal, bodySignal] = await Promise.all([headers.promise, frames.promise]);
      interrupt.abort(reason);
      expect(fetchSignal.reason).toBe(reason);
      expect(bodySignal.reason).toBe(reason);
      expect(scope.signal.aborted).toBe(false);
      await expect(pending).rejects.toBe(reason);
      await expect(read).resolves.toMatchObject({ done: true });
      return { ...response, parent: 'continued' };
    };
    const pipeline = edge === 'next' ? compose<Request & Answer>()('parent', {
      entry: [], exit: ['parent'],
      stages: [defineStage<Request, ChildRequest, Body, Answer>({ name: 'parent', through: declaration, execute: (facts, scope) => execute(facts, scope.next, scope) })], ending: child,
    }) : compose<Request & Answer>()('parent', {
      entry: [], exit: ['parent'],
      stages: [], targets: { child: compose<ChildRequest & Body>()('child', { entry: ['operation'], exit: ['body'], stages: [], ending: child }) },
      ending: defineEnding<Request, Answer, { child: StaticTarget<ChildRequest, Body, {}> }>({
        name: 'parent', request: { needs: [] }, into: { child: declaration },
        execute: async (facts, scope) => await execute(facts, scope.into.child, scope),
      }),
    });
    link([pipeline]);
    const handle = run(pipeline, {}, options);
    await expect(handle.result).resolves.toEqual({ parent: 'continued' });
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('round-trips a root-created stream through next and a sub-run by identity', async () => {
    let rootEnv: RootEnv | undefined;
    let original: ManagedStream<number> | undefined;
    const events: RunEvent[] = [];
    const options = { services: {}, finalizationTimeoutMs: 200, events: (event: RunEvent) => events.push(event) };
    const sub = compose<Body>()('child', {
      entry: ['body'], exit: ['body'],
      stages: [], ending: defineEnding<Body, Body>({
        name: 'child', request: { needs: ['body'] }, return: { provides: ['body'] }, execute: async facts => facts,
      }),
    });
    const end = defineEnding<Body, Body>({
      name: 'subrun', request: { needs: ['body'] }, return: { provides: ['body'] },
      execute: async (facts, scope) => await scope.run(sub, facts).result,
    });
    const stage = defineStage<Body, Body, Body, Body>({
      name: 'next', through: { request: empty, response: { ...empty, needs: ['body'] } }, execute: async (facts, scope) => await scope.next(facts),
    });
    const pipeline = compose<Body>()('parent', { entry: ['body'], exit: ['body'], stages: [stage], ending: end });
    const handle = run(pipeline, root => {
      rootEnv = root;
      original = root.createStream({ label: 'input', async *iterate() { yield 1; } });
      return { body: original };
    }, options);
    const { body } = await handle.result;
    expect(body).toBe(original);
    expect(() => rootEnv!.createStream({ label: 'late', async *iterate() { yield 2; } })).toThrow(StageScopeClosedError);
    await expect(Array.fromAsync(body)).resolves.toEqual([1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
    expect(events).toContainEqual(expect.objectContaining({ k: 'stream', stageId: 1, label: 'input' }));
    expect(events).toContainEqual(expect.objectContaining({ k: 'enter', stageId: 3, parentStageId: 2, edge: 'subrun' }));
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it('does not spend the finalization budget while a healthy exported body is still open', async () => {
    const events: RunEvent[] = [];
    const handle = run(bodyPipeline(scope => ({ body: scope.createStream({ label: 'body', async *iterate() { yield 1; } }) })), {}, {
      ...options, finalizationTimeoutMs: 10, events: event => events.push(event),
    });
    const { body } = await handle.result;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events.some(event => event.k === 'done')).toBe(false);
    await expect(Array.fromAsync(body)).resolves.toEqual([1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });
});

describe('named stream merges', () => {
  it('adopts two typed inputs and interleaves their frames', async () => {
    const events: RunEvent[] = [];
    const handle = run(bodyPipeline(scope => {
      const a = scope.createStream<number>({ label: 'numbers', async *iterate() { yield 1; yield 3; } });
      const b = scope.createStream<string>({ label: 'strings', async *iterate() { yield '2'; yield '4'; } });
      const body = scope.wrapStream({ a, b }, {
        label: 'merge', async *transform(sources) {
          expectTypeOf(sources.a).toEqualTypeOf<AsyncIterable<number>>();
          expectTypeOf(sources.b).toEqualTypeOf<AsyncIterable<string>>();
          const first = sources.a[Symbol.asyncIterator]();
          const second = sources.b[Symbol.asyncIterator]();
          while (true) {
            const [a, b] = await Promise.all([first.next(), second.next()]);
            if (a.done || b.done) return;
            yield a.value;
            yield Number(b.value);
          }
        },
        onClose: (_end, inners) => {
          expectTypeOf(inners.a).toEqualTypeOf<ReleasingInner<number> | null>();
          expectTypeOf(inners.b).toEqualTypeOf<ReleasingInner<string> | null>();
        },
      });
      expect(() => a[Symbol.asyncIterator]()).toThrow(StreamOwnershipError);
      expect(() => b[Symbol.asyncIterator]()).toThrow(StreamOwnershipError);
      return { body };
    }), {}, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    await expect(Array.fromAsync(body)).resolves.toEqual([1, 2, 3, 4]);
    await expect(handle.done).resolves.toEqual({ ok: true });
    const [a, b, merge] = events.filter(event => event.k === 'stream');
    expect(merge).toMatchObject({ streamId: streamIdOf(body), wraps: [a.streamId, b.streamId] });
  });

  it('keeps both reads on release mid-race and stops the inners in declaration order', async () => {
    const signalA = Promise.withResolvers<AbortSignal>();
    const signalB = Promise.withResolvers<AbortSignal>();
    const frameA = Promise.withResolvers<number>();
    const frameB = Promise.withResolvers<number>();
    const closingA = Promise.withResolvers<void>();
    const finishA = Promise.withResolvers<void>();
    const order: string[] = [];
    const handle = run(bodyPipeline(scope => {
      const a = scope.createStream({
        label: 'a', async *iterate(scope) { const { signal } = scope; signalA.resolve(signal); yield await frameA.promise; },
        onClose: async end => { order.push(`a ${end.how}`); closingA.resolve(); await finishA.promise; },
      });
      const b = scope.createStream({
        label: 'b', async *iterate(scope) { const { signal } = scope; signalB.resolve(signal); yield await frameB.promise; },
        onClose: end => { order.push(`b ${end.how}`); },
      });
      return {
        body: scope.wrapStream({ a, b }, {
          label: 'merge', async *transform(sources) {
            const first = sources.a[Symbol.asyncIterator]();
            const second = sources.b[Symbol.asyncIterator]();
            const frame = await Promise.race([first.next(), second.next()]);
            await Promise.all([first.return?.(), second.return?.()]);
            order.push('transform settled');
            if (!frame.done) yield frame.value;
          },
          onClose: async (_end, { a, b }) => {
            order.push('merge hook');
            expect((await signalA.promise).aborted).toBe(false);
            expect((await signalB.promise).aborted).toBe(false);
            frameA.resolve(1);
            frameB.resolve(2);
            await expect(Promise.all([a!.next(), b!.next()])).resolves.toEqual([{ value: 1, done: false }, { value: 2, done: false }]);
          },
        }),
      };
    }), {}, options);
    const { body } = await handle.result;
    const read = body[Symbol.asyncIterator]().next();
    const [a, b] = await Promise.all([signalA.promise, signalB.promise]);
    const release = body.close();
    await closingA.promise;
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    finishA.resolve();
    await release;
    await expect(read).resolves.toMatchObject({ done: true });
    expect(b.aborted).toBe(true);
    expect(order).toEqual(['transform settled', 'merge hook', 'a released', 'b released']);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('cancels both inputs eagerly and supplies null loans', async () => {
    const controller = new AbortController();
    const readyA = Promise.withResolvers<AbortSignal>();
    const readyB = Promise.withResolvers<AbortSignal>();
    const handle = run(bodyPipeline(scope => {
      const input = (label: string, ready: ReturnType<typeof Promise.withResolvers<AbortSignal>>) => scope.createStream({
        label, async *iterate(scope) {
          const { signal } = scope;
          ready.resolve(signal);
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          yield 1;
        },
      });
      return {
        body: scope.wrapStream({ a: input('a', readyA), b: input('b', readyB) }, {
          label: 'merge', async *transform(sources) {
            const [a, b] = await Promise.all([sources.a[Symbol.asyncIterator]().next(), sources.b[Symbol.asyncIterator]().next()]);
            if (!a.done) yield a.value;
            if (!b.done) yield b.value;
          },
          onClose: (end, inners) => {
            expect(end.how).toBe('cancelled');
            expect(inners).toEqual({ a: null, b: null });
          },
        }),
      };
    }), {}, { ...options, signal: controller.signal });
    const { body } = await handle.result;
    const read = body[Symbol.asyncIterator]().next();
    const [a, b] = await Promise.all([readyA.promise, readyB.promise]);
    controller.abort();
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(true);
    await expect(read).resolves.toMatchObject({ done: true });
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('lets the release hook classify read failures independently for each input', async () => {
    const first = new Error('first read failed');
    const second = new Error('second read failed');
    const events: RunEvent[] = [];
    const handle = run(bodyPipeline(scope => ({
      body: scope.wrapStream({
        a: scope.createStream<number>({ label: 'a', async *iterate() { throw first; } }),
        b: scope.createStream<number>({ label: 'b', async *iterate() { throw second; } }),
      }, {
        label: 'merge', transform: sources => sources.a,
        onClose: async (_end, { a, b }) => {
          await Promise.all([expect(a!.next()).rejects.toBe(first), expect(b!.next()).rejects.toBe(second)]);
        },
      }),
    })), {}, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    await body.close();
    await expect(handle.done).resolves.toEqual({ ok: true });
    const errors = events.flatMap(event => event.k === 'end' && event.how === 'errored' ? [event.error?.message] : []);
    expect(errors).toEqual(expect.arrayContaining([first.message, second.message]));
    expect(errors).toHaveLength(2);
  });

  it('preserves ownership when any input is unavailable or listed twice', async () => {
    const handle = run(bodyPipeline(async scope => {
      const a = scope.createStream({ label: 'a', async *iterate() { yield 1; } });
      const b = scope.createStream({ label: 'b', async *iterate() { yield 2; } });
      await b[Symbol.asyncIterator]().next();
      expect(() => scope.wrapStream({ a, b }, { label: 'unavailable', transform: sources => sources.a })).toThrow(StreamOwnershipError);
      expect(() => scope.wrapStream({ a, alias: a }, { label: 'duplicate', transform: sources => sources.a })).toThrow('duplicate input');
      await b.close();
      return { body: a };
    }), {}, options);
    const { body } = await handle.result;
    await expect(Array.fromAsync(body)).resolves.toEqual([1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('rejects concurrent reads on one named source while another can advance', async () => {
    const frame = Promise.withResolvers<number>();
    const handle = run(bodyPipeline(scope => ({
      body: scope.wrapStream({
        a: scope.createStream({ label: 'a', async *iterate() { yield await frame.promise; } }),
        b: scope.createStream({ label: 'b', async *iterate() { yield 2; } }),
      }, {
        label: 'merge', async *transform(sources) {
          const a = sources.a[Symbol.asyncIterator]().next();
          await expect(sources.a[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(ConcurrentStreamReadError);
          const b = await sources.b[Symbol.asyncIterator]().next();
          if (!b.done) yield b.value;
          frame.resolve(1);
          const first = await a;
          if (!first.done) yield first.value;
        },
      }),
    })), {}, options);
    const { body } = await handle.result;
    await expect(Array.fromAsync(body)).resolves.toEqual([2, 1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });

  it('admits next from a merge producer after the stage answers', async () => {
    const events: RunEvent[] = [];
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'merge turns', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, scope) => {
        const first = await scope.next(facts);
        const controls = scope.createStream({ label: 'controls', async *iterate() { yield 9; } });
        return {
          body: scope.wrapStream({ generation: first.body, controls }, {
            label: 'merge', async *transform(sources, scope) {
              yield* sources.generation;
              yield* sources.controls;
              const { body } = await scope.next({ ...facts, turn: 2 });
              yield* body;
            },
          }),
        };
      },
    });
    const pipeline = compose<Turn & Body>()('merge', { entry: ['turn'], exit: ['body'], stages: [stage], ending: echoTurn });
    const handle = run(pipeline, { turn: 1 }, { ...options, events: event => events.push(event) });
    const { body } = await handle.result;
    await expect(Array.fromAsync(body)).resolves.toEqual([1, 9, 2]);
    await expect(handle.done).resolves.toEqual({ ok: true });
    const leave = events.findIndex(event => event.k === 'leave' && event.stageId === 1);
    const resumed = events.findIndex(event => event.k === 'enter' && event.parentStageId === 1 && event.facts.turn === 2);
    expect(leave).toBeGreaterThan(-1);
    expect(resumed).toBeGreaterThan(leave);
  });

  it('reports the leaking merge and releases its owned inputs', async () => {
    const order: string[] = [];
    const ending = defineEnding<{}, {}>({
      name: 'lose merge', request: { needs: [] }, return: { provides: [] },
      execute: async (_facts, scope) => {
        const input = (label: string) => scope.createStream({
          label, async *iterate() { yield label; }, onClose: end => { order.push(`${label} ${end.how}`); },
        });
        scope.wrapStream({ a: input('a'), b: input('b') }, {
          label: 'merge', transform: sources => sources.a, onClose: end => { order.push(`merge ${end.how}`); },
        });
        return {};
      },
    });
    const handle = run(compose()('leak', { entry: [], exit: [], stages: [], ending }), {}, options);
    await expect(handle.result).resolves.toEqual({});
    await expect(handle.done).resolves.toMatchObject({ ok: false, error: { name: 'StreamLeakError', fields: { labels: ['merge'] } } });
    expect(order).toEqual(['merge leaked', 'a released', 'b released']);
  });
});
