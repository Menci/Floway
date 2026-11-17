import { expect, test } from 'vitest';

import { createIRBuilder } from '../../../src/ir/output/builder.ts';

test('retains every original ID when a native buffer is merged into one output IR append', () => {
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
