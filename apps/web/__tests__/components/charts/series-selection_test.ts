import { describe, expect, it } from 'vitest';

import { isolatedSeries, toggledSeries } from '../../../src/components/charts/series-selection';

const IDS = ['a', 'b', 'c'];

describe('series isolation', () => {
  it('reverses itself when the chosen series is already the only visible one', () => {
    expect([...isolatedSeries(IDS, new Set(['a', 'c']), 'b')]).toEqual([]);
  });

  it('survives a double-click, whose two toggles cancel out first', () => {
    // A double-click delivers click, click, dblclick. Both clicks land on the
    // same series, so the isolate that follows starts from the state the
    // reader saw.
    const afterFirstClick = toggledSeries(new Set(['c']), 'b');
    const afterSecondClick = toggledSeries(afterFirstClick, 'b');
    expect([...afterSecondClick]).toEqual(['c']);
    expect([...isolatedSeries(IDS, afterSecondClick, 'b')]).toEqual(['a', 'c']);
  });
});
