import { describe, expect, test } from 'vitest';

import { irRecordOwnerPaths, resolveIRPath } from '../../../src/ir/output/operation-paths.ts';

const root = {
  choices: [{
    items: [
      { type: 'message', content: [{ type: 'text', text: '' }, { type: 'audio', audio: {} }] },
      { type: 'reasoning', summary: [''], content: [''] },
      { type: 'function_call', name: 'f', arguments: '' },
      { type: 'custom_tool_call', name: 'c', input: '' },
    ],
  }],
};
const item = (index: number, ...rest: (string | number)[]) => ['choices', 0, 'items', index, ...rest];

describe('output IR schema queries', () => {
  test.each([
    [item(0, 'content', 0, 'text'), true],
    [item(0, 'content', 1, 'audio', 'media_type'), false],
    [item(3, 'input'), true],
    [item(2, 'input'), false],
  ])('append target at %j is %s', (path, expected) => {
    const node = resolveIRPath(path, root)?.node;
    expect(node?.kind === 'string' && node.append === true).toBe(expected);
  });

  test('a record belongs to its units, innermost first', () => {
    expect(irRecordOwnerPaths({ type: 'write', kind: 'append', path: item(0, 'content', 0, 'text'), value: 'x' }, root))
      .toEqual([item(0, 'content', 0), item(0), ['choices', 0]]);
    expect(irRecordOwnerPaths({ type: 'item_end', choice: 0, item: 1 }, root)).toEqual([item(1)]);
    expect(irRecordOwnerPaths({ type: 'ping' }, root)).toEqual([]);
  });
});
