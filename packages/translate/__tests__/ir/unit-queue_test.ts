import { expect, test } from 'vitest';

import type { IRRecord } from '../../src/ir/stream.ts';
import { createIRUnitQueue, createIRUnitRegistry, type IRQueuedUnit } from '../../src/ir/unit-queue.ts';

interface Unit extends IRQueuedUnit<Unit> { readonly name: string }

test('unit queue dequeues units in the order they were enqueued', () => {
  const queue = createIRUnitQueue<Unit>();
  const [a, b] = [{ name: 'a' }, { name: 'b' }];
  queue.enqueue(a);
  queue.enqueue(b);
  expect(queue.head).toBe(a);
  queue.dequeue();
  expect(queue.head).toBe(b);
  queue.dequeue();
  expect(queue.head).toBeUndefined();
  const c = { name: 'c' };
  queue.enqueue(c);
  expect(queue.head).toBe(c);
});

test('unit registry finds the innermost registered owner of a record', () => {
  const registry = createIRUnitRegistry<string>();
  const root = { choices: [{ items: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'refusal', refusal: '' }, { type: 'refusal', refusal: '' }, { type: 'text', text: 'x' }] }] }] };
  const item = ['choices', 0, 'items', 1] as const;
  const part = [...item, 'content', 2] as const;
  registry.set(item, 'item');
  const append: IRRecord = { type: 'write', kind: 'append', path: [...part, 'text'], value: 'x' };
  expect(registry.forRecord(append, root)).toBe('item');
  registry.set(part, 'part');
  expect(registry.forRecord(append, root)).toBe('part');
  expect(registry.forRecord({ type: 'part_end', choice: 0, item: 1, part: 2 }, root)).toBe('part');
  registry.delete(part);
  expect(registry.has(part)).toBe(false);
  expect(registry.forRecord(append, root)).toBe('item');
  expect(registry.forRecord({ type: 'ping' }, root)).toBeUndefined();
});
