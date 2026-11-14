import { expect, it } from 'vitest';

import { seriesRunBoundaryPoints } from '../../../src/components/charts/point-markers';

it('marks both boundaries of each equal-value run while ignoring missing rows', () => {
  expect(seriesRunBoundaryPoints([10, 10, undefined, 10, 20, null, 20])).toEqual([true, false, false, true, true, false, true]);
  expect(seriesRunBoundaryPoints([5, 5])).toEqual([true, true]);
  expect(seriesRunBoundaryPoints([5, 5, 5])).toEqual([true, false, true]);
});
