import { NO_READING } from './no-reading';

const toDate = (value: string | number): Date => new Date(value);

export const formatDateParts = (parts: Intl.DateTimeFormatPart[]): string =>
  parts.map(part => part.type === 'literal' || part.type === 'month' ? part.value.replace(/[年月日]/g, ' $& ') : part.value).join('').replace(/ +/g, ' ').trim();

export const formatDate = (date: Date, locale: string, options: Intl.DateTimeFormatOptions): string =>
  formatDateParts(new Intl.DateTimeFormat(locale, options).formatToParts(date));

const twoDigits = (value: number): string => String(value).padStart(2, '0');

export const numericDate = (date: Date, includeYear = false): string =>
  `${includeYear ? `${String(date.getFullYear()).padStart(4, '0')}/` : ''}${twoDigits(date.getMonth() + 1)}/${twoDigits(date.getDate())}`;

export const numericTime = (date: Date): string => `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;

export const numericDateTime = (date: Date): string => `${numericDate(date)} ${numericTime(date)}`;

const numericClockTime = (date: Date): string => `${numericTime(date)}:${twoDigits(date.getSeconds())}`;

// Chinese writes dates and durations with unit words, and separates the number
// from its word with a space, as the message catalog does (`{{count}} 天`).
// Every other locale keeps the pattern its readers already expect from `Intl`.
const isChinese = (locale: string): boolean => locale.startsWith('zh');

export const shortDate = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? NO_READING
    : isChinese(locale)
      ? numericDate(toDate(value), true)
      : formatDate(toDate(value), locale, { dateStyle: 'medium' });

export const dateTime = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? NO_READING
    : isChinese(locale)
      ? `${numericDate(toDate(value), true)} ${numericClockTime(toDate(value))}`
      : formatDate(toDate(value), locale, { dateStyle: 'medium', timeStyle: 'medium' });

const RELATIVE_UNITS: [limitSeconds: number, perUnitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
];

// `Intl.RelativeTimeFormat` keeps the number and the unit word together
// (`1小时前`); a Chinese reader expects the same space the catalog uses. A
// phrase with no number (`昨天`) has no word to separate, so it stays whole.
const spaceChineseUnit = (formatter: Intl.RelativeTimeFormat, value: number, unit: Intl.RelativeTimeFormatUnit): string =>
  formatter.formatToParts(value, unit)
    .map((part, index, parts) => part.type === 'integer' && parts[index + 1]?.type === 'literal' ? `${part.value} ` : part.value)
    .join('');

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
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
  const rounded = Math.round(deltaSeconds / perUnit);
  return isChinese(locale) ? spaceChineseUnit(formatter, rounded, unit) : formatter.format(rounded, unit);
};
