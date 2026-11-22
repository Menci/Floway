import { describe, expect, it } from 'vitest';

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
import type { Deferred, ManagedStream, Next, RootEnv, RunEvent, StageEnv, StaticTarget, StreamEnd } from '../src/index.ts';

type Body = { body: ManagedStream<number> };
type Turn = { turn: number };
const options = { services: {}, finalizationTimeoutMs: 200 };
const empty = { needs: [], consumes: [], provides: [] };

const bodyPipeline = (execute: (env: StageEnv) => Body | Promise<Body>) => compose<{}, Body, {}>('pipeline', {
  stages: [],
  ending: defineEnding<{}, Body>({
    name: 'stream stage', request: { needs: [] }, return: { provides: ['body'] },
    execute: async (_facts, _into, env) => await execute(env),
  }),
});

const echoTurn = defineEnding<Turn, Body>({
  name: 'echo', request: { needs: ['turn'] }, return: { provides: ['body'] },
  execute: async ({ turn }, _into, env) => ({
    body: env.createStream({ label: `turn ${turn}`, async *iterate() { yield turn; } }),
  }),
});

describe('stream release and cancellation', () => {
  it('lets onClose drain the inner after the wrapper iterator settles', async () => {
    const order: string[] = [];
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'inner',
        async *iterate(signal) {
          yield 1;
          expect(signal.aborted).toBe(false);
          yield 2;
          yield 3;
        },
        onClose: end => { order.push(`inner ${end.how}`); },
      });
      const body = env.wrapStream(inner, {
        label: 'wrapper',
        async *transform(source, signal) {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'inner', async *iterate(signal) {
          pulling.resolve();
          yield await frame.promise;
          expect(signal.aborted).toBe(false);
          yield 8;
        },
      });
      return {
        body: env.wrapStream(inner, {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'blocked inner', async *iterate(signal) {
          pulling.resolve(signal);
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
          yield 1;
        },
      });
      return {
        body: env.wrapStream(inner, {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'inner', async *iterate() {
          pulling.resolve();
          yield await upstream.promise;
        },
      });
      innerId = streamIdOf(inner);
      return {
        body: env.wrapStream(inner, {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream<number>({ label: 'inner', async *iterate() { throw readError; } });
      innerId = streamIdOf(inner);
      return {
        body: env.wrapStream(inner, {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'inner', async *iterate(signal) {
          signal.addEventListener('abort', () => order.push('inner abort'), { once: true });
          yield 1;
          throw new Error('An unobserved body was drained');
        },
        onClose: end => { order.push(`inner ${end.how}`); },
      });
      return {
        body: env.wrapStream(inner, {
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
    const handle = run(bodyPipeline(env => {
      const inner = env.createStream({
        label: 'inner', async *iterate(signal) {
          pulling.resolve();
          await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted.push('inner'); resolve(); }, { once: true }));
          yield 1;
        },
        onClose: end => { ends.push(end); },
      });
      return {
        body: env.wrapStream(inner, {
          label: 'outer', transform: (source, signal) => {
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
    const handle = run(bodyPipeline(env => ({
      body: env.createStream({
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
      execute: async (_facts, _into, env) => ({
        body: env.createStream({
          label: 'body', async *iterate() {
            yield frame;
            throw error;
          },
        }),
      }),
    });
    const pipeline = compose<{}, { body: ManagedStream<typeof frame> }, {}>('reader', { stages: [], ending });
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
      execute: async (_facts, _into, env) => {
        const nested = { deferred: env.defer('value', Promise.resolve(1)) };
        const body = env.createStream({ label: 'body', async *iterate() { yield { nested }; } });
        const invalid = env.defer('body handle', Promise.resolve({ body }));
        return { nested, body, invalid };
      },
    });
    const pipeline = compose<{}, Output, {}>('handles', { stages: [], ending });
    const handle = run(pipeline, {}, options);
    const { body, invalid, nested } = await handle.result;
    expect(Object.isFrozen(nested)).toBe(true);
    await expect(body[Symbol.asyncIterator]().next()).rejects.toMatchObject({ name: 'InvalidFactValueError', path: 'stream(body).frame.nested.deferred' });
    await expect(invalid.promise).rejects.toBeInstanceOf(InvalidFactValueError);
    await expect(handle.done).resolves.toMatchObject({ ok: false });
  });

  it('fails leaked scopes by stream identity even when another run shares its stream ID', async () => {
    const first = run(bodyPipeline(env => ({
      body: env.createStream({
        label: 'other run', async *iterate() { yield 1; },
      }),
    })), {}, options);
    const { body: foreign } = await first.result;
    const events: RunEvent[] = [];
    const second = run(bodyPipeline(env => {
      const leaked = env.createStream({ label: 'local leak', async *iterate() { yield 2; } });
      expect(streamIdOf(leaked)).toBe(streamIdOf(foreign));
      return { body: foreign };
    }), {}, { ...options, events: event => events.push(event) });
    await expect(second.result).rejects.toBeInstanceOf(StreamOwnershipError);
    await expect(second.done).resolves.toMatchObject({
      ok: false, error: {
        errors: expect.arrayContaining([{
          name: 'StreamLeakError', message: expect.stringContaining('local leak'), stack: expect.any(String),
          fields: { name: 'StreamLeakError', stageName: 'stream stage', labels: ['local leak'] },
        }]),
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ k: 'end', how: 'leaked' }));
    await expect(Array.fromAsync(foreign)).resolves.toEqual([1]);
    await expect(first.done).resolves.toEqual({ ok: true });
  });
});

describe('producer custody', () => {
  it('continues a ReAct turn in the wrapper transform after leave and drains both child streams', async () => {
    const events: RunEvent[] = [];
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, next, env) => {
        const first = await next(facts);
        const body = env.wrapStream(first.body, {
          label: 'tools',
          async *transform(source) {
            yield* source;
            const second = await next({ ...facts, turn: 2 });
            yield* second.body;
          },
          onClose: () => { expect(() => next(facts)).toThrow(StageScopeClosedError); },
        });
        return { ...first, body };
      },
    });
    const pipeline = compose<Turn, Body, {}>('tools', { stages: [stage], ending: echoTurn });
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
      execute: async (facts, next, env) => {
        const first = await next(facts);
        return {
          body: env.wrapStream(first.body, {
            label: 'tools', async *transform(source) {
              yield* source;
              await next({ ...facts, turn: 2 });
            },
          }),
        };
      },
    });
    const pipeline = compose<Turn, Body, {}>('tools', { stages: [stage], ending: echoTurn });
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
      execute: async ({ turn }, _into, env) => ({
        body: env.createStream({
          label: `turn ${turn}`, async *iterate(signal) {
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
      execute: async (facts, next, env) => {
        const first = await next(facts);
        return {
          body: env.wrapStream(first.body, {
            label: 'tools', async *transform(source) {
              try {
                yield* source;
                const second = await next({ ...facts, turn: 2 });
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
    const pipeline = compose<Turn, Body, {}>('tools', { stages: [stage], ending });
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
      execute: async ({ turn }, _into, env) => {
        if (turn === 2) await new Promise<never>((_resolve, reject) => {
          env.signal.addEventListener('abort', () => reject(env.signal.reason), { once: true });
          starting.resolve(env.signal);
        });
        return { body: env.createStream({ label: 'first', async *iterate() { yield 1; } }) };
      },
    });
    const stage = defineStage<Turn, Turn, Body, Body>({
      name: 'tool loop', through: {
        request: { ...empty, provides: ['turn'] }, response: { ...empty, provides: ['body'] },
      },
      execute: async (facts, next, env) => {
        const first = await next(facts);
        return {
          body: env.wrapStream(first.body, {
            label: 'tools', async *transform(source) {
              yield* source;
              const { body } = await next({ ...facts, turn: 2 });
              yield* body;
            },
          }),
        };
      },
    });
    const pipeline = compose<Turn, Body, {}>('tools', { stages: [stage], ending });
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
      name: 'pass-through', through: { request: empty, response: empty },
      execute: async (facts, next) => {
        captured = next;
        return await next(facts);
      },
    });
    const pipeline = compose<Turn, Body, {}>('pass-through', { stages: [stage], ending: echoTurn });
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
      execute: async ({ operation }, _into, env) => {
        if (operation === 'headers') await new Promise<never>((_resolve, reject) => {
          env.signal.addEventListener('abort', () => reject(env.signal.reason), { once: true });
          headers.resolve(env.signal);
        });
        return {
          body: env.createStream({
            label: 'generation', async *iterate(signal) {
              frames.resolve(signal);
              await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
              yield 1;
            },
          }),
        };
      },
    });
    const execute = async (facts: Request, call: Next<ChildRequest, Body>, env: StageEnv): Promise<Answer> => {
      const interrupt = new AbortController();
      const childOptions = { signal: interrupt.signal };
      const { body, ...response } = await call({ ...facts, operation: 'body' }, childOptions);
      const read = body[Symbol.asyncIterator]().next();
      const pending = call({ ...facts, operation: 'headers' }, childOptions);
      const [fetchSignal, bodySignal] = await Promise.all([headers.promise, frames.promise]);
      interrupt.abort(reason);
      expect(fetchSignal.reason).toBe(reason);
      expect(bodySignal.reason).toBe(reason);
      expect(env.signal.aborted).toBe(false);
      await expect(pending).rejects.toBe(reason);
      await expect(read).resolves.toMatchObject({ done: true });
      return { ...response, parent: 'continued' };
    };
    const pipeline = edge === 'next' ? compose<Request, Answer, {}>('parent', {
      stages: [defineStage<Request, ChildRequest, Body, Answer>({ name: 'parent', through: declaration, execute })], ending: child,
    }) : compose<Request, Answer, {}, { child: StaticTarget<ChildRequest, Body, {}> }>('parent', {
      stages: [], targets: { child: compose<ChildRequest, Body, {}>('child', { stages: [], ending: child }) },
      ending: defineEnding<Request, Answer, { child: StaticTarget<ChildRequest, Body, {}> }>({
        name: 'parent', request: { needs: [] }, into: { child: declaration },
        execute: async (facts, into, env) => await execute(facts, into.child, env),
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
    const sub = compose<Body, Body, {}>('child', {
      stages: [], ending: defineEnding<Body, Body>({
        name: 'child', request: { needs: ['body'] }, return: { provides: ['body'] }, execute: async facts => facts,
      }),
    });
    const end = defineEnding<Body, Body>({
      name: 'subrun', request: { needs: ['body'] }, return: { provides: ['body'] },
      execute: async (facts, _into, env) => await env.run(sub, facts).result,
    });
    const stage = defineStage<Body, Body, Body, Body>({
      name: 'next', through: { request: empty, response: empty }, execute: async (facts, next) => await next(facts),
    });
    const pipeline = compose<Body, Body, {}>('parent', { stages: [stage], ending: end });
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
    const handle = run(bodyPipeline(env => ({ body: env.createStream({ label: 'body', async *iterate() { yield 1; } }) })), {}, {
      ...options, finalizationTimeoutMs: 10, events: event => events.push(event),
    });
    const { body } = await handle.result;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(events.some(event => event.k === 'done')).toBe(false);
    await expect(Array.fromAsync(body)).resolves.toEqual([1]);
    await expect(handle.done).resolves.toEqual({ ok: true });
  });
});
