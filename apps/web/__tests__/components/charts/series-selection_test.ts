import { describe, expect, it } from 'vitest';

import { invertedSeries, isolatedSeries, toggledSeries } from '../../../src/components/charts/series-selection';

const IDS = ['a', 'b', 'c'];

describe('series toggle', () => {
  it('hides a visible series and shows a hidden one', () => {
    expect([...toggledSeries(new Set(), 'a')]).toEqual(['a']);
    expect([...toggledSeries(new Set(['a']), 'a')]).toEqual([]);
  });
});

describe('series inversion', () => {
  it('swaps hidden and visible', () => {
    expect([...invertedSeries(IDS, new Set(['a']))]).toEqual(['b', 'c']);
    expect([...invertedSeries(IDS, new Set())]).toEqual(IDS);
    expect([...invertedSeries(IDS, new Set(IDS))]).toEqual([]);
  });
});

describe('series isolation', () => {

  it('reverses itself when the chosen series is already the only visible one', () => {
    expect([...isolatedSeries(IDS, new Set(['a', 'c']), 'b')]).toEqual([]);
  });

  it('isolates rather than reverses when another series is also visible', () => {
    expect([...isolatedSeries(IDS, new Set(['c']), 'b')]).toEqual(['a', 'c']);
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
