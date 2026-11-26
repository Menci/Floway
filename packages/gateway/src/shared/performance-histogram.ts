// TTFT and TPOT bucket edges are fitted to 30k+ real per-model per-provider
// throughput/latency samples scraped from OpenRouter's public endpoint stats
// (throughput_last_30m + latency_last_30m from
// https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints, enumerated
// via https://openrouter.ai/api/v1/models; spans 346 models × ~5 providers
// × 4 in-page percentiles × 3 time windows). The core [p10, p90] of the
// empirical distribution must land 8-10 bucket slots to keep the max
// single-bucket concentration below ~15% and give meaningful percentiles.
//
// TPOT edges anchor exactly on the human-facing tok/s SLO points (100, 50,
// 20, 10 tok/s) so a percentile reading lands on a real edge rather than a
// factor-1.5 estimate. The direction is inverted against speed: a p95 TPOT of
// 50 000 µs is the slow tail — the slowest 5% of samples — and reads as
// "95% of samples generated at 20 tok/s or faster".

export const TTFT_UPPER_EDGES_MS = [
  100, 200, 300, 500, 700, 1_000, 1_400, 2_000, 2_800, 4_000,
  5_500, 8_000, 12_000, 16_000, 24_000, 36_000, 60_000, 120_000, 300_000,
] as const;

// tok/s at each edge (for reference): 2000, 1000, 500, 300, 200, 150, 120,
// 100, 80, 70, 60, 50, 40, 30, 25, 20, 15, 10, 6.7, 4, 2, 1, 0.4, 0.1.
export const TPOT_UPPER_EDGES_US = [
  500, 1_000, 2_000, 3_333, 5_000, 6_667, 8_333, 10_000, 12_500, 14_286,
  16_667, 20_000, 25_000, 33_333, 40_000, 50_000, 66_667, 100_000, 150_000,
  250_000, 500_000, 1_000_000, 2_500_000, 10_000_000,
] as const;

const bucketForValue = (edges: readonly number[], value: number): { lower: number; upper: number | null } => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`bucketForValue: expected finite non-negative number, got ${value}`);
  const clamped = Math.ceil(value);
  let lower = 0;
  for (const upper of edges) {
    if (clamped <= upper) return { lower, upper };
    lower = upper;
  }
  return { lower, upper: null };
};

export const bucketForTtftMs = (ttftMs: number) => bucketForValue(TTFT_UPPER_EDGES_MS, ttftMs);
export const bucketForTpotUs = (tpotUs: number) => bucketForValue(TPOT_UPPER_EDGES_US, tpotUs);
