import type { PerformanceMetric, PerformanceTelemetryRecord } from '../../repo/types.ts';
import { type HistogramBucket, percentileFromBuckets } from '../../shared/performance-histogram.ts';

export type PerformanceBucketGranularity = 'hour' | '4h' | '8h' | 'day' | 'all';
export type PerformanceGroupBy = 'none' | 'keyId' | 'userId' | 'model' | 'upstream' | 'runtimeLocation';

export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  samples: number;
  ttftMsAvg: number | null;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  ttftMsP99: number | null;
  tpotUsAvg: number | null;
  tpotUsP50: number | null;
  tpotUsP95: number | null;
  tpotUsP99: number | null;
}

type AggregateOptions =
  | {
    bucket: PerformanceBucketGranularity;
    groupBy: Exclude<PerformanceGroupBy, 'userId'>;
    timezoneOffsetMinutes: number;
  }
  | {
    bucket: PerformanceBucketGranularity;
    groupBy: 'userId';
    timezoneOffsetMinutes: number;
    // Records whose keyId no longer resolves (operator hard-deleted the key)
    // collapse into synthetic userId 0; soft-deleted keys still resolve
    // because keyToUser includes them.
    keyToUser: ReadonlyMap<string, number>;
  };

interface MutableAggregate {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  samples: number;
  ttftMsSum: number;
  tpotUsSum: number;
  bucketsByMetric: Record<PerformanceMetric, Map<string, HistogramBucket>>;
}

export function aggregatePerformanceForDisplay(records: readonly PerformanceTelemetryRecord[], options: AggregateOptions): PerformanceDisplayRecord[] {
  const aggregates = new Map<string, MutableAggregate>();

  for (const record of records) {
    const bucket = displayBucket(record.hour, options);
    const group = displayGroup(record, options);
    const key = `${bucket}\0${group}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        bucket,
        group,
        requests: 0,
        errors: 0,
        samples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        bucketsByMetric: { ttft_ms: new Map(), tpot_us: new Map() },
      };
      aggregates.set(key, aggregate);
    }

    aggregate.requests += record.requests;
    aggregate.errors += record.errors;
    aggregate.samples += record.samples;
    aggregate.ttftMsSum += record.ttftMsSum;
    aggregate.tpotUsSum += record.tpotUsSum;
    for (const b of record.buckets) {
      const metricMap = aggregate.bucketsByMetric[b.metric];
      const bucketKey = String(b.lower);
      const existing = metricMap.get(bucketKey);
      if (existing) {
        existing.count += b.count;
      } else {
        metricMap.set(bucketKey, { lower: b.lower, upper: b.upper, count: b.count });
      }
    }
  }

  return [...aggregates.values()].map(toDisplayRecord).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.group.localeCompare(b.group));
}

function displayBucket(hour: string, options: Pick<AggregateOptions, 'bucket' | 'timezoneOffsetMinutes'>): string {
  if (options.bucket === 'all') return 'all';
  const utcMs = Date.parse(`${hour}:00:00Z`);
  const localMs = utcMs - options.timezoneOffsetMinutes * 60_000;
  const localIso = new Date(localMs).toISOString();
  if (options.bucket === 'hour') return localIso.slice(0, 13);
  if (options.bucket === 'day') return localIso.slice(0, 10);
  const hourOfDay = Number(localIso.slice(11, 13));
  const divisor = options.bucket === '4h' ? 4 : 8;
  const aligned = hourOfDay - (hourOfDay % divisor);
  return `${localIso.slice(0, 11)}${String(aligned).padStart(2, '0')}`;
}

function displayGroup(record: PerformanceTelemetryRecord, options: AggregateOptions): string {
  if (options.groupBy === 'none') return 'all';
  if (options.groupBy === 'userId') {
    const userId = options.keyToUser.get(record.keyId) ?? 0;
    return String(userId);
  }
  return String(record[options.groupBy]);
}

function toDisplayRecord(a: MutableAggregate): PerformanceDisplayRecord {
  const ttftBuckets = [...a.bucketsByMetric.ttft_ms.values()];
  const tpotBuckets = [...a.bucketsByMetric.tpot_us.values()];
  const hasSamples = a.samples > 0;
  return {
    bucket: a.bucket,
    group: a.group,
    requests: a.requests,
    errors: a.errors,
    samples: a.samples,
    ttftMsAvg: hasSamples ? a.ttftMsSum / a.samples : null,
    ttftMsP50: percentileFromBuckets(ttftBuckets, 0.5),
    ttftMsP95: percentileFromBuckets(ttftBuckets, 0.95),
    ttftMsP99: percentileFromBuckets(ttftBuckets, 0.99),
    tpotUsAvg: hasSamples ? a.tpotUsSum / a.samples : null,
    tpotUsP50: percentileFromBuckets(tpotBuckets, 0.5),
    tpotUsP95: percentileFromBuckets(tpotBuckets, 0.95),
    tpotUsP99: percentileFromBuckets(tpotBuckets, 0.99),
  };
}
