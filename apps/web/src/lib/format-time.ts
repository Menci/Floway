import { NO_READING } from './no-reading';

const toDate = (value: string | number): Date => new Date(value);

export const formatDateParts = (parts: Intl.DateTimeFormatPart[]): string =>
  parts.map(part => part.type === 'literal' || part.type === 'month' ? part.value.replace(/[年月日]/g, ' $& ') : part.value).join('').replace(/ +/g, ' ').trim();

export const formatDate = (date: Date, locale: string, options: Intl.DateTimeFormatOptions): string =>
  formatDateParts(new Intl.DateTimeFormat(locale, options).formatToParts(date));

export const shortDate = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? NO_READING
    : formatDate(toDate(value), locale, { dateStyle: 'medium' });

export const dateTime = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? NO_READING
    : formatDate(toDate(value), locale, { dateStyle: 'medium', timeStyle: 'medium' });

const RELATIVE_UNITS: [limitSeconds: number, perUnitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
];

// Null past 30 days, where callers read better with an absolute date.
// `now` is an argument so a list of rows answers to one tick of `useNow`.
export const relativeTime = (
  value: string | number,
  locale: string,
  { now, style = 'long' }: { now: number; style?: Intl.RelativeTimeFormatStyle },
): string | null => {
  const deltaSeconds = Math.round((toDate(value).getTime() - now) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  const match = RELATIVE_UNITS.find(([limit]) => magnitude < limit);
  if (!match) return null;
  const [, perUnit, unit] = match;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style }).format(Math.round(deltaSeconds / perUnit), unit);
};
