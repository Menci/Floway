const toDate = (value: string | number): Date => new Date(value);

export const shortDate = (value: string | number | null | undefined): string =>
  value === null || value === undefined
    ? ''
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(toDate(value));

export const dateTime = (value: string | number | null | undefined): string =>
  value === null || value === undefined
    ? ''
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(toDate(value));

const RELATIVE_UNITS: [limitSeconds: number, perUnitSeconds: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
];

// Null past the coarsest unit we express relatively (30 days), where callers
// read better with an absolute date than with "2 months ago".
export const relativeTime = (value: string | number): string | null => {
  const deltaSeconds = Math.round((toDate(value).getTime() - Date.now()) / 1000);
  const magnitude = Math.abs(deltaSeconds);
  const match = RELATIVE_UNITS.find(([limit]) => magnitude < limit);
  if (!match) return null;
  const [, perUnit, unit] = match;
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(deltaSeconds / perUnit), unit);
};
