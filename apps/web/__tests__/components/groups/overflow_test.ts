import { expect, test } from 'vitest';

import { visibleBadgeCount } from '../../../src/components/groups/overflow';

test('shows every badge when it fits, without reserving an overflow control', () => {
  expect(visibleBadgeCount(188, [50, 60, 70], [24, 28, 30], 4)).toBe(3);
  expect(visibleBadgeCount(187, [50, 60, 70], [24, 28, 30], 4)).toBe(2);
});

test('reserves the actual overflow width when selecting the longest fitting prefix', () => {
  expect(visibleBadgeCount(142, [50, 60, 70], [24, 28, 30], 4)).toBe(2);
  expect(visibleBadgeCount(141, [50, 60, 70], [24, 28, 30], 4)).toBe(1);
  expect(visibleBadgeCount(82, [50, 60, 70], [24, 28, 30], 4)).toBe(1);
  expect(visibleBadgeCount(81, [50, 60, 70], [24, 28, 30], 4)).toBe(0);
});

test('handles a single long label and fractional chip widths without truncation', () => {
  expect(visibleBadgeCount(100, [200], [24], 4)).toBe(0);
  expect(visibleBadgeCount(200, [200], [24], 4)).toBe(1);
  expect(visibleBadgeCount(78.5, [50.25, 50.25], [24.25, 25], 4)).toBe(1);
  expect(visibleBadgeCount(78.49, [50.25, 50.25], [24.25, 25], 4)).toBe(0);
});
