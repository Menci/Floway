// Codex and Claude Code both present a subscription account as a set of
// independently-resetting quota windows, so the account-level reading of those
// windows and the colour it earns are the same question for both.

// A window is "spent" well before it refuses, so the bar turns before the
// account does — an operator watching the card gets warning colour ahead of
// the first 429 rather than alongside it.
// An unknown percent earns no warning: the colour states a reading, and there
// is no reading to state.
export const quotaBarColor = (percent: number | null) => percent === null ? 'brand' : percent >= 90 ? 'error' : percent >= 80 ? 'warning' : 'brand';

export const HEAVY_USAGE_THRESHOLD_PERCENT = 80;

// An account is only as free as its most-consumed window, so the headline
// takes the maximum rather than an average. No windows means nothing is known
// about consumption, which is not the same reading as zero.
export const heaviestPercent = (percents: number[]): number | null => percents.length ? Math.max(...percents) : null;
