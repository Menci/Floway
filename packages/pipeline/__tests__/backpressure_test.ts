import { expect, test } from 'vitest';

import { compose, defer, defineStage, getFailureFacts, move, run } from '../src/index.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

test('stage execution waits for its entry to reach the asynchronous recording sink', async () => {
  const received = gate();
  const stored = gate();
  let executed = false;
  const answer = defineStage<Record<string, never>, Record<string, never>>({
    name: 'answer', return: { provides: [] }, execute: async facts => { executed = true; return facts; },
  });
  const running = run(compose('backpressure', [answer]), move({}), {
    dump: async event => {
      if (event.type === 'stage.entered') { received.release(); await stored.promise; }
    },
  });
  await received.promise;
  expect(executed).toBe(false);
  stored.release();
  await running;
  expect(executed).toBe(true);
});

test('an awaited scoped log blocks on recording while accepting a synchronous global logger', async () => {
  const received = gate();
  const stored = gate();
  let finished = false;
  let globalWritten = false;
  const answer = defineStage<Record<string, never>, Record<string, never>>({
    name: 'logging', return: { provides: [] }, execute: async (facts, use) => {
      await use.log.info('line');
      finished = true;
      return facts;
    },
  });
  const running = run(compose('logging', [answer]), move({}), {
    log: { debug: () => {}, info: () => { globalWritten = true; }, warn: () => {}, error: () => {} },
    dump: async event => { if (event.type === 'stage.log') { received.release(); await stored.promise; } },
  });
  await received.promise;
  expect(globalWritten).toBe(true);
  expect(finished).toBe(false);
  stored.release();
  await running;
  expect(finished).toBe(true);
});

test('drain waits for deferred settlement to be durably recorded', async () => {
  const received = gate();
  const stored = gate();
  const answer = defineStage<Record<string, never>, { pending: Promise<number> }>({
    name: 'deferred', return: { provides: ['pending'] }, execute: async () => move({ pending: defer(Promise.resolve(42)) }),
  });
  const result = await run(compose('deferred', [answer]), move({}), {
    dump: async event => { if (event.type === 'deferred.settled') { received.release(); await stored.promise; } },
  });
  let drained = false;
  const draining = result.drain().then(() => { drained = true; });
  await received.promise;
  expect(drained).toBe(false);
  stored.release();
  await draining;
  expect(drained).toBe(true);
});

test('recording rejection exposes its original error and accepted failure facts', async () => {
  const error = new Error('storage failed');
  const answer = defineStage<{ context: string }, { context: string }>({
    name: 'logging', return: { provides: ['context'] }, execute: async (facts, use) => { await use.log.info('line'); return facts; },
  });
  const facts = move({ context: 'request' });
  await expect(run(compose('logging', [answer]), facts, {
    dump: async event => { if (event.type === 'stage.log') throw error; },
  })).rejects.toBe(error);
  expect(getFailureFacts(error)).toBe(facts);
});

test('deferred and recording failures retain both exceptions and their fact snapshot', async () => {
  const sourceError = new Error('deferred failed');
  const storageError = new Error('storage failed');
  const answer = defineStage<Record<string, never>, { pending: Promise<never> }>({
    name: 'deferred', return: { provides: ['pending'] }, execute: async () => move({ pending: defer(Promise.reject(sourceError)) }),
  });
  const result = await run(compose('deferred', [answer]), move({}), {
    dump: async event => { if (event.type === 'deferred.settled') throw storageError; },
  });
  const caught: unknown = await result.drain().catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([sourceError, storageError]);
  expect((caught as AggregateError).cause).toBe(sourceError);
  expect(getFailureFacts(caught)).toBe(result.facts);
});
