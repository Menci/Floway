// Upstream-reported utilization can exceed the window it describes (overage,
// rounding, a limit lowered mid-window), and a progress bar has nowhere to
// put the excess.
//
// A reading that is not a finite number is not a percent at all: it says the
// upstream reported nothing usable, which is not the same reading as zero. It
// comes back as null, so a caller says "unknown" rather than drawing an empty
// bar under a `NaN%`.
export const clampPercent = (percent: number): number | null =>
  Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;

// Beside a bar that went indeterminate because nothing is known, the readout
// says so in one character rather than printing a number nobody reported.
export const percentText = (percent: number | null): string => percent === null ? '—' : `${percent}%`;
