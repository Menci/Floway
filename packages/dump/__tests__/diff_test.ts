import { expect, test } from 'vitest';

import { diffFacts } from '../src/browser.ts';

test('derives nested changes through cycles and distinguishes missing keys from undefined values', () => {
  const before = { data: [1, { value: 'incoming' }], absentLater: undefined, bytes: Uint8Array.of(1, 2), self: {} };
  const after = { data: [1, { value: 'outgoing' }], undefined, bytes: Uint8Array.of(1, 2), self: {} };
  before.self = before;
  after.self = after;
  expect(diffFacts(before, after)).toEqual([
    { path: ['data', 1, 'value'], kind: 'changed', before: 'incoming', after: 'outgoing' },
    { path: ['absentLater'], kind: 'removed', before: undefined },
    { path: ['undefined'], kind: 'added', after: undefined },
  ]);
});
