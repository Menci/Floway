import { expect, test } from 'vitest';

import { visibleGroupCount } from '../../../src/components/groups/overflow';

test('shows every group when it fits, without reserving an overflow avatar', () => {
  expect(visibleGroupCount(188, [50, 60, 70], 24, 4)).toBe(3);
  expect(visibleGroupCount(187, [50, 60, 70], 24, 4)).toBe(2);
});

test('reserves the actual overflow width when selecting the longest fitting prefix', () => {
  expect(visibleGroupCount(142, [50, 60, 70], 24, 4)).toBe(2);
  expect(visibleGroupCount(141, [50, 60, 70], 24, 4)).toBe(1);
  expect(visibleGroupCount(78, [50, 60, 70], 24, 4)).toBe(1);
  expect(visibleGroupCount(77, [50, 60, 70], 24, 4)).toBe(0);
});

test('handles a single long label and fractional identity widths without truncation', () => {
  expect(visibleGroupCount(100, [200], 24, 4)).toBe(0);
  expect(visibleGroupCount(200, [200], 24, 4)).toBe(1);
  expect(visibleGroupCount(78.5, [50.25, 50.25], 24.25, 4)).toBe(1);
  expect(visibleGroupCount(78.49, [50.25, 50.25], 24.25, 4)).toBe(0);
});
