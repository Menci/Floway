import { PricingHolidayCalendarRequiredError, pricingHolidayDate, type PricingHolidayCalendar, type PricingHolidayFacts } from './pricing-holidays.ts';

export interface PricingTimeWindowCoordinate {
  readonly timeZone: string;
  // ISO weekdays: Monday = 1, Sunday = 7. Times are local, start-inclusive,
  // end-exclusive. An end before the start wraps midnight; equal times mean
  // all day. Weekdays are evaluated at the request instant, including the
  // after-midnight portion, as in OpenRouter's utc_days conditions.
  // https://openrouter.ai/docs/guides/overview/models#pricing-object
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly excludeHolidays?: PricingHolidayCalendar;
}

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const clockPattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export const canonicalPricingTimeWindow = (value: unknown, path: string): PricingTimeWindowCoordinate => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${path} must be a time window object`);
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(key => !['timeZone', 'weekdays', 'start', 'end', 'excludeHolidays'].includes(key));
  if (unknownKeys.length > 0) throw new RangeError(`${path} has unknown fields: ${unknownKeys.join(', ')}`);
  if (typeof record.timeZone !== 'string' || !record.timeZone) throw new TypeError(`${path}.timeZone must be a time zone name`);
  const timeZone = record.timeZone;
  // Validate without rewriting aliases: selector keys must survive different ICU versions.
  Intl.DateTimeFormat('en', { timeZone });
  if (!Array.isArray(record.weekdays) || record.weekdays.length === 0 || record.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new RangeError(`${path}.weekdays must contain ISO weekdays (1–7)`);
  }
  const { start, end } = record;
  if (typeof start !== 'string' || !clockPattern.test(start) || typeof end !== 'string' || (!clockPattern.test(end) && end !== '24:00')) {
    throw new RangeError(`${path} must have HH:mm times; 24:00 is allowed as the end`);
  }
  if (record.excludeHolidays !== undefined && record.excludeHolidays !== 'CN') {
    throw new RangeError(`${path}.excludeHolidays must be a supported holiday calendar (CN)`);
  }
  return {
    timeZone,
    weekdays: [...new Set(record.weekdays as number[])].toSorted((a, b) => a - b),
    start,
    end,
    ...(record.excludeHolidays === 'CN' ? { excludeHolidays: 'CN' } : {}),
  };
};

const intervals = (window: PricingTimeWindowCoordinate): readonly (readonly [number, number])[] => {
  const start = minutes(window.start);
  const end = minutes(window.end);
  if (start === end) return [[0, 1440]];
  return start < end ? [[start, end]] : [[start, 1440], [0, end]];
};

export const pricingTimeWindowsOverlap = (a: PricingTimeWindowCoordinate, b: PricingTimeWindowCoordinate): boolean =>
  a.weekdays.some(day => b.weekdays.includes(day))
  && intervals(a).some(([startA, endA]) => intervals(b).some(([startB, endB]) => startA < endB && startB < endA));

export const compilePricingTimeWindow = (window: PricingTimeWindowCoordinate): ((timestamp: number, holidays?: PricingHolidayFacts) => boolean) => {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: window.timeZone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const clockIntervals = intervals(window);
  return (timestamp, holidays) => {
    const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    if (!window.weekdays.includes(weekday) || !clockIntervals.some(([start, end]) => minute >= start && minute < end)) return false;
    if (window.excludeHolidays !== undefined) {
      const holidayDate = pricingHolidayDate(timestamp);
      const fact = holidays?.[window.excludeHolidays];
      if (fact?.date !== holidayDate || typeof fact.isHoliday !== 'boolean') throw new PricingHolidayCalendarRequiredError(window.excludeHolidays, holidayDate);
      if (fact.isHoliday) return false;
    }
    return true;
  };
};
