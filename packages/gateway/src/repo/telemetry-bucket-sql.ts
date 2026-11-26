import { parseTelemetryHour, TELEMETRY_HOUR_MS, telemetryBucketStart, telemetryHourKey } from '@floway-dev/protocols/common';

export type OverviewBucket = 'all'
  | { origin: string; hours: number }
  | { calendar: 'month' | 'year'; timezoneOffsetMinutes: number };

export type OverviewBucketId = string | number;

export const overviewBucketKey = (bucket: OverviewBucket, hour: string): string => {
  if (bucket === 'all') return 'all';
  const hourMs = parseTelemetryHour(hour);
  if ('calendar' in bucket) {
    return new Date(hourMs - bucket.timezoneOffsetMinutes * 60_000).toISOString().slice(0, bucket.calendar === 'month' ? 7 : 4);
  }
  return telemetryHourKey(telemetryBucketStart(hourMs, parseTelemetryHour(bucket.origin), bucket.hours));
};

export const overviewBucketId = (bucket: OverviewBucket, hour: string): OverviewBucketId => {
  if (bucket === 'all' || 'calendar' in bucket || bucket.hours === 1) return overviewBucketKey(bucket, hour);
  return Math.floor((parseTelemetryHour(hour) - parseTelemetryHour(bucket.origin)) / (bucket.hours * TELEMETRY_HOUR_MS));
};

export const overviewBucketSql = (bucket: OverviewBucket, hour: string): string => {
  if (bucket === 'all') return "'all'";
  if ('calendar' in bucket) {
    const format = bucket.calendar === 'month' ? '%Y-%m' : '%Y';
    return `strftime('${format}', unixepoch(${hour} || ':00:00Z') - settings.bucket_offset_seconds, 'unixepoch')`;
  }
  if (bucket.hours === 1) return hour;
  // Selected hours are at or after the grid origin, so truncating the quotient gives its floor.
  // https://sqlite.org/lang_expr.html#castexpr
  return `CAST((unixepoch(${hour} || ':00:00Z') - settings.bucket_origin) / settings.bucket_seconds AS INTEGER)`;
};

export const overviewBucketBinds = (bucket: OverviewBucket): readonly [number, number, number] => {
  if (bucket === 'all') return [0, 0, 0];
  if ('calendar' in bucket) return [0, 0, bucket.timezoneOffsetMinutes * 60];
  return [parseTelemetryHour(bucket.origin) / 1000, bucket.hours * TELEMETRY_HOUR_MS / 1000, 0];
};
