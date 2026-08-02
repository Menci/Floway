// A window is "spent" well before it refuses, so the bar turns ahead of the
// first 429 rather than alongside it. An unknown percent earns no warning:
// the colour states a reading, and there is no reading to state.
export const quotaBarColor = (percent: number | null) => percent === null ? 'brand' : percent >= 90 ? 'error' : percent >= 80 ? 'warning' : 'brand';

export const HEAVY_USAGE_THRESHOLD_PERCENT = 80;

// Token expiry and rate-limit expiry are read off the wall clock rather than
// off any state change, so both cards re-render on the same minute tick.
export const WALL_CLOCK_REFRESH_MS = 60_000;

// An account is only as free as its most-consumed window, so the headline
// takes the maximum rather than an average. No windows means nothing is known,
// which is not the same reading as zero.
export const heaviestPercent = (percents: number[]): number | null => percents.length ? Math.max(...percents) : null;
