import { calendarDate, nextCalendarDate, parseCalendarDate, validateCalendarRange, type CalendarDateRange } from '../../lib/calendar-date';
import { numericDateTime, numericTime } from '../../lib/format-time';
import {
  createTelemetryBucket,
  TELEMETRY_HOUR_MS,
  telemetryHourKey,
  type TelemetryBucketGranularity,
} from '@floway-dev/protocols/browser';

export type DashboardPreset = 'today' | '7d' | '30d';
export type DashboardRange = DashboardPreset | CalendarDateRange;
export type DashboardGranularity = Exclude<TelemetryBucketGranularity, 'all'>;

export interface DashboardBucketFrame {
  date: Date;
  key: string;
  start: number;
  end: number;
}

export interface ChartBucket extends DashboardBucketFrame { label: string }

const local4hStart = (date: Date) => {
  const aligned = new Date(date);
  aligned.setMinutes(0, 0, 0);
  aligned.setHours(aligned.getHours() - aligned.getHours() % 4);
  return aligned;
};
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const AUTO_BUCKET_TARGET = 48;
const AUTO_GRANULARITIES: DashboardGranularity[] = ['hour', '4h', '8h', 'day', 'week', 'month', 'year'];

export const validateDashboardInterval = (start: number, end: number): void => {
  telemetryHourKey(start);
  telemetryHourKey(end);
  if (start >= end) throw new RangeError('The end of a telemetry interval must be later than its start');
};

export const dashboardInterval = (range: DashboardRange, nowMs: number): { start: number; end: number } => {
  if (typeof range !== 'string') {
    validateCalendarRange(range);
    return {
      start: Math.ceil(parseCalendarDate(range.start).getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS,
      end: Math.ceil(parseCalendarDate(nextCalendarDate(range.end)).getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS,
    };
  }
  const end = Math.floor(nowMs / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS + TELEMETRY_HOUR_MS;
  if (range === 'today') return { start: end - 24 * TELEMETRY_HOUR_MS, end };
  const start = range === '7d' ? local4hStart(new Date(nowMs)) : new Date(nowMs);
  if (range === '7d') start.setHours(start.getHours() - 41 * 4);
  else {
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);
  }
  return { start: Math.ceil(start.getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS, end };
};

export const dashboardRangeIsCurrent = (range: DashboardRange, nowMs: number): boolean => {
  if (typeof range === 'string') return true;
  const today = calendarDate(new Date(nowMs));
  return range.start <= today && today <= range.end;
};

export const sameDashboardRange = (left: DashboardRange, right: DashboardRange): boolean =>
  typeof left === 'string' || typeof right === 'string'
    ? left === right
    : left.start === right.start && left.end === right.end;

const floorCalendarBucket = (ms: number, granularity: DashboardGranularity): Date => {
  const date = new Date(ms);
  if (granularity === 'hour') return new Date(Math.floor(ms / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS);
  date.setMinutes(0, 0, 0);
  if (granularity === '4h' || granularity === '8h') {
    const hours = granularity === '4h' ? 4 : 8;
    date.setHours(date.getHours() - date.getHours() % hours);
  } else {
    date.setHours(0, 0, 0, 0);
    if (granularity === 'week') date.setDate(date.getDate() - (date.getDay() + 6) % 7);
    if (granularity === 'month') date.setDate(1);
    if (granularity === 'year') date.setMonth(0, 1);
  }
  return date;
};

const nextCalendarBucket = (date: Date, granularity: DashboardGranularity): Date => {
  const next = new Date(date);
  if (granularity === 'hour') return new Date(date.getTime() + TELEMETRY_HOUR_MS);
  if (granularity === '4h' || granularity === '8h') next.setHours(next.getHours() + (granularity === '4h' ? 4 : 8));
  else if (granularity === 'day' || granularity === 'week') next.setDate(next.getDate() + (granularity === 'day' ? 1 : 7));
  else if (granularity === 'month') next.setMonth(next.getMonth() + 1);
  else next.setFullYear(next.getFullYear() + 1);
  return next;
};

const framesForInterval = (
  interval: { start: number; end: number },
  granularity: DashboardGranularity,
  limit = Infinity,
): DashboardBucketFrame[] => {
  const keyForHour = createTelemetryBucket({
    bucket: granularity,
    timeZone: granularity === 'hour' ? 'UTC' : timeZone(),
    timezoneOffsetMinutes: 0,
  });
  const frames: DashboardBucketFrame[] = [];
  let date = floorCalendarBucket(interval.start, granularity);
  while (date.getTime() < interval.end) {
    const next = nextCalendarBucket(date, granularity);
    const start = Math.max(interval.start, Math.ceil(date.getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS);
    const end = Math.min(interval.end, Math.ceil(next.getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS);
    if (start < end) {
      frames.push({ date: new Date(start), key: keyForHour(telemetryHourKey(start)), start, end });
      if (frames.length > limit) break;
    }
    date = next;
  }
  return frames;
};

export const dashboardGranularity = (range: DashboardRange, nowMs: number): DashboardGranularity => {
  if (typeof range === 'string') return range === 'today' ? 'hour' : range === '7d' ? '4h' : 'day';
  const interval = dashboardInterval(range, nowMs);
  for (const granularity of AUTO_GRANULARITIES) {
    if (framesForInterval(interval, granularity, AUTO_BUCKET_TARGET).length <= AUTO_BUCKET_TARGET) return granularity;
  }
  return 'year';
};

export const dashboardBucketFrames = (range: DashboardRange, nowMs: number): DashboardBucketFrame[] =>
  framesForInterval(dashboardInterval(range, nowMs), dashboardGranularity(range, nowMs));

export const dashboardRangeQuery = (range: DashboardRange, nowMs: number) => {
  const interval = dashboardInterval(range, nowMs);
  const bucket = dashboardGranularity(range, nowMs);
  const utcHours = bucket === 'hour';
  return {
    start: telemetryHourKey(interval.start),
    end: telemetryHourKey(interval.end),
    bucket,
    timezone: utcHours ? 'UTC' : timeZone(),
    timezone_offset_minutes: utcHours ? '0' : String(new Date(nowMs).getTimezoneOffset()),
  };
};

export const dashboardBucketMapper = (range: DashboardRange, nowMs: number) => {
  const query = dashboardRangeQuery(range, nowMs);
  return createTelemetryBucket({ bucket: query.bucket, timeZone: query.timezone, timezoneOffsetMinutes: Number(query.timezone_offset_minutes) });
};

export const parseDashboardRange = (search: URLSearchParams): DashboardRange => {
  if (search.get('r') === 'custom') {
    const range = { start: search.get('start') ?? '', end: search.get('end') ?? '' };
    validateCalendarRange(range);
    return range;
  }
  const range = search.get('r');
  return range === '7d' || range === '30d' ? range : 'today';
};

export const serializeDashboardRange = (search: URLSearchParams, range: DashboardRange): void => {
  if (typeof range === 'string') {
    if (range !== 'today') search.set('r', range);
  } else {
    validateCalendarRange(range);
    search.set('r', 'custom');
    search.set('start', range.start);
    search.set('end', range.end);
  }
};

export const chartTickValues = <T extends { date: Date }>(buckets: T[], desired = 7): T[] => {
  if (buckets.length <= 8) return buckets;
  const count = Math.min(desired, buckets.length);
  return Array.from({ length: count }, (_, index) => buckets[Math.round(index * (buckets.length - 1) / (count - 1))]!);
};

export const formatAxisDate = numericDateTime;

export const formatBucketInterval = (frame: DashboardBucketFrame): string => {
  const start = new Date(frame.start);
  const end = new Date(frame.end);
  return `${numericDateTime(start)} - ${calendarDate(start) === calendarDate(end) ? numericTime(end) : numericDateTime(end)}`;
};

export const formatCalloutTitle = (
  value: Date | number | string,
  labels: ReadonlyMap<number, string>,
  locale: string,
) => value instanceof Date
  ? labels.get(value.getTime()) ?? formatAxisDate(value)
  : typeof value === 'number' ? value.toLocaleString(locale) : value;
