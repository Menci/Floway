// A latency percentile is an instrument reading, so it keeps the SI-style unit
// ladder and the fixed decimal every locale spells the same way. The countdown
// below is the other kind of duration -- prose the reader reads as "how long
// until this clears" -- and that one is the locale's to spell.
//
// `-` rather than `0ms` for a missing reading: the performance API reports no
// percentile for a window that sampled nothing, and a rendered `0ms` reads as a
// measurement of zero rather than as the absence of one.
export const formatDuration = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '-';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
};

const unit = (value: number, name: 'minute' | 'second', locale: string): string =>
  new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);

// A live countdown keeps its seconds all the way down, so it cannot go through
// `formatDuration` -- a bin ladder would render the last three minutes as
// `2.9m` and never tick. Minutes are dropped once there are none rather than
// padded to `0m 45s`, and the units come from `Intl` so a `zh-Hans` dashboard
// counts down in 分钟 and 秒 rather than in `m` and `s`.
export const formatCountdown = (seconds: number, locale: string): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = unit(whole % 60, 'second', locale);
  return minutes > 0 ? `${unit(minutes, 'minute', locale)} ${rest}` : rest;
};
