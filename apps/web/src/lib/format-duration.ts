import { NO_READING } from './no-reading';

// A latency percentile is an instrument reading, so it keeps an SI-style ladder
// every locale spells the same way.
export const formatDuration = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return NO_READING;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const unit = (value: number, name: 'minute' | 'second', locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);

// A live countdown keeps its seconds all the way down, so it cannot go through
// `formatDuration` -- a bin ladder would render the last three minutes as `2.9m`
// and never tick.
export const formatCountdown = (seconds: number, locale: string): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = unit(whole % 60, 'second', locale);
  return minutes > 0 ? `${unit(minutes, 'minute', locale)} ${rest}` : rest;
};
