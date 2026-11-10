import { expect, test } from 'vitest';

import { createIRBuilder } from '../../src/ir/stream.ts';

test('write handles build unit paths and ensure fields once', () => {
  const builder = createIRBuilder();
  const choice = builder.choice(0);
  const item = builder.item(0, { type: 'reasoning' });

  item.ensure('summary', []);
  item.ensure('summary', []);
  item.initialize(['summary', 0], '');
  item.append(['summary', 0], 'reason');
  choice.ensure('logprobs', []);

  expect(choice.path).toEqual(['choices', 0]);
  expect(item.path).toEqual(['choices', 0, 'items', 0]);
  expect(item.resolve(['summary', 0])).toEqual(['choices', 0, 'items', 0, 'summary', 0]);
  expect(builder.drain()).toEqual([
    { type: 'write', kind: 'initialize', path: ['choices', 0], value: { items: [] } },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0], value: { type: 'reasoning' } },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'summary'], value: [] },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'items', 0, 'summary', 0], value: '' },
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'summary', 0], value: 'reason' },
    { type: 'write', kind: 'initialize', path: ['choices', 0, 'logprobs'], value: [] },
  ]);
});

test('ending an item closes only its open parts and is idempotent', () => {
  const builder = createIRBuilder();
  const item = builder.item(0, { type: 'message', content: [] });
  const text = item.part({ type: 'text', text: '' });
  const refusal = item.part({ type: 'refusal', refusal: '' });

  text.end();
  text.end();
  item.end('incomplete');
  item.end();

  expect(item.isOpen).toBe(false);
  expect(text.isOpen).toBe(false);
  expect(refusal.isOpen).toBe(false);
  expect(builder.drain().slice(-3)).toEqual([
    { type: 'part_end', choice: 0, item: 0, part: 0 },
    { type: 'part_end', choice: 0, item: 0, part: 1 },
    { type: 'item_end', choice: 0, item: 0, status: 'incomplete' },
  ]);
});

test('handles expose accumulated values needed for snapshot reconciliation and annotation coordinates', () => {
  const builder = createIRBuilder();
  const choice = builder.choice(0);
  const first = builder.item(0, { type: 'message', content: [] });
  const firstText = first.part({ type: 'text', text: '' });
  firstText.append('text', 'first');
  const second = builder.item(0, { type: 'message', content: [] });
  const secondText = second.part({ type: 'text', text: '' });
  secondText.append('text', 'second');

  expect(firstText.current('text')).toBe('first');
  expect(choice.textParts()).toEqual([
    { item: first, part: firstText, text: 'first' },
    { item: second, part: secondText, text: 'second' },
  ]);
});
