import { expect, test } from 'vitest';

import { createIRUnitQueue } from '../../../src/ir/output/unit-queue.ts';

interface Unit { readonly name: string }

test('unit queue dequeues units in the order they were enqueued', () => {
  const queue = createIRUnitQueue<Unit>();
  const [a, b] = [{ name: 'a' }, { name: 'b' }];
  queue.enqueue(a);
  queue.enqueue(b);
  expect(queue.head).toBe(a);
  queue.dropHead();
  expect(queue.head).toBe(b);
  queue.dropHead();
  expect(queue.head).toBeUndefined();
  const c = { name: 'c' };
  queue.enqueue(c);
  expect(queue.head).toBe(c);
});

test('unit queue owns its links without changing payloads or coupling independent queues', () => {
  const unit = Object.freeze({ name: 'shared' });
  const first = createIRUnitQueue<typeof unit>();
  const second = createIRUnitQueue<typeof unit>();
  first.enqueue(unit);
  first.enqueue(unit);
  second.enqueue(unit);
  first.dropHead();
  expect(first.head).toBe(unit);
  expect(second.head).toBe(unit);
  first.dropHead();
  expect(first.head).toBeUndefined();
  expect(second.head).toBe(unit);
  expect(Object.keys(unit)).toEqual(['name']);
});
