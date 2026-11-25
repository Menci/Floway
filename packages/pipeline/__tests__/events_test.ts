import { getGlobalHookPostLog, setGlobalHookPostLog } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

import { host } from './run-fixture.ts';
import { factSpace, run } from '../src/index.ts';
import type { Deferred, ManagedStream } from '../src/index.ts';

type Body = ManagedStream<string, string>;
const none = { needs: [], provides: [], consumes: [] } as const;

describe('recording', () => {
  it.each(['stage.entered', 'stream.frame', 'stream.end', 'deferred.settled', 'stage.leaved'] as const)(
    'reports an uncaught observer error without changing the outcome of %s',
    async eventType => {
      const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.usage': Deferred<number> }>();
      const panic = new Error(`observer of ${eventType}`);
      const reported = Promise.withResolvers<unknown>();
      const enqueue = globalThis.queueMicrotask;
      const schedule = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(callback => {
        enqueue(() => {
          try {
            callback();
          } catch (error) {
            if (error !== panic) throw error;
            reported.resolve(error);
          }
        });
      });
      try {
        const ending = defineStage({
          name: 'source',
          request: none,
          return: { provides: ['response.body', 'response.usage'] },
          execute: async (_facts, scope) => ({
            'response.body': scope.createStream<string, string>(async function* () {
              yield { ok: true, value: 'content' };
            }),
            'response.usage': scope.createDeferred(async () => 1),
          }),
        });
        const pipeline = compose('observer', { entry: [], exit: ['response.body', 'response.usage'], stages: [], ending });
        const recording = host({}, event => {
          if (event.type === eventType) throw panic;
        });
        const running = run(pipeline, {}, recording.options);
        const answer = await running.result;
        await expect(Array.fromAsync(running.read(answer['response.body']))).resolves.toEqual([{ ok: true, value: 'content' }]);
        await expect(running.read(answer['response.usage'])).resolves.toBe(1);
        await expect(running.done).resolves.toBeUndefined();
        await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
        await expect(reported.promise).resolves.toBe(panic);
        expect(recording.events.filter(event => 'error' in event)).toEqual([]);
      } finally {
        schedule.mockRestore();
      }
    },
  );

  it('uses separate run-local namespaces and resolves nested opaque handles after settlement', async () => {
    const { defineStage, compose } = factSpace<{
      'response.nested': { source: [Body, Deferred<number>] };
    }>();
    const seen: unknown[] = [];
    const ending = defineStage({
      name: 'nested',
      request: none,
      return: { provides: ['response.nested'] },
      execute: async (_facts, scope) => ({
        'response.nested': {
          source: [scope.createStream<string, string>(async function* () {
            yield { ok: true, value: 'content' };
          }), scope.createDeferred(async () => 1)],
        },
      }),
    });
    const pipeline = compose('nested', { entry: [], exit: ['response.nested'], stages: [], ending });
    const first = host({});
    const one = run(pipeline, {}, first.options);
    const foreign = (await one.result)['response.nested'].source;
    const second = host({}, (event, idOf) => {
      if (event.type !== 'stage.leaved' || !('facts' in event)) return;
      const { source } = event.facts['response.nested'] as { source: unknown[] };
      seen.push(...source.map(idOf), ...foreign.map(idOf), idOf({}), idOf(undefined));
    });
    const two = run(pipeline, {}, second.options);
    const result = await two.result;
    const [stream, deferred] = result['response.nested'].source;
    expect(Reflect.ownKeys(stream)).toEqual([]);
    expect(Reflect.ownKeys(deferred)).toEqual([]);
    expect(() => one.read(stream)).toThrow('another executor');
    expect(() => two.read(foreign[1])).toThrow('another executor');
    await expect(Array.fromAsync(two.read(stream))).resolves.toEqual([{ ok: true, value: 'content' }]);
    await expect(two.read(deferred)).resolves.toBe(1);
    await two.done;
    await second.rootLeft;
    expect(seen).toEqual([{ streamId: 1 }, { deferredId: 1 }, undefined, undefined, undefined, undefined]);
    expect(second.events).toContainEqual({ type: 'stage.entered', stageId: 1, name: 'nested', facts: {} });
    expect(second.events).toContainEqual({ type: 'stream.frame', streamId: 1, item: { ok: true, value: 'content' } });
    expect(second.events).toContainEqual({ type: 'stream.end', streamId: 1 });
    expect(second.events).toContainEqual({ type: 'deferred.settled', deferredId: 1, value: 1 });
    one.discard(foreign[0]);
    one.discard(foreign[1]);
    await one.done;
    await first.rootLeft;
  });

  it('attributes structured global and dump logs to an entered stage, including work from a late drain', async () => {
    type Services = { persistence: { saved: string[] } };
    const { defineStage, compose } = factSpace<{ 'response.body': Body; 'response.status': number }, Services>();
    const drainGate = Promise.withResolvers<void>();
    const workerGate = Promise.withResolvers<void>();
    const persistence = { saved: [] as string[] };
    const services = { persistence };
    const drop = defineStage({
      name: 'drop',
      through: {
        request: none,
        response: { needs: ['response.body'], provides: ['response.status'], consumes: ['response.body'] },
      },
      execute: async (facts, scope) => {
        scope.log.withField('phase', 'execute').log('decided');
        const { 'response.body': body, ...answer } = await scope.next(facts);
        scope.discard(body);
        return { ...answer, 'response.status': 200 };
      },
    });
    const source = defineStage({
      name: 'source',
      request: none,
      return: { provides: ['response.body'] },
      execute: async (_facts, scope) => ({
        'response.body': scope.createStream<string, string>(async function* (producer) {
          await drainGate.promise;
          producer.detach(async worker => {
            expect(worker.services.persistence).toBe(persistence);
            await workerGate.promise;
            worker.services.persistence.saved.push('saved');
            worker.log.withField('phase', 'worker').log('persisted');
          });
        }),
      }),
    });
    const pipeline = compose('log', { entry: [], exit: ['response.status'], stages: [drop], ending: source });
    const previous = getGlobalHookPostLog();
    const global = vi.fn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    setGlobalHookPostLog(global);
    try {
      const recording = host(services);
      const running = run(pipeline, {}, recording.options);
      services.persistence = { saved: [] };
      await running.done;
      expect(recording.workers).toHaveLength(0);
      expect(recording.events).not.toContainEqual(expect.objectContaining({ type: 'stage.leaved', stageId: 1 }));
      drainGate.resolve();
      await recording.rootLeft;
      expect(recording.workers).toHaveLength(1);
      expect(persistence.saved).toEqual([]);
      workerGate.resolve();
      await Promise.all(recording.workers);
      expect(persistence.saved).toEqual(['saved']);
      expect(recording.events.filter(event => event.type === 'log')).toEqual([
        expect.objectContaining({ stageId: 1, message: 'decided', fields: expect.objectContaining({ phase: 'execute' }) }),
        expect.objectContaining({ stageId: 2, message: 'persisted', fields: expect.objectContaining({ phase: 'worker' }) }),
      ]);
      for (const stageId of [1, 2]) {
        const entered = recording.events.findIndex(event => event.type === 'stage.entered' && event.stageId === stageId);
        const logged = recording.events.findIndex(event => event.type === 'log' && event.stageId === stageId);
        expect(entered).toBeGreaterThanOrEqual(0);
        expect(logged).toBeGreaterThan(entered);
      }
      expect(global).toHaveBeenCalledTimes(2);
      expect(global.mock.calls.map(([entry]) => entry.message)).toEqual(['decided', 'persisted']);
      expect(consoleLog).toHaveBeenCalledTimes(2);
    } finally {
      setGlobalHookPostLog(previous);
      consoleLog.mockRestore();
    }
  });

  it('records an ignored child stage panic without adding it to the root outcome', async () => {
    const { defineStage, compose } = factSpace<{ 'response.status': number }>();
    const gate = Promise.withResolvers<void>();
    const failing = defineStage({
      name: 'child',
      request: none,
      return: { provides: [] },
      execute: async () => {
        await gate.promise;
        throw undefined;
      },
    });
    const child = compose('child', { entry: [], exit: [], stages: [], ending: failing });
    const ending = defineStage({
      name: 'root',
      request: none,
      return: { provides: ['response.status'] },
      execute: async (_facts, scope) => {
        void scope.run(child, {});
        return { 'response.status': 200 };
      },
    });
    const pipeline = compose('root', { entry: [], exit: ['response.status'], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    const answer = await running.result;
    await running.done;
    gate.resolve();
    await expect(recording.rootLeft).resolves.toEqual({ type: 'stage.leaved', stageId: 1, facts: answer });
    const childEvents = recording.events.filter(event => event.type === 'stage.leaved' && event.stageId === 2);
    expect(childEvents).toHaveLength(1);
    expect(Object.hasOwn(childEvents[0], 'error')).toBe(true);
    expect(childEvents[0]).toEqual({ type: 'stage.leaved', stageId: 2, error: undefined });
  });

  it('rethrows synchronous detach callback exceptions without submitting work', async () => {
    const panic = new Error('synchronous worker exception');
    const { defineStage, compose } = factSpace<{}>();
    const ending = defineStage({
      name: 'detach-failure',
      request: none,
      return: { provides: [] },
      execute: async (_facts, scope) => {
        scope.detach(() => { throw panic; });
        return {};
      },
    });
    const pipeline = compose('detach-failure', { entry: [], exit: [], stages: [], ending });
    const recording = host({});
    const running = run(pipeline, {}, recording.options);
    await expect(running.result).rejects.toBe(panic);
    expect(recording.workers).toHaveLength(0);
  });
});
