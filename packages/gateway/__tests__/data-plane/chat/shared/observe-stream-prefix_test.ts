import { expect, test, vi } from 'vitest';

import { observeStreamPrefix } from '../../../../src/data-plane/chat/shared/observe-stream-prefix.ts';

test('observes ahead of a blocked sink, then restores pull-driven reads', async () => {
  let reads = 0;
  const source = (async function* () {
    for (let i = 0; i < 4; i++) { reads++; yield { i }; }
  })();
  const observe = vi.fn(({ i }: { i: number }) => i === 1);
  const limit = vi.fn();
  const events = observeStreamPrefix(source, observe, limit, vi.fn(), vi.fn());
  await vi.waitFor(() => { expect(observe).toHaveBeenCalledTimes(2); });
  expect(reads).toBe(2);
  expect(await events.next()).toEqual({ done: false, value: { i: 0 } });
  expect(await events.next()).toEqual({ done: false, value: { i: 1 } });
  expect(reads).toBe(2);
  expect(await events.next()).toEqual({ done: false, value: { i: 2 } });
  expect(reads).toBe(3);
  await events.return?.();
  expect(limit).not.toHaveBeenCalled();
});

test.each(['count', 'payload'])('bounds the independently retained prefix by %s', async bound => {
  const observe = vi.fn(() => false);
  const limit = vi.fn();
  const source = (async function* () {
    for (let i = 0; i < 300; i++) yield { i, payload: bound === 'payload' ? 'a'.repeat(512 * 1024) : '' };
  })();
  const events = observeStreamPrefix(source, observe, limit, vi.fn(), vi.fn());
  await vi.waitFor(() => { expect(limit).toHaveBeenCalledOnce(); });
  expect(observe).toHaveBeenCalledTimes(bound === 'count' ? 256 : 1);
  const values = [];
  for await (const value of events) values.push(value.i);
  expect(values).toEqual(Array.from({ length: 300 }, (_, i) => i));
  expect(limit).toHaveBeenCalledOnce();
});

test('replays retained frames before propagating the original upstream error', async () => {
  const error = new Error('upstream failed');
  const finish = vi.fn();
  const source = (async function* () { yield { i: 0 }; throw error; })();
  const events = observeStreamPrefix(source, () => false, vi.fn(), finish, vi.fn());
  await vi.waitFor(() => { expect(finish).toHaveBeenCalledOnce(); });
  expect(await events.next()).toEqual({ done: false, value: { i: 0 } });
  await expect(events.next()).rejects.toBe(error);
});

test('closes its source when returned before downstream iteration begins', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const cleanup = vi.fn();
  const source = (async function* () {
    try { await ready; yield { i: 0 }; } finally { cleanup(); }
  })();
  const observe = vi.fn(() => false);
  const finish = vi.fn();
  const events = observeStreamPrefix(source, observe, vi.fn(), finish, release);
  const closing = events.return?.();
  await closing;
  expect(cleanup).toHaveBeenCalledOnce();
  expect(observe).not.toHaveBeenCalled();
  expect(finish).toHaveBeenCalledOnce();
  expect(await events.next()).toEqual({ done: true, value: undefined });
});

test.each([true, false])('closes the source and preserves an observer failure (during prefix: %s)', async duringPrefix => {
  const error = new Error('observer failed');
  const cleanup = vi.fn();
  const source = (async function* () {
    try { yield { i: 0 }; yield { i: 1 }; } finally { cleanup(); }
  })();
  const events = observeStreamPrefix(source, ({ i }) => {
    if (duringPrefix || i === 1) throw error;
    return true;
  }, vi.fn(), vi.fn(), vi.fn());
  if (!duringPrefix) expect(await events.next()).toEqual({ done: false, value: { i: 0 } });
  await expect(events.next()).rejects.toBe(error);
  expect(cleanup).toHaveBeenCalledOnce();
});

test('serializes concurrent downstream next requests without dropping a waiter', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const source = (async function* () { await ready; yield { i: 0 }; yield { i: 1 }; })();
  const events = observeStreamPrefix(source, () => true, vi.fn(), vi.fn(), release);
  const first = events.next();
  const second = events.next();
  release();
  expect(await Promise.all([first, second])).toEqual([
    { done: false, value: { i: 0 } }, { done: false, value: { i: 1 } },
  ]);
  await events.return?.();
});
