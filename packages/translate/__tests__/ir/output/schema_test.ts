import { describe, expect, test } from 'vitest';

import { irEndedUnit, irItemPath, irPartPath, irRecordOwnerPaths, irUnitPath, resolveIRPath } from '../../../src/ir/output/operation-paths.ts';

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

  test('only tool call IDs may be IRAbsent', () => {
    expect(resolveIRPath(item(2, 'call_id'), root)?.node).toMatchObject({ kind: 'string', absent: true });
    expect(resolveIRPath(item(3, 'call_id'), root)?.node).toMatchObject({ kind: 'string', absent: true });
    expect(resolveIRPath(item(2, 'name'), root)?.node).not.toMatchObject({ kind: 'string', absent: true });
    expect(resolveIRPath(item(0, 'call_id'), root)?.node).not.toMatchObject({ kind: 'string', absent: true });
  });

  test('unit paths are built from the schema and read back from end events', () => {
    expect(irItemPath(0, 3)).toEqual(item(3));
    expect(irPartPath(0, 0, 1)).toEqual(item(0, 'content', 1));
    expect(irUnitPath('choice', 2)).toEqual(['choices', 2]);
    expect(irEndedUnit({ type: 'part_end', choice: 0, item: 0, part: 1 })?.path).toEqual(item(0, 'content', 1));
    expect(irEndedUnit({ type: 'item_end', choice: 0, item: 2 })?.path).toEqual(item(2));
    expect(irEndedUnit({ type: 'choice_end', choice: 1, finish_reason: 'stop' })?.path).toEqual(['choices', 1]);
    expect(irEndedUnit({ type: 'ping' })).toBeUndefined();
    expect(() => irUnitPath('item', 0)).toThrow('take 2 indices');
  });

  test('a record belongs to its units, innermost first', () => {
    expect(irRecordOwnerPaths({ type: 'write', kind: 'append', path: item(0, 'content', 0, 'text'), value: 'x' }, root))
      .toEqual([item(0, 'content', 0), item(0), ['choices', 0]]);
    expect(irRecordOwnerPaths({ type: 'item_end', choice: 0, item: 1 }, root)).toEqual([item(1)]);
    expect(irRecordOwnerPaths({ type: 'ping' }, root)).toEqual([]);
  });
});
