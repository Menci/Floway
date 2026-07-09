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
  it('TTFT has 19 upper edges anchored on operator-facing thresholds up to 5 min', () => {
    expect(TTFT_UPPER_EDGES_MS).toEqual([
      100, 200, 300, 500, 700, 1_000, 1_400, 2_000, 2_800, 4_000,
      5_500, 8_000, 12_000, 16_000, 24_000, 36_000, 60_000, 120_000, 300_000,
    ]);
  });

  it('TPOT has 24 upper edges with tok/s SLO anchors (100, 50, 20, 10 tok/s) on real edges', () => {
    expect(TPOT_UPPER_EDGES_US).toEqual([
      500, 1_000, 2_000, 3_333, 5_000, 6_667, 8_333, 10_000, 12_500, 14_286,
      16_667, 20_000, 25_000, 33_333, 40_000, 50_000, 66_667, 100_000, 150_000,
      250_000, 500_000, 1_000_000, 2_500_000, 10_000_000,
    ]);
  });
});

describe('bucketForTtftMs', () => {
  it('sub-edge value lands in the first bucket [0, 100]', () => {
    expect(bucketForTtftMs(10)).toEqual({ lower: 0, upper: 100 });
    expect(bucketForTtftMs(100)).toEqual({ lower: 0, upper: 100 });
  });

  it('boundary values land in the bucket whose upper equals the value', () => {
    expect(bucketForTtftMs(200)).toEqual({ lower: 100, upper: 200 });
    expect(bucketForTtftMs(300_000)).toEqual({ lower: 120_000, upper: 300_000 });
  });

  it('above-top value lands in the +∞ overflow bucket', () => {
    expect(bucketForTtftMs(600_000)).toEqual({ lower: 300_000, upper: null });
  });

  it('accepts zero (real ttft = 0 is valid)', () => {
    expect(bucketForTtftMs(0)).toEqual({ lower: 0, upper: 100 });
  });

  it('throws on negative input rather than silently clamping', () => {
    expect(() => bucketForTtftMs(-5)).toThrow(/bucketForValue/);
  });

  it('throws on NaN rather than silently landing in overflow', () => {
    expect(() => bucketForTtftMs(NaN)).toThrow(/bucketForValue/);
  });

  it('throws on Infinity rather than silently landing in overflow', () => {
    expect(() => bucketForTtftMs(Infinity)).toThrow(/bucketForValue/);
  });
});

describe('bucketForTpotUs', () => {
  it('below-bottom value lands in the first bucket [0, 500]', () => {
    expect(bucketForTpotUs(150)).toEqual({ lower: 0, upper: 500 });
  });

  it('above-top value lands in overflow', () => {
    expect(bucketForTpotUs(50_000_000)).toEqual({ lower: 10_000_000, upper: null });
  });

  it('SLO anchor edges hit the intended tok/s values exactly', () => {
    // 100 tok/s = 10_000 μs — must be a bucket upper so an SLO alert "p95 speed >= 100 tok/s"
    // reads directly off the histogram without factor-1.5 fuzz.
    expect(TPOT_UPPER_EDGES_US).toContain(10_000);
    expect(TPOT_UPPER_EDGES_US).toContain(20_000);  // 50 tok/s
    expect(TPOT_UPPER_EDGES_US).toContain(50_000);  // 20 tok/s
    expect(TPOT_UPPER_EDGES_US).toContain(100_000); // 10 tok/s
  });
});

describe('percentileFromBuckets', () => {
  it('returns the bucket geometric midpoint sqrt(lower*upper), not the upper edge', () => {
    const buckets: HistogramBucket[] = [
      { lower: 100, upper: 200, count: 10 },
    ];
    // sqrt(100 * 200) ≈ 141.42, not 200
    expect(percentileFromBuckets(buckets, 0.5)).toBeCloseTo(Math.sqrt(20_000), 5);
  });

  it('first bucket (lower=0) falls back to arithmetic midpoint to avoid sqrt(0)', () => {
    const buckets: HistogramBucket[] = [
      { lower: 0, upper: 100, count: 10 },
    ];
    expect(percentileFromBuckets(buckets, 0.5)).toBe(50);
  });

  it('p50 lands in the highest-count bucket', () => {
    const buckets: HistogramBucket[] = [
      { lower: 0, upper: 50, count: 1 },
      { lower: 50, upper: 100, count: 2 },
      { lower: 100, upper: 200, count: 7 },
    ];
    // p50 rank = ceil(10 * 0.5) = 5; falls in the third bucket. Geometric mid sqrt(100*200) ≈ 141.42.
    expect(percentileFromBuckets(buckets, 0.5)).toBeCloseTo(Math.sqrt(20_000), 5);
  });

  it('p99 lands in the top bucket', () => {
    const buckets: HistogramBucket[] = [
      { lower: 0, upper: 50, count: 1 },
      { lower: 50, upper: 100, count: 2 },
      { lower: 100, upper: 200, count: 7 },
    ];
    expect(percentileFromBuckets(buckets, 0.99)).toBeCloseTo(Math.sqrt(20_000), 5);
  });

  it('empty histogram returns null', () => {
    expect(percentileFromBuckets([], 0.5)).toBe(null);
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
    // rank(0.29, 200) = ceil(58 - ε) = 58; cumulative counts 50/100/150/200 → hits second bucket [50, 100].
    // Geometric mid sqrt(50 * 100) ≈ 70.71.
    expect(percentileFromBuckets(flat, 0.29)).toBeCloseTo(Math.sqrt(5_000), 5);
  });
});
