import { NO_READING } from './no-reading';

export type DurationUnit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day';

// Chinese writes a space between a number and its unit word, the same as the
// message catalog does (`{{count}} 天`); other locales keep the compact Latin
// suffix every operator there reads as a duration. `short` rather than `narrow`
// in Chinese, because `narrow` falls back to the Latin `ms` for milliseconds.
export const formatDurationUnit = (value: number, name: DurationUnit, locale: string, fractionDigits?: number): string => {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: name,
    unitDisplay: locale.startsWith('zh') ? 'short' : 'narrow',
    ...(fractionDigits === undefined ? {} : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }),
  });
  if (!locale.startsWith('zh')) return formatter.format(value);
  return formatter.formatToParts(value)
    .map(part => part.type === 'unit' ? ` ${part.value}` : part.value)
    .join('');
};

// A latency reading is a duration rather than an instant, so it keeps a unit
// word in every locale instead of a bare SI suffix. Request rows use the same
// ladder, so a dense row and the percentile cards above it agree.
export const formatDuration = (ms: number | null, locale: string): string => {
  if (ms === null || !Number.isFinite(ms)) return NO_READING;
  if (ms >= 60_000) return formatDurationUnit(ms / 60_000, 'minute', locale, 1);
  if (ms >= 1_000) return formatDurationUnit(ms / 1_000, 'second', locale, 1);
  return formatDurationUnit(Math.round(ms), 'millisecond', locale);
};

// A live countdown keeps its seconds all the way down, so it cannot go through
// `formatDuration` -- a bin ladder would render the last three minutes as `2.9m`
// and never tick.
export const formatCountdown = (seconds: number, locale: string): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = formatDurationUnit(whole % 60, 'second', locale);
  return minutes > 0 ? `${formatDurationUnit(minutes, 'minute', locale)} ${rest}` : rest;
};

// How long a wait still has to run, for a reading that is about the wait rather
// than about the instant it ends. Hours are the largest unit: a window measured
// in days is one an operator plans around rather than waits out, and "1d 3h"
// invites reading the leading number as the whole answer.
//
// Minutes round up, so a wait with any time left never reads as none left.
export const formatRemaining = (ms: number, locale: string): string => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return formatDurationUnit(minutes, 'minute', locale);
  return rest === 0
    ? formatDurationUnit(hours, 'hour', locale)
    : `${formatDurationUnit(hours, 'hour', locale)} ${formatDurationUnit(rest, 'minute', locale)}`;
};
