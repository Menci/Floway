// `-` rather than `0ms` for a missing reading: the performance API reports no
// percentile for a window that sampled nothing, and a rendered `0ms` reads as a
// measurement of zero rather than as the absence of one.
export const formatDuration = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};
