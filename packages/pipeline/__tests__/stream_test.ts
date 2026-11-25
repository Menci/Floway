import { describe, expect, it } from 'vitest';

import { host } from './run-fixture.ts';
import { factSpace, run } from '../src/index.ts';
import type { Deferred, ManagedStream } from '../src/index.ts';

type Body = ManagedStream<string, string>;

const request = { needs: [], provides: [], consumes: [] } as const;
const bodyResponse = { needs: ['response.body'], provides: ['response.body'], consumes: [] } as const;

describe('streams', () => {
  it.each([false, true])('delivers an Err as data and rejects a later yield (extra frame: %s)', async extra => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    const release = Promise.withResolvers<void>();
    let active = false;
    let drained = false;
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          active = true;
          try {
            yield { ok: false, error: 'termination' };
            if (extra) {
              yield { ok: true, value: 'extra' };
              await release.promise;
              drained = true;
              throw new Error('later producer throw');
            }
          } finally {
            active = false;
          }
        }),
      }),
    });
    const pipeline = compose('stream', { entry: [], exit: ['response.body'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    expect(active).toBe(false);
    const reader = running.read(answer['response.body']);
    expect(await reader.next()).toEqual({ done: false, value: { ok: false, error: 'termination' } });
    expect(active).toBe(true);
    if (extra) {
      await expect(reader.next()).rejects.toThrow('yielded after Err');
      await expect(running.done).rejects.toThrow('yielded after Err');
      expect(recording.events).toContainEqual({ type: 'stream.end', streamId: 1, error: expect.any(Error) });
      expect(active).toBe(true);
      release.resolve();
    } else {
      expect((await reader.next()).done).toBe(true);
      await running.done;
      expect(recording.events).toContainEqual({ type: 'stream.end', streamId: 1 });
    }
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
    expect(active).toBe(false);
    expect(drained).toBe(extra);
    expect(recording.events.filter(event => event.type === 'stream.frame')).toHaveLength(1);
    expect(recording.events.filter(event => event.type === 'stream.end')).toHaveLength(1);
  });

  it.each([false, true])('reports an early reader exit and preserves a body throw (throws: %s)', async throws => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.count': number }>();
    const bodyPanic = new Error('consumer body error');
    let ended = false;
    const reader = defineStage({
      name: 'reader',
      through: { request, response: { ...bodyResponse, provides: ['response.count'], consumes: ['response.body'] } },
      execute: async (facts, scope) => {
        const { 'response.body': body, ...answer } = await scope.next(facts);
        for await (const item of scope.read(body)) {
          expect(item).toEqual({ ok: true, value: 'first' });
          if (throws) throw bodyPanic;
          break;
        }
        return { ...answer, 'response.count': 1 };
      },
    });
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          yield { ok: true, value: 'first' };
          yield { ok: true, value: 'last' };
          ended = true;
        }),
      }),
    });
    const pipeline = compose('early', { entry: [], exit: ['response.count'], stages: [reader], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    if (throws) await expect(running.result).rejects.toBe(bodyPanic);
    else await expect(running.result).rejects.toThrow('left before native done');
    await recording.rootLeft;
    expect(ended).toBe(true);
    expect(recording.events).toContainEqual({ type: 'stream.end', streamId: 1 });
  });

  it('rejects a producer leak before delivering native done', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    const trace: string[] = [];
    const wrapper = defineStage({
      name: 'wrap',
      through: { request, response: bodyResponse },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        return {
          ...answer,
          'response.body': scope.wrapStream<string, string, string, string>(answer['response.body'], async function* (inner, producer) {
            try {
              const next = await producer.read(inner).next();
              if (!next.done) yield next.value;
            } finally {
              trace.push('wrapper finally');
            }
          }),
        };
      },
    });
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          yield { ok: true, value: 'first' };
          trace.push('source drained');
        }),
      }),
    });
    const pipeline = compose('leak', { entry: [], exit: ['response.body'], stages: [wrapper], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    const reader = running.read(answer['response.body']);
    expect((await reader.next()).done).toBe(false);
    await expect(reader.next()).rejects.toThrow('Producer of stage "wrap" leaked');
    await expect(running.done).rejects.toThrow('leaked');
    await recording.rootLeft;
    expect(trace).toEqual(['wrapper finally', 'source drained']);
  });

  it('allows only one open and rejects transfer of an opened stream', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    let drained = false;
    const wrapper = defineStage({
      name: 'read-then-forward',
      through: { request, response: bodyResponse },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        const body = answer['response.body'];
        scope.read(body);
        expect(() => scope.read(body)).toThrow('twice');
        expect(() => scope.wrapStream(body, async function* () {})).toThrow('opened');
        return answer;
      },
    });
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () { drained = true; }),
      }),
    });
    const pipeline = compose('opened', { entry: [], exit: ['response.body'], stages: [wrapper], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).rejects.toThrow('transfer an opened stream');
    await recording.rootLeft;
    expect(drained).toBe(true);
  });

  it('rethrows a synchronous wrapper factory exception and drains its provisional custody', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    const panic = new Error('wrapper factory throws');
    let drained = false;
    const wrap = defineStage({
      name: 'factory',
      through: { request, response: bodyResponse },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        scope.wrapStream(answer['response.body'], (inner, producer) => {
          producer.read(inner);
          throw panic;
        });
        return answer;
      },
    });
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () { drained = true; }),
      }),
    });
    const pipeline = compose('factory', { entry: [], exit: ['response.body'], stages: [wrap], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).rejects.toBe(panic);
    await recording.rootLeft;
    expect(drained).toBe(true);
    expect(recording.events.filter(event => event.type === 'stream.end')).toEqual([{ type: 'stream.end', streamId: 1 }]);
  });

  it('rejects use of the execute continuation after execute returns', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    const wrapper = defineStage({
      name: 'uses-exited-scope',
      through: { request, response: bodyResponse },
      return: { provides: ['response.body'] },
      execute: async (facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          await scope.next(facts);
        }),
      }),
    });
    let called = false;
    const ending = defineStage({
      name: 'suffix',
      request,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => {
        called = true;
        return { 'response.body': scope.createStream<string, string>(async function* () {}) };
      },
    });
    const pipeline = compose('exited', { entry: [], exit: ['response.body'], stages: [wrapper], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    await expect(running.read(answer['response.body']).next()).rejects.toThrow('executor has exited');
    await expect(running.done).rejects.toThrow('executor has exited');
    expect(called).toBe(false);
  });
});

describe('deferreds', () => {
  it.each([false, true])('tracks an unopened leak independently of settlement (settled before exit: %s)', async settled => {
    const { defineStage, compose } = factSpace<{}>();
    const release = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const ending = defineStage({
      name: 'leak',
      request,
      return: { provides: [] },
      execute: async (_facts, scope) => {
        scope.createDeferred(async () => {
          if (!settled) await release.promise;
          return 42;
        });
        if (settled) await completed.promise;
        return {};
      },
    });
    const pipeline = compose('deferred-leak', { entry: [], exit: [], stages: [], ending });
    const recording = host({}, event => {
      if (event.type === 'deferred.settled') completed.resolve();
    });
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).rejects.toThrow('leaked 1 stream or deferred handle');
    if (!settled) {
      expect(recording.events).not.toContainEqual(expect.objectContaining({ type: 'deferred.settled' }));
      release.resolve();
    }
    await recording.rootLeft;
    expect(recording.events).toContainEqual({ type: 'deferred.settled', deferredId: 1, value: 42 });
  });

  it('supports multiple subscribers on one read and refuses a second read or wrapper', async () => {
    const { defineStage, compose } = factSpace<{ 'response.usage': Deferred<number>; 'response.total': number }>();
    const collector = defineStage({
      name: 'collect',
      through: {
        request,
        response: { needs: ['response.usage'], provides: ['response.total'], consumes: ['response.usage'] },
      },
      execute: async (facts, scope) => {
        const { 'response.usage': usage, ...answer } = await scope.next(facts);
        const once = scope.read(usage);
        expect(() => scope.read(usage)).toThrow('twice');
        expect(() => scope.wrapDeferred(usage, async () => 0)).toThrow();
        const results = await Promise.all([once.then(value => value + 1), once.then(value => value * 2)]);
        return { ...answer, 'response.total': results[0] + results[1] };
      },
    });
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.usage'] },
      execute: async (_facts, scope) => ({ 'response.usage': scope.createDeferred(async () => 3) }),
    });
    const pipeline = compose('deferred-read', { entry: [], exit: ['response.total'], stages: [collector], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).resolves.toEqual({ 'response.total': 10 });
    await running.done;
  });

  it.each([false, true])('propagates a live deferred panic and absorbs a discarded one (%s)', async discard => {
    const { defineStage, compose } = factSpace<{ 'response.usage': Deferred<number> }>();
    const release = Promise.withResolvers<void>();
    const panic = new Error('deferred panic');
    const ending = defineStage({
      name: 'source',
      request,
      return: { provides: ['response.usage'] },
      execute: async (_facts, scope) => ({
        'response.usage': scope.createDeferred(async () => {
          await release.promise;
          throw panic;
        }),
      }),
    });
    const pipeline = compose('deferred-fault', { entry: [], exit: ['response.usage'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    if (discard) {
      running.discard(answer['response.usage']);
      await running.done;
      release.resolve();
    } else {
      const read = running.read(answer['response.usage']);
      release.resolve();
      await expect(read).rejects.toBe(panic);
      await expect(running.done).rejects.toBe(panic);
    }
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
    expect(recording.events.filter(event => 'error' in event)).toEqual([
      { type: 'deferred.settled', deferredId: 1, error: panic },
    ]);
  });
});
