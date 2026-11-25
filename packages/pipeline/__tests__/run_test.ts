import { describe, expect, it } from 'vitest';

import { aborted, host } from './run-fixture.ts';
import { factSpace, run } from '../src/index.ts';
import type { Deferred, ManagedStream } from '../src/index.ts';

type Body = ManagedStream<string, string>;

const none = { needs: [], provides: [], consumes: [] } as const;
const response = { needs: ['response.body'], provides: ['response.body'], consumes: [] } as const;

describe('kernel acceptance', () => {
  it.each([
    ['failover discards the losing candidate and retries its suffix', 400],
    ['Claude Code retries a 401 and discards the first call', 401],
  ])('%s', async (_title, status) => {
    const { defineStage, compose } = factSpace<{
      'request.attempt': number;
      'response.status': number;
      'response.body': Body;
      'response.usage': Deferred<number>;
    }>();
    const trace: string[] = [];
    const retry = defineStage({
      name: 'retry',
      through: {
        request: { ...none, provides: ['request.attempt'] },
        response: { ...none, needs: ['response.status', 'response.body', 'response.usage'] },
      },
      execute: async (facts, scope) => {
        const first = scope.next({ ...facts, 'request.attempt': 1 });
        const losing = await first;
        if (losing['response.status'] !== status || scope.signal.aborted) return losing;
        scope.abort(first);
        scope.discard(losing['response.body']);
        scope.discard(losing['response.usage']);
        return await scope.next({ ...facts, 'request.attempt': 2 });
      },
    });
    const attempt = defineStage({
      name: 'attempt',
      request: { needs: ['request.attempt'] },
      return: { provides: ['response.status', 'response.body', 'response.usage'] },
      execute: async ({ 'request.attempt': number }, scope) => {
        trace.push(`attempt:${number}`);
        return {
          'response.status': number === 1 ? status : 200,
          'response.body': scope.createStream<string, string>(async function* ({ signal }) {
            if (number === 1) {
              await aborted(signal);
              trace.push('losing stream aborted and drained');
              yield { ok: false, error: 'abort' };
              return;
            }
            yield { ok: true, value: 'winner' };
          }),
          'response.usage': scope.createDeferred(async ({ signal }) => {
            if (number === 1) {
              await aborted(signal);
              trace.push('losing deferred aborted and settled');
            }
            return number;
          }),
        };
      },
    });
    const pipeline = compose('retry', {
      entry: [], exit: ['response.status', 'response.body', 'response.usage'], stages: [retry], ending: attempt,
    });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    expect(answer['response.status']).toBe(200);
    expect(await Array.fromAsync(running.read(answer['response.body']))).toEqual([{ ok: true, value: 'winner' }]);
    expect(await running.read(answer['response.usage'])).toBe(2);
    await running.done;
    await recording.rootLeft;
    expect(trace.filter(step => step.startsWith('attempt'))).toEqual(['attempt:1', 'attempt:2']);
    expect(trace).toContain('losing stream aborted and drained');
    expect(trace).toContain('losing deferred aborted and settled');
  });

  it.each([false, true])('collects incrementally (source panics: %s)', async fail => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.count': number }>();
    const release = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const panic = new Error('bad source');
    const collector = defineStage({
      name: 'collect',
      through: {
        request: none,
        response: { ...response, provides: ['response.count'], consumes: ['response.body'] },
      },
      execute: async (facts, scope) => {
        const { 'response.body': body, ...answer } = await scope.next(facts);
        let count = 0;
        for await (const item of scope.read(body)) {
          if (item.ok) count += item.value.length;
          if (!fail) {
            scope.discard(body);
            break;
          }
        }
        return { ...answer, 'response.count': count };
      },
    });
    const source = defineStage({
      name: 'source',
      request: { needs: [] },
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          try {
            yield { ok: true, value: 'first' };
            if (fail) throw panic;
            await release.promise;
            yield { ok: true, value: 'second' };
          } finally {
            drained.resolve();
          }
        }),
      }),
    });
    const pipeline = compose('collect', { entry: [], exit: ['response.count'], stages: [collector], ending: source });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    if (fail) {
      await expect(running.result).rejects.toBe(panic);
      await expect(running.done).rejects.toBe(panic);
      await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, error: panic });
    } else {
      expect(await running.result).toEqual({ 'response.count': 5 });
      await running.done;
      expect(recording.events).not.toContainEqual(expect.objectContaining({ type: 'stage.leaved', stageId: 1 }));
      release.resolve();
      await drained.promise;
      await recording.rootLeft;
    }
  });

  it.each([false, true])('runs hosted tool rounds from a stream producer (round two panics: %s)', async fail => {
    const { defineStage, compose } = factSpace<{ 'request.round': number; 'response.body': Body }>();
    const panic = new Error('second round has a bug');
    const attempts: number[] = [];
    const hosted = defineStage({
      name: 'hosted-tools',
      through: { request: { ...none, provides: ['request.round'] }, response },
      execute: async (facts, scope) => {
        const initial = await scope.next({ ...facts, 'request.round': 1 });
        const body = scope.wrapStream<string, string, string, string>(initial['response.body'], async function* (inner, producer) {
          yield* producer.read(inner);
          if (producer.signal.aborted) return;
          const next = await producer.next({ ...facts, 'request.round': 2 });
          yield* producer.read(next['response.body']);
        });
        return { ...initial, 'response.body': body };
      },
    });
    const attempt = defineStage({
      name: 'round',
      request: { needs: ['request.round'] },
      return: { provides: ['response.body'] },
      execute: async ({ 'request.round': round }, scope) => {
        attempts.push(round);
        if (fail && round === 2) throw panic;
        return {
          'response.body': scope.createStream<string, string>(async function* () {
            yield { ok: true, value: `round ${round}` };
          }),
        };
      },
    });
    const pipeline = compose('hosted-tools', { entry: [], exit: ['response.body'], stages: [hosted], ending: attempt });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    const reader = running.read(answer['response.body']);
    expect(await reader.next()).toEqual({ done: false, value: { ok: true, value: 'round 1' } });
    if (fail) {
      await expect(reader.next()).rejects.toBe(panic);
      await expect(running.done).rejects.toBe(panic);
      expect(recording.events).toContainEqual({ type: 'stream.end', streamId: 2, error: panic });
      expect(recording.events).toContainEqual({ type: 'stage.leaved', stageId: 3, error: panic });
    } else {
      expect(await reader.next()).toEqual({ done: false, value: { ok: true, value: 'round 2' } });
      expect((await reader.next()).done).toBe(true);
      await running.done;
    }
    expect(attempts).toEqual([1, 2]);
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
  });

  it('encodes a guard error, then host abort interrupts the background drain', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body }>();
    const draining = Promise.withResolvers<AbortSignal>();
    const upstreamAborted = Promise.withResolvers<void>();
    const guard = defineStage({
      name: 'guard',
      through: { request: none, response },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        return {
          ...answer,
          'response.body': scope.wrapStream<string, string, string, string>(answer['response.body'], async function* (inner, producer) {
            for await (const item of producer.read(inner)) {
              expect(item.ok).toBe(true);
              producer.discard(inner);
              yield { ok: false, error: 'bad frame' };
              return;
            }
          }),
        };
      },
    });
    const encoder = defineStage({
      name: 'encoder',
      through: { request: none, response },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        return {
          ...answer,
          'response.body': scope.wrapStream<string, string, string, string>(answer['response.body'], async function* (inner, producer) {
            for await (const item of producer.read(inner)) {
              if (item.ok) {
                yield item;
              } else {
                producer.discard(inner);
                yield { ok: true, value: JSON.stringify({ error: item.error }) };
                return;
              }
            }
          }),
        };
      },
    });
    const upstream = defineStage({
      name: 'upstream',
      request: { needs: [] },
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* ({ signal }) {
          yield { ok: true, value: 'invalid data' };
          draining.resolve(signal);
          await aborted(signal);
          upstreamAborted.resolve();
          yield { ok: false, error: 'abort' };
        }),
      }),
    });
    const pipeline = compose('render', { entry: [], exit: ['response.body'], stages: [encoder, guard], ending: upstream });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    expect(await Array.fromAsync(running.read(answer['response.body']))).toEqual([{ ok: true, value: '{"error":"bad frame"}' }]);
    await running.done;
    const upstreamSignal = await draining.promise;
    expect(upstreamSignal.aborted).toBe(false);
    expect(recording.events).not.toContainEqual(expect.objectContaining({ type: 'stage.leaved', stageId: 1 }));
    recording.controller.abort();
    await upstreamAborted.promise;
    await recording.rootLeft;
    expect(upstreamSignal.aborted).toBe(true);
  });

  it('records an absorbed stream panic on the discarded dependency alone', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.count': number }>();
    const release = Promise.withResolvers<void>();
    const panic = new Error('discarded stream panic');
    const drop = defineStage({
      name: 'drop',
      through: { request: none, response: { ...response, consumes: ['response.body'], provides: ['response.count'] } },
      execute: async (facts, scope) => {
        const { 'response.body': body, ...answer } = await scope.next(facts);
        scope.discard(body);
        return { ...answer, 'response.count': 0 };
      },
    });
    const source = defineStage({
      name: 'source',
      request: { needs: [] },
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () {
          await release.promise;
          throw panic;
        }),
      }),
    });
    const pipeline = compose('drop', { entry: [], exit: ['response.count'], stages: [drop], ending: source });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    await running.done;
    release.resolve();
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
    expect(recording.events.filter(event => 'error' in event)).toEqual([{ type: 'stream.end', streamId: 1, error: panic }]);
  });

  it('starts provider persistence immediately with a worker scope outside request cancellation', async () => {
    const completed: string[] = [];
    const release = Promise.withResolvers<void>();
    const { defineStage, compose } = factSpace<{ 'response.ok': true }, { persist: (value: string) => void }>();
    const provider = defineStage({
      name: 'provider',
      request: { needs: [] },
      return: { provides: ['response.ok'] },
      execute: async (_facts, scope) => {
        scope.detach(async worker => {
          expect(Object.keys(worker).sort()).toEqual(['log', 'services']);
          worker.services.persist('started');
          await release.promise;
          worker.services.persist('saved');
        });
        expect(completed).toEqual(['started']);
        return { 'response.ok': true };
      },
    });
    const pipeline = compose('provider', { entry: [], exit: ['response.ok'], stages: [], ending: provider });
    const recording = host({ persist: value => { completed.push(value); } } satisfies { persist: (value: string) => void });
    const running = run(pipeline, {}, recording.options);
    await running.done;
    expect(recording.workers).toHaveLength(1);
    recording.controller.abort();
    expect(completed).toEqual(['started']);
    release.resolve();
    await Promise.all(recording.workers);
    expect(completed).toEqual(['started', 'saved']);
  });

  it('hands unopened stream and deferred handles to wrapper producers at creation', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.usage': Deferred<number> }>();
    const factories: string[] = [];
    const wrap = defineStage({
      name: 'wrap',
      through: { request: none, response: { ...response, needs: ['response.body', 'response.usage'], provides: ['response.body', 'response.usage'] } },
      execute: async (facts, scope) => {
        const answer = await scope.next(facts);
        const original = answer['response.body'];
        const body = scope.wrapStream<string, string, string, string>(original, (inner, producer) => {
          expect(inner).toBe(original);
          factories.push('stream');
          expect(() => scope.read(inner)).toThrow('another executor');
          return (async function* () {
            for await (const item of producer.read(inner)) {
              yield item.ok ? { ok: true, value: item.value.toUpperCase() } : item;
            }
          })();
        });
        const usage = scope.wrapDeferred(answer['response.usage'], async (inner, producer) => {
          factories.push('deferred');
          return (await producer.read(inner)) + 1;
        });
        expect(factories).toEqual(['stream', 'deferred']);
        return { ...answer, 'response.body': body, 'response.usage': usage };
      },
    });
    const source = defineStage({
      name: 'source',
      request: { needs: [] },
      return: { provides: ['response.body', 'response.usage'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* () { yield { ok: true, value: 'body' }; }),
        'response.usage': scope.createDeferred(async () => 1),
      }),
    });
    const pipeline = compose('wrap', { entry: [], exit: ['response.body', 'response.usage'], stages: [wrap], ending: source });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    expect(await Array.fromAsync(running.read(answer['response.body']))).toEqual([{ ok: true, value: 'BODY' }]);
    expect(await running.read(answer['response.usage'])).toBe(2);
    await running.done;
    expect(factories).toEqual(['stream', 'deferred']);
  });

  it('propagates the execute exception while draining an orphaned wrapper and a whole late answer', async () => {
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.usage': Deferred<number> }>();
    const release = Promise.withResolvers<void>();
    const panic = new Error('execute failed');
    const trace: string[] = [];
    const throwing = defineStage({
      name: 'throwing',
      through: { request: none, response: { ...none, needs: ['response.body', 'response.usage'] } },
      execute: async (facts, scope) => {
        const original = scope.createStream<string, string>(async function* () { trace.push('original'); });
        scope.wrapStream(original, async function* (inner, producer) {
          yield* producer.read(inner);
          trace.push('wrapper');
        });
        scope.createDeferred(async () => { trace.push('execute deferred'); return 0; });
        void scope.next(facts);
        throw panic;
      },
    });
    const late = defineStage({
      name: 'late',
      request: { needs: [] },
      return: { provides: ['response.body', 'response.usage'] },
      execute: async (_facts, scope) => {
        await release.promise;
        return {
          'response.body': scope.createStream<string, string>(async function* () { trace.push('late stream'); }),
          'response.usage': scope.createDeferred(async () => { trace.push('late deferred'); return 1; }),
        };
      },
    });
    const pipeline = compose('orphan', { entry: [], exit: ['response.body', 'response.usage'], stages: [throwing], ending: late });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).rejects.toBe(panic);
    await expect(running.done).rejects.toBe(panic);
    expect(trace).not.toContain('late stream');
    release.resolve();
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, error: panic });
    expect(trace.sort()).toEqual(['execute deferred', 'late deferred', 'late stream', 'original', 'wrapper']);
    expect(recording.events.filter(event => event.type === 'deferred.settled')).toHaveLength(2);
  });
});
