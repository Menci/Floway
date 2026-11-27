import { describe, expect, it } from 'vitest';

import {
  partitionSeriesForOther,
  stableSeriesHues,
} from '../../../src/components/charts/series-grouping';
import { rankedLegend } from '../../../src/components/charts/series-legends';

describe('stable hues, Other partitioning, and legend ranking', () => {
  it('assigns deterministic hues by baseline volume and honors explicit upstream hues', () => {
    const first = stableSeriesHues(['a', 'b', 'c'], new Map([['a', 10], ['b', 300], ['c', 50]]));
    const reversed = stableSeriesHues(['c', 'a', 'b'], new Map([['a', 10], ['b', 300], ['c', 50]]));
    expect([...first.entries()]).toEqual([...reversed.entries()]);

    const withExplicit = stableSeriesHues(
      ['up-1', 'up-2'],
      new Map([['up-1', 100], ['up-2', 50]]),
      new Map([['up-1', 210]]),
    );
    expect(withExplicit.get('up-1')).toBe(210);
  });

  it('keeps Top 9 at or above 1% and folds the rest only when at least two series qualify', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `m-${index}` }));
    const weights = new Map<string, number>([
      ['m-0', 2000], ['m-1', 1800], ['m-2', 1500], ['m-3', 1200], ['m-4', 1000],
      ['m-5', 900], ['m-6', 800], ['m-7', 500], ['m-8', 200],
      // Rank 10 is >= 1% but beyond Top 9; rank 11 and 12 are below 1%.
      ['m-9', 150], ['m-10', 30], ['m-11', 10],
    ]);

    const folded = partitionSeriesForOther(items, weights, true);
    expect(folded.top.map(item => item.id)).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8']);
    expect(folded.other.map(item => item.id)).toEqual(['m-9', 'm-10', 'm-11']);

    const skewed = partitionSeriesForOther(
      [{ id: 'big' }, { id: 'tiny-a' }, { id: 'tiny-b' }],
      new Map([['big', 10_000], ['tiny-a', 40], ['tiny-b', 20]]),
      true,
    );
    expect(skewed.top.map(item => item.id)).toEqual(['big']);
    expect(skewed.other.map(item => item.id)).toEqual(['tiny-a', 'tiny-b']);

    const loneMinor = partitionSeriesForOther(
      [{ id: 'big' }, { id: 'tiny' }],
      new Map([['big', 10_000], ['tiny', 20]]),
      true,
    );
    expect(loneMinor.top.map(item => item.id)).toEqual(['big', 'tiny']);
    expect(loneMinor.other).toEqual([]);

    const disabled = partitionSeriesForOther(items, weights, false);
    expect(disabled.top).toHaveLength(12);
    expect(disabled.other).toEqual([]);
  });

  it('orders legend entries descending by active weight while preserving input order when unweighted', () => {
    const entries = [
      { id: 'a', label: 'A', hue: 10 },
      { id: 'b', label: 'B', hue: 20 },
      { id: 'c', label: 'C', hue: 30 },
    ];
    expect(rankedLegend(entries).map(entry => entry.id)).toEqual(['a', 'b', 'c']);
    expect(rankedLegend(entries, new Map([['a', 10], ['b', 300], ['c', 300]])).map(entry => entry.id))
      .toEqual(['b', 'c', 'a']);
  });
});
