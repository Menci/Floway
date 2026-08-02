// Upstream-reported utilization can exceed the window it describes (overage,
// rounding, a limit lowered mid-window), and a progress bar has nowhere to put
// the excess. A non-finite reading is not a percent at all -- the upstream
// reported nothing usable, which is not the same reading as zero -- so it comes
// back as null and the caller says "unknown".
export const clampPercent = (percent: number): number | null =>
  Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;

export const percentText = (percent: number | null): string => percent === null ? '—' : `${percent}%`;
