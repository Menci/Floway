import { describe, expect, it } from 'vitest';

import { positiveLineChartExtent, positiveValueExtent } from '../../../src/components/charts/value-extent';

describe('positive chart extent', () => {
  it('ignores non-positive readings and preserves empty-data semantics', () => {
    expect(positiveLineChartExtent({
      lineChartData: [{ legend: 'series', data: [
        { x: 1, y: 0 },
        { x: 2, y: 4 },
        { x: 3, y: 2 },
        { x: 4, y: -1 },
      ] }],
    })).toEqual({ minimum: 2, maximum: 4 });
    expect(positiveLineChartExtent({ lineChartData: [] })).toBeNull();
  });

  it('scans beyond the spread-argument limit without materializing another array', () => {
    function* readings() {
      for (let value = 1; value <= 200_000; value += 1) yield value;
    }

    expect(positiveValueExtent(readings())).toEqual({ minimum: 1, maximum: 200_000 });
  });
});
