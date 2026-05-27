import type { PerformanceTelemetryRecord } from '../../repo/types.ts';
import { type HistogramBucket, percentileFromHistogramBuckets } from '../../shared/performance-histogram.ts';

export type PerformanceBucketGranularity = 'hour' | '4h' | '8h' | 'day' | 'all';
export type PerformanceGroupBy = 'none' | 'keyId' | 'model' | 'sourceApi' | 'targetApi' | 'runtimeLocation';

export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  totalMsSum: number;
  avgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface AggregateOptions {
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  timezoneOffsetMinutes: number;
}

interface MutableAggregate {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  totalMsSum: number;
  latencySamples: number;
  buckets: Map<string, HistogramBucket>;
}

export function aggregatePerformanceForDisplay(records: readonly PerformanceTelemetryRecord[], options: AggregateOptions): PerformanceDisplayRecord[] {
  const aggregates = new Map<string, MutableAggregate>();

  for (const record of records) {
    const bucket = displayBucket(record.hour, options);
    const group = displayGroup(record, options.groupBy);
    const key = `${bucket}\0${group}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        bucket,
        group,
        requests: 0,
        errors: 0,
        totalMsSum: 0,
        latencySamples: 0,
        buckets: new Map(),
      };
      aggregates.set(key, aggregate);
    }

    aggregate.requests += record.requests + record.errors;
    aggregate.errors += record.errors;
    aggregate.totalMsSum += record.totalMsSum;
    aggregate.latencySamples += record.requests;
    for (const bucket of record.buckets) {
      const bucketKey = `${bucket.lowerMs}\0${bucket.upperMs}`;
      const existing = aggregate.buckets.get(bucketKey);
      if (existing) {
        existing.count += bucket.count;
      } else {
        aggregate.buckets.set(bucketKey, { ...bucket });
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

function displayGroup(record: PerformanceTelemetryRecord, groupBy: PerformanceGroupBy): string {
  if (groupBy === 'none') return 'all';
  return String(record[groupBy]);
}

function toDisplayRecord(aggregate: MutableAggregate): PerformanceDisplayRecord {
  const buckets = [...aggregate.buckets.values()];
  return {
    bucket: aggregate.bucket,
    group: aggregate.group,
    requests: aggregate.requests,
    errors: aggregate.errors,
    totalMsSum: aggregate.totalMsSum,
    avgMs: aggregate.latencySamples > 0 ? aggregate.totalMsSum / aggregate.latencySamples : null,
    p50Ms: percentileFromHistogramBuckets(buckets, 0.5),
    p95Ms: percentileFromHistogramBuckets(buckets, 0.95),
    p99Ms: percentileFromHistogramBuckets(buckets, 0.99),
  };
}
