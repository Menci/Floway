export interface HistogramBucket {
  lower: number;
  upper: number | null;
  count: number;
}

// Estimate the value at the selected rank using a uniform distribution within its bucket.
export const percentileFromBuckets = (buckets: readonly HistogramBucket[], percentile: number): number | null => {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  if (total <= 0) return null;
  // Avoid rounding an integral nearest rank up because of floating-point error.
  const rank = Math.max(1, Math.min(total, Math.ceil(total * percentile - 1e-9)));
  const ordered = [...buckets].sort((a, b) => {
    if (a.upper === null) return b.upper === null ? 0 : 1;
    return b.upper === null ? -1 : a.upper - b.upper;
  });
  let seen = 0;
  for (const bucket of ordered) {
    if (seen + bucket.count >= rank) {
      if (bucket.upper === null) return bucket.lower;
      return bucket.lower + (bucket.upper - bucket.lower) * (rank - seen) / (bucket.count + 1);
    }
    seen += bucket.count;
  }
  throw new Error('Performance percentile rank exceeds the histogram count');
};
