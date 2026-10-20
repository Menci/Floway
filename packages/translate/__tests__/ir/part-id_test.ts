import { expect, test } from 'vitest';

import { createIRBuilder } from '../../src/ir/stream.ts';

test('carries optional source part IDs on append operations', () => {
  const builder = createIRBuilder();
  const item = builder.item(0, { type: 'message', content: [] });
  const part = item.part({ type: 'text', text: '' });
  builder.drain();

  part.append('text', 'first', [7]);
  part.append('text', 'second');

  expect(builder.drain()).toEqual([
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'first', referencePieceIds: [7] },
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'second' },
  ]);
});

test('retains every original ID when a native buffer is merged into one IR append', () => {
  const builder = createIRBuilder();
  const part = builder.item(0, { type: 'message', content: [] }).part({ type: 'text', text: '' });
  builder.drain();
  const ids = [7, 9];
  part.append('text', 'merged', ids);
  ids.length = 0;
  expect(builder.drain()).toEqual([
    { type: 'write', kind: 'append', path: ['choices', 0, 'items', 0, 'content', 0, 'text'], value: 'merged', referencePieceIds: [7, 9] },
  ]);
});
