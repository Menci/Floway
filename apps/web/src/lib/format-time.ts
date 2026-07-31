const toDate = (value: string | number): Date => new Date(value);

export const shortDate = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(toDate(value));

export const dateTime = (value: string | number | null | undefined, locale: string): string =>
  value === null || value === undefined
    ? ''
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(toDate(value));

const RELATIVE_UNITS: [limitSeconds: number, perUnitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
];

// Null past the coarsest unit we express relatively (30 days), where callers
// read better with an absolute date than with "2 months ago". Symmetric about
// the reading: a timestamp in the future is as expressible as one in the past,
// which is what a token expiry or a rate-limit reset needs.
//
// `now` is an argument rather than a `Date.now()` read, so a list of rows all
// answer to one tick of `useNow` instead of each reading the clock mid-render.
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
