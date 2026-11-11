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
