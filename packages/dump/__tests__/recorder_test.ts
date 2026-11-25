import { expect, test, vi } from 'vitest';

import { createDumpRecorder, decodeDump } from '../src/index.ts';
import { factSpace, run, type ManagedStream } from '@floway-dev/pipeline';

const none = { needs: [], provides: [], consumes: [] } as const;

test('waits for root exit and detached settlement during a discarded stream drain', async () => {
  type Body = ManagedStream<string, string>;
  const { defineStage, compose } = factSpace<{ body: Body; status: number }>();
  const drain = Promise.withResolvers<void>();
  const worker = Promise.withResolvers<void>();
  const workerStarted = Promise.withResolvers<void>();
  const forwarded: Promise<unknown>[] = [];
  const recorder = createDumpRecorder(work => { forwarded.push(work); });
  const panic = new Error('discarded stream panic');
  const workerFailure = new Error('late worker failure');
  let originalWork: Promise<unknown> | undefined;
  const root = defineStage({
    name: 'root',
    through: {
      request: none,
      response: { needs: ['body'], provides: ['status'], consumes: ['body'] },
    },
    execute: async (facts, scope) => {
      const { body } = await scope.next(facts);
      scope.discard(body);
      return { status: 200 };
    },
  });
  const ending = defineStage({
    name: 'create',
    request: none,
    return: { provides: ['body'] },
    execute: async (_facts, scope) => ({
      body: scope.createStream<string, string>(async function* (producer) {
        await drain.promise;
        producer.detach(detachedScope => {
          originalWork = (async () => {
            await worker.promise;
            detachedScope.log.withField('phase', 'worker').log('worker finished');
            throw workerFailure;
          })();
          return originalWork;
        });
        workerStarted.resolve();
        throw panic;
      }),
    }),
  });
  const pipeline = compose('recorded', { entry: [], exit: ['status'], stages: [root], ending });
  const running = run(pipeline, {}, { services: {}, signal: new AbortController().signal, events: recorder.events, waitUntil: recorder.waitUntil });
  const archive = decodeDump(recorder.body);
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  let closed = false;
  const finished = recorder.finish(running.done).then(() => { closed = true; });
  try {
    await running.done;
    expect(forwarded).toEqual([]);
    expect(closed).toBe(false);
    drain.resolve();
    await workerStarted.promise;
    expect(forwarded).toEqual([originalWork]);
    expect(forwarded[0]).toBe(originalWork);
    expect(closed).toBe(false);
    worker.resolve();
    await expect(forwarded[0]).rejects.toBe(workerFailure);
    await finished;
    const recorded = await archive;
    expect(recorded.stages.get(recorded.rootStageId)?.outcome).toEqual({ facts: { status: 200 } });
    expect(recorded.streams.get(1)?.outcome).toMatchObject({ error: { message: panic.message, stack: panic.stack } });
    expect(recorded.stages.get(2)?.logs).toMatchObject([{ message: 'worker finished', stageId: 2, fields: { phase: 'worker' } }]);
  } finally {
    consoleLog.mockRestore();
  }
});

test('archives a root panic even when run.done rejects', async () => {
  const { defineStage, compose } = factSpace<{}>();
  const ending = defineStage({
    name: 'root',
    request: none,
    return: { provides: [] },
    execute: async () => { throw undefined; },
  });
  const recorder = createDumpRecorder(() => undefined);
  const running = run(compose('panicked', { entry: [], exit: [], stages: [], ending }), {}, {
    services: {}, signal: new AbortController().signal, events: recorder.events, waitUntil: recorder.waitUntil,
  });
  await expect(running.done).rejects.toBeUndefined();
  await recorder.finish(running.done);
  const archive = await decodeDump(recorder.body);
  expect(archive.stages.get(archive.rootStageId)?.outcome).toStrictEqual({ error: undefined });
});

test('surfaces an encoding failure to the observer, recorder and archive reader', async () => {
  const recorder = createDumpRecorder(() => undefined);
  let observerFailure: unknown;
  const unsupported = { type: 'stage.entered', stageId: 1, name: 'root', facts: { invalid: Symbol('unsupported') } } as const;
  expect(() => {
    try {
      recorder.events(unsupported, () => undefined);
    } catch (error) {
      observerFailure = error;
      throw error;
    }
  }).toThrow('Unsupported dump value symbol');
  await expect(recorder.finish(new Promise(() => undefined))).rejects.toBe(observerFailure);
  await expect(decodeDump(recorder.body)).rejects.toBe(observerFailure);
});
