import { expect, it, vi } from 'vitest';

import { enter, leave, runEvent } from './fixtures.ts';
import { computeStageDiffs, createDumpDecoder, diffStoredValues } from '../src/browser.ts';
import { createDumpEncoder } from '../src/encoder.ts';

it('skips equal ids without resolving or inspecting their subtrees', () => {
  const decoder = createDumpDecoder();
  const node = vi.spyOn(decoder, 'getStoredNode');
  const resolve = vi.spyOn(decoder, 'resolve');
  expect(diffStoredValues({ $: 100 }, { $: 100 }, decoder)).toEqual([]);
  expect(node).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('diffs down to all children and up from the base, preserving escaped keys and explicit undefined', () => {
  const shared = { nested: ['identity'] };
  const decoder = createDumpDecoder();
  const input = { shared, $key: 1, removed: undefined };
  decoder.pushEvents(createDumpEncoder().encodeBatch([
    runEvent,
    enter(2, 1, input),
    enter(3, 2, { shared, $key: 2, added: undefined }, 1, 'next'),
    leave(4, 2, { status: 503 }),
    enter(5, 3, input, 1, 'next'),
    leave(6, 3, { status: 200 }),
    leave(7, 1, { status: 201 }, 3),
  ]));
  expect(computeStageDiffs(decoder.model, decoder, 1)).toEqual({
    downward: [
      {
        childStageId: 2, childName: 'stage-2', entries: [
          { path: ['$key'], kind: 'changed', before: 1, after: 2 },
          { path: ['removed'], kind: 'removed', before: undefined },
          { path: ['added'], kind: 'added', after: undefined },
        ],
      },
      { childStageId: 3, childName: 'stage-3', entries: [] },
    ],
    upward: [{ childStageId: 3, childName: 'stage-3', entries: [{ path: ['status'], kind: 'changed', before: 200, after: 201 }] }],
  });
});
