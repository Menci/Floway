export interface PricingTimeWindowCoordinate {
  readonly timeZone: string;
  // ISO weekdays: Monday = 1, Sunday = 7. Times are local, start-inclusive,
  // end-exclusive. Split overnight windows at midnight (24:00 is a valid end).
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly excludedDates?: readonly string[];
}

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const canonicalPricingTimeWindow = (value: unknown, path: string): PricingTimeWindowCoordinate => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be a time window object`);
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(key => !['timeZone', 'weekdays', 'start', 'end', 'excludedDates'].includes(key));
  if (unknownKeys.length > 0) throw new RangeError(`${path} has unknown fields: ${unknownKeys.join(', ')}`);
  if (typeof record.timeZone !== 'string' || !record.timeZone) throw new TypeError(`${path}.timeZone must be a time zone name`);
  const timeZone = record.timeZone;
  // Validate without rewriting aliases: selector keys must survive different ICU versions.
  Intl.DateTimeFormat('en', { timeZone });
  if (!Array.isArray(record.weekdays) || record.weekdays.length === 0 || record.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RangeError(`${path}.weekdays must contain ISO weekdays (1–7)`);
  }
  const { start, end } = record;
  if (typeof start !== 'string' || !clockPattern.test(start) || typeof end !== 'string' || (!clockPattern.test(end) && end !== '24:00') || minutes(start) >= minutes(end)) {
    throw new RangeError(`${path} must have HH:mm times with start < end; split overnight windows at midnight`);
  }
  const dates = record.excludedDates === undefined ? [] : record.excludedDates;
  if (!Array.isArray(dates) || dates.some(date => typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    throw new RangeError(`${path}.excludedDates must contain valid YYYY-MM-DD dates in the window's time zone`);
  }
  return {
    timeZone,
    weekdays: [...new Set(record.weekdays as number[])].toSorted((a, b) => a - b),
    start,
    end,
    ...(dates.length > 0 ? { excludedDates: [...new Set(dates as string[])].toSorted() } : {}),
  };
};

export const pricingTimeWindowsOverlap = (a: PricingTimeWindowCoordinate, b: PricingTimeWindowCoordinate): boolean =>
  a.weekdays.some(day => b.weekdays.includes(day)) && minutes(a.start) < minutes(b.end) && minutes(b.start) < minutes(a.end);

export const compilePricingTimeWindow = (window: PricingTimeWindowCoordinate): ((timestamp: number) => boolean) => {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: window.timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const excluded = new Set(window.excludedDates);
  const start = minutes(window.start);
  const end = minutes(window.end);
  return timestamp => {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return window.weekdays.includes(weekday) && !excluded.has(date) && minute >= start && minute < end;
  };
};
