import { expect, test } from 'vitest';

import { compose, createRunReader, defineStage, encodeRun, getFailureFacts, move, own, run } from '../src/index.ts';
import type { Event } from '../src/index.ts';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { release, promise };
};

test('failed parents remain distinguishable from folded successful returns after a child answers', async () => {
  const error = new Error('parent failed');
  const events: Event[] = [];
  const child = defineStage<Record<string, never>, { answer: string }>({
    name: 'child', return: { provides: ['answer'] }, execute: async () => move({ answer: 'upstream' }),
  });
  const parent = defineStage<Record<string, never>, Record<string, never>, { answer: string }, { answer: string }>({
    name: 'parent',
    through: { request: { needs: [], consumes: [], provides: [] }, response: { needs: ['answer'], consumes: [], provides: [] } },
    execute: async (facts, next) => { await next(facts); throw error; },
  });
  await expect(run(compose('failure', [parent, child]), move({}), { dump: event => { events.push(event); } })).rejects.toBe(error);
  expect(events.filter(event => event.type === 'stage.leaved').map(event => event.stageId)).toEqual([2]);
  expect(events.find(event => event.type === 'stage.failed')).toMatchObject({ stageId: 1, error });
  const encoded = encodeRun(events);
  const marker = encoded.find(event => event.type === 'stage.failed')!;
  const read = createRunReader();
  for (const event of encoded) read(event);
  expect(read(marker)?.error).toMatchObject({ error: { name: 'Error', message: 'parent failed' } });
  expect(getFailureFacts(error)).toEqual({ answer: 'upstream' });
});

test('concurrent runs retain distinct contexts when a shared rejection reaches the second run during first-run cleanup', async () => {
  const shared = new Error('shared token refresh failed');
  shared.name = 'AbortError';
  const cleanupStarted = gate();
  const cleanupAllowed = gate();
  const resource = move(own({}, async () => { cleanupStarted.release(); await cleanupAllowed.promise; }));
  const events: Event[] = [];
  const fail = defineStage<{ candidate: string }, Record<string, never>>({
    name: 'fail', return: { provides: [] }, execute: async () => { throw shared; },
  });
  const pipeline = compose('sharedFailure', [fail]);
  const firstFacts = move({ candidate: 'first', resource });
  const first = run(pipeline, firstFacts, {}).catch((error: unknown) => error);
  await cleanupStarted.promise;
  const secondFacts = move({ candidate: 'second' });
  const second: unknown = await run(pipeline, secondFacts, { dump: event => { events.push(event); } }).catch((error: unknown) => error);
  expect(second).toBeInstanceOf(Error);
  expect(second).not.toBe(shared);
  expect((second as Error).cause).toBe(shared);
  expect((second as Error).name).toBe('AbortError');
  expect((second as Error).message).toBe(shared.message);
  expect(getFailureFacts(second)).toBe(secondFacts);
  expect(events.find(event => event.type === 'stage.failed')).toMatchObject({ error: shared });
  cleanupAllowed.release();
  const caughtFirst = await first;
  expect(caughtFirst).toBe(shared);
  expect(getFailureFacts(caughtFirst)).toBe(firstFacts);
  expect(getFailureFacts(second)).toBe(secondFacts);
});

test('a failed-stage recording rejection preserves the primary exception and its facts', async () => {
  const primary = new Error('stage failed');
  const recording = new Error('storage failed');
  const fail = defineStage<{ candidate: string }, Record<string, never>>({
    name: 'fail', return: { provides: [] }, execute: async () => { throw primary; },
  });
  const facts = move({ candidate: 'actual' });
  const caught: unknown = await run(compose('failure', [fail]), facts, {
    dump: async event => { if (event.type === 'stage.failed') throw recording; },
  }).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([primary, recording]);
  expect((caught as AggregateError).cause).toBe(primary);
  expect(getFailureFacts(caught)).toBe(facts);
});
