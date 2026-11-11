import { expect, test } from 'vitest';

import type { IRRecord } from '../../../src/ir/output/records.ts';
import { createIRUnitRegistry } from '../../../src/ir/output/unit-registry.ts';

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
