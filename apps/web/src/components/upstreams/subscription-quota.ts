// The thresholds are stated once for every subscription upstream, so a reading
// that colours a bar in the editor colours the ring beside it in the list the
// same way.
export const HEAVY_USAGE_THRESHOLD_PERCENT = 80;
const CRITICAL_USAGE_THRESHOLD_PERCENT = 90;

export type QuotaSeverity = 'normal' | 'heavy' | 'critical';

// An unknown percent earns no warning: the colour states a reading, and there
// is no reading to state.
export const quotaSeverity = (percent: number | null): QuotaSeverity =>
  percent === null
    ? 'normal'
    : percent >= CRITICAL_USAGE_THRESHOLD_PERCENT
      ? 'critical'
      : percent >= HEAVY_USAGE_THRESHOLD_PERCENT ? 'heavy' : 'normal';

const BAR_COLORS = { normal: 'brand', heavy: 'warning', critical: 'error' } as const;
const RING_TONES = { normal: 'accent', heavy: 'caution', critical: 'critical' } as const;

export const quotaBarColor = (percent: number | null) => BAR_COLORS[quotaSeverity(percent)];

export const quotaRingTone = (percent: number | null) => RING_TONES[quotaSeverity(percent)];

// Token expiry and rate-limit expiry are read off the wall clock rather than
// off any state change, so both cards re-render on the same minute tick.
export const WALL_CLOCK_REFRESH_MS = 60_000;

// No windows means nothing is known, which is not the same reading as zero.
export const heaviestPercent = (percents: number[]): number | null => percents.length ? Math.max(...percents) : null;

export type UsageHeavyOrActive =
  | { tone: 'warning'; reason: 'heavy'; percent: number }
  | { tone: 'success'; reason: 'active' };

// The threshold rule every subscription upstream shares: the heaviest window at
// or above the heavy threshold reads as heavy, and anything else -- including no
// window at all -- reads as active.
export const usageStatusFromHeaviest = (heaviest: number | null): UsageHeavyOrActive =>
  heaviest !== null && heaviest >= HEAVY_USAGE_THRESHOLD_PERCENT
    ? { tone: 'warning', reason: 'heavy', percent: Math.round(heaviest) }
    : { tone: 'success', reason: 'active' };

// A window is named by the length it covers rather than by the field it arrived
// in, so the five hours a Codex header states in minutes and the five hours
// Ollama documents for its session allowance read as one window in one row.
export const windowLengthLabel = (minutes: number): string =>
  minutes % (24 * 60) === 0
    ? `${minutes / (24 * 60)}d`
    : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;

export const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
export const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;
