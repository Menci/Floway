import { describe, expect, it } from 'vitest';

import {
  TTFT_UPPER_EDGES_MS,
  TPOT_UPPER_EDGES_US,
  bucketForTtftMs,
  bucketForTpotUs,
  percentileFromBuckets,
  type HistogramBucket,
} from './performance-histogram.ts';

describe('bucket edges', () => {
  it('TTFT has 16 upper edges spanning 50ms to 30min', () => {
    expect(TTFT_UPPER_EDGES_MS).toEqual([
      50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
      60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000,
    ]);
  });

  it('TPOT has 16 upper edges spanning 200μs to 10s', () => {
    expect(TPOT_UPPER_EDGES_US).toEqual([
      200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
      50_000, 75_000, 100_000, 200_000, 500_000, 1_000_000, 2_500_000, 10_000_000,
    ]);
  });
});

describe('bucketForTtftMs', () => {
  it('sub-edge value lands in the first bucket [0, 50]', () => {
    expect(bucketForTtftMs(10)).toEqual({ lower: 0, upper: 50 });
    expect(bucketForTtftMs(50)).toEqual({ lower: 0, upper: 50 });
  });

  it('boundary values land in the bucket whose upper equals the value', () => {
    expect(bucketForTtftMs(200)).toEqual({ lower: 100, upper: 200 });
    expect(bucketForTtftMs(1_800_000)).toEqual({ lower: 1_200_000, upper: 1_800_000 });
  });

  it('above-top value lands in the +∞ overflow bucket', () => {
    expect(bucketForTtftMs(3_600_000)).toEqual({ lower: 1_800_000, upper: null });
  });

  it('negative or zero clamps to the first bucket', () => {
    expect(bucketForTtftMs(0)).toEqual({ lower: 0, upper: 50 });
    expect(bucketForTtftMs(-5)).toEqual({ lower: 0, upper: 50 });
  });
});

describe('bucketForTpotUs', () => {
  it('below-bottom value lands in the first bucket [0, 200]', () => {
    expect(bucketForTpotUs(150)).toEqual({ lower: 0, upper: 200 });
  });

  it('above-top value lands in overflow', () => {
    expect(bucketForTpotUs(50_000_000)).toEqual({ lower: 10_000_000, upper: null });
  });
});

describe('percentileFromBuckets', () => {
  const buckets: HistogramBucket[] = [
    { lower: 0, upper: 50, count: 1 },
    { lower: 50, upper: 100, count: 2 },
    { lower: 100, upper: 200, count: 7 },
  ];

  it('p50 lands in the highest-count bucket', () => {
    expect(percentileFromBuckets(buckets, 0.5)).toBe(200);
  });

  it('p99 lands in the top bucket', () => {
    expect(percentileFromBuckets(buckets, 0.99)).toBe(200);
  });

  it('empty histogram returns null', () => {
    expect(percentileFromBuckets([], 0.5)).toBe(null);
  });

  it('overflow bucket returns the highest finite upper', () => {
    const withOverflow: HistogramBucket[] = [
      { lower: 0, upper: 50, count: 1 },
      { lower: 1_800_000, upper: null, count: 9 },
    ];
    expect(percentileFromBuckets(withOverflow, 0.95)).toBe(1_800_000);
  });
});
