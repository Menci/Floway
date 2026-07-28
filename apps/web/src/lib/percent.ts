// Upstream-reported utilization can exceed the window it describes (overage,
// rounding, a limit lowered mid-window), and a progress bar has nowhere to
// put the excess.
export const clampPercent = (percent: number): number => Math.max(0, Math.min(100, Math.round(percent)));
