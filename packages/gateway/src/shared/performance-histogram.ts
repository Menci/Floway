export const TTFT_UPPER_EDGES_MS = [
  50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
  60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000,
] as const;

export const TPOT_UPPER_EDGES_US = [
  200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
  50_000, 75_000, 100_000, 200_000, 500_000, 1_000_000, 2_500_000, 10_000_000,
] as const;

export interface HistogramBucket {
  lower: number;
  upper: number | null;
  count: number;
}

const bucketForValue = (edges: readonly number[], value: number): Omit<HistogramBucket, 'count'> => {
  const clamped = Math.max(0, Math.ceil(value));
  let lower = 0;
  for (const upper of edges) {
    if (clamped <= upper) return { lower, upper };
    lower = upper;
  }
  return { lower, upper: null };
};

export const bucketForTtftMs = (ttftMs: number) => bucketForValue(TTFT_UPPER_EDGES_MS, ttftMs);
export const bucketForTpotUs = (tpotUs: number) => bucketForValue(TPOT_UPPER_EDGES_US, tpotUs);

export const percentileFromBuckets = (buckets: readonly HistogramBucket[], percentile: number): number | null => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total <= 0) return null;

  const rank = Math.ceil(total * percentile);
  const ordered = [...buckets].sort((a, b) => {
    // +∞ overflow bucket sorts last.
    if (a.upper === null) return 1;
    if (b.upper === null) return -1;
    return a.upper - b.upper;
  });

  let seen = 0;
  for (const bucket of ordered) {
    seen += bucket.count;
    if (seen >= rank) return bucket.upper ?? bucket.lower;
  }
  return null;
};
