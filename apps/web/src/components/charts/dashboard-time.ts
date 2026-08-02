export type DashboardRange = 'today' | '7d' | '30d';

export interface DashboardBucketFrame {
  date: Date;
  key: string;
}

// The label is locale- and page-dependent, so the consumer supplies it.
export interface ChartBucket extends DashboardBucketFrame { label: string }

const pad2 = (value: number) => String(value).padStart(2, '0');
const localHourKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}`;
const localDateKey = (date: Date) =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const local4hStart = (date: Date) => {
  const aligned = new Date(date);
  aligned.setMinutes(0, 0, 0);
  aligned.setHours(aligned.getHours() - (aligned.getHours() % 4));
  return aligned;
};

export const dashboardBucketFrames = (range: DashboardRange, nowMs: number): DashboardBucketFrame[] => {
  if (range === 'today') {
    const current = new Date(nowMs);
    current.setMinutes(0, 0, 0);
    return Array.from({ length: 24 }, (_, index) => {
      const date = new Date(current.getTime() - (23 - index) * 3_600_000);
      return { key: localHourKey(date), date };
    });
  }
  if (range === '7d') {
    const current = local4hStart(new Date(nowMs));
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(current.getTime() - (41 - index) * 4 * 3_600_000);
      return { key: localHourKey(date), date };
    });
  }
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - (29 - index));
    date.setHours(0, 0, 0, 0);
    return { key: localDateKey(date), date };
  });
};

export const dashboardRangeQuery = (range: DashboardRange, nowMs: number) => {
  const now = new Date(nowMs);
  const start = dashboardBucketFrames(range, nowMs)[0]!.date;
  return {
    start: start.toISOString().slice(0, 13),
    end: new Date(now.getTime() + 3_600_000).toISOString().slice(0, 13),
    bucket: range === 'today' ? 'hour' as const : range === '7d' ? '4h' as const : 'day' as const,
  };
};

export const dashboardBucketKeyForUtcHour = (range: DashboardRange, hour: string) => {
  const date = new Date(`${hour}:00:00Z`);
  if (range === 'today') return localHourKey(date);
  if (range === '7d') return localHourKey(local4hStart(date));
  return localDateKey(date);
};

export const chartTickValues = <T extends { date: Date }>(buckets: T[], desired = 7): T[] => {
  if (buckets.length <= 8) return buckets;
  const step = Math.ceil((buckets.length - 1) / (desired - 1));
  const ticks = buckets.filter((_, index) => index % step === 0);
  const last = buckets.at(-1);
  if (last && ticks.at(-1) !== last) ticks.push(last);
  return ticks;
};

// All three ranges go through `toLocaleString`: `toLocaleDateString` renders
// the hour too, but `hour: '2-digit'` under a 12-hour clock produces `04 AM`.
const AXIS_PARTS: Record<DashboardRange, Intl.DateTimeFormatOptions> = {
  'today': { hour: '2-digit', minute: '2-digit' },
  '7d': { month: 'short', day: 'numeric', hour: 'numeric' },
  '30d': { month: 'short', day: 'numeric' },
};

export const formatAxisDate = (date: Date, range: DashboardRange, locale: string) =>
  date.toLocaleString(locale, AXIS_PARTS[range]);

export const formatCalloutTitle = (
  value: Date | number | string,
  labels: ReadonlyMap<number, string>,
  range: DashboardRange,
  locale: string,
) => value instanceof Date
  ? labels.get(value.getTime()) ?? formatAxisDate(value, range, locale)
  : typeof value === 'number' ? value.toLocaleString(locale) : value;
