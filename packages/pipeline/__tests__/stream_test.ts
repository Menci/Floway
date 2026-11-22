import { describe, expect, it } from 'vitest';

import {
  compose,
  ConcurrentStreamReadError,
  defineEnding,
  defineStage,
  DuplicateStreamCloseError,
  run,
  StageScopeClosedError,
  streamIdOf,
  StreamLeakError,
  StreamOwnershipError,
} from '../src/index.ts';
import type { ManagedStream, Next, RunEvent, StageEnv, StreamEnd } from '../src/index.ts';

type Body = { body: ManagedStream<number> };
type Turn = { turn: number };
const options = { services: {}, finalizationTimeoutMs: 200 };
const empty = { needs: [], consumes: [], provides: [] };

const bodyPipeline = (execute: (env: StageEnv) => Body | Promise<Body>) => compose<{}, Body, {}>('pipeline', {
  stages: [],
  ending: defineEnding<{}, Body>({
    name: 'stream stage', request: { needs: [] }, response: { provides: ['body'] },
    execute: async (_facts, _into, env) => await execute(env),
  }),
});

const echoTurn = defineEnding<Turn, Body>({
  name: 'echo', request: { needs: ['turn'] }, response: { provides: ['body'] },
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
            expect(await Array.fromAsync(inner)).toEqual([7]);
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
    expect(() => body[Symbol.asyncIterator]()).toThrow(StreamOwnershipError);
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
      name: 'reader', request: { needs: [] }, response: { provides: ['body'] },
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
      name: 'turn', request: { needs: ['turn'] }, response: { provides: ['body'] },
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
