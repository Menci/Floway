import { describe, expect, it } from 'vitest';

import {
  bucketForTtftMs,
  percentileFromBuckets,
  type HistogramBucket,
} from '../../src/shared/performance-histogram.ts';

describe('bucketForTtftMs', () => {

  it('boundary values land in the bucket whose upper equals the value', () => {
    expect(bucketForTtftMs(200)).toEqual({ lower: 100, upper: 200 });
    expect(bucketForTtftMs(300_000)).toEqual({ lower: 120_000, upper: 300_000 });
  });

  it('above-top value lands in the +∞ overflow bucket', () => {
    expect(bucketForTtftMs(600_000)).toEqual({ lower: 300_000, upper: null });
  });

  it('throws on negative input rather than silently clamping', () => {
    expect(() => bucketForTtftMs(-5)).toThrow(/bucketForValue/);
  });
});

describe('percentileFromBuckets', () => {
  it('uses the rank local to the selected bucket', () => {
    const buckets: HistogramBucket[] = [
      { lower: 0, upper: 50, count: 1 },
      { lower: 50, upper: 100, count: 2 },
      { lower: 100, upper: 200, count: 7 },
    ];

    // Global p50 rank 5 is the second of seven samples in the third bucket.
    expect(percentileFromBuckets(buckets, 0.5)).toBe(125);
  });

  it('overflow bucket returns its lower edge (no upper is defined)', () => {
    const withOverflow: HistogramBucket[] = [
      { lower: 0, upper: 50, count: 1 },
      { lower: 1_800_000, upper: null, count: 9 },
    ];
    expect(percentileFromBuckets(withOverflow, 0.95)).toBe(1_800_000);
  });

  it('IEEE-754 drift in total*percentile does not spill rank into the next bucket', () => {
    // 200 * 0.29 === 58.00000000000001 → Math.ceil = 59 without the epsilon guard,
    // which would jump one bucket past the intended sample.
    const flat: HistogramBucket[] = Array.from({ length: 4 }, (_, i) => ({
      lower: i * 50,
      upper: (i + 1) * 50,
      count: 50,
    }));
    // rank(0.29, 200) = ceil(58 - ε) = 58; cumulative counts 50/100/150/200,
    // so this is the eighth of 50 uniformly distributed samples in [50, 100].
    expect(percentileFromBuckets(flat, 0.29)).toBeCloseTo(50 + 400 / 51, 10);
  });
});
