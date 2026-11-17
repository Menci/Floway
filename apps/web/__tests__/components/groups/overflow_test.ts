import { expect, test } from 'vitest';

import { visibleGroupCount } from '../../../src/components/groups/overflow';

test('reserves the actual overflow width when selecting the longest fitting prefix', () => {
  expect(visibleGroupCount(142, [50, 60, 70], 24, 4)).toBe(2);
  expect(visibleGroupCount(141, [50, 60, 70], 24, 4)).toBe(1);
  expect(visibleGroupCount(78, [50, 60, 70], 24, 4)).toBe(1);
  expect(visibleGroupCount(77, [50, 60, 70], 24, 4)).toBe(0);
});
