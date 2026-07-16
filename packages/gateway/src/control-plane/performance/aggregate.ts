import type { PerformanceMetric, PerformanceTelemetryRecord } from '../../repo/types.ts';
import { type HistogramBucket, percentileFromBuckets } from '../../shared/performance-histogram.ts';

export type PerformanceBucketGranularity = 'hour' | '4h' | '8h' | 'day' | 'all';
export type PerformanceGroupBy = 'none' | 'keyId' | 'userId' | 'model' | 'upstream' | 'operation' | 'runtimeLocation';

export interface PerformanceDisplayRecord {
  bucket: string;
  group: string;
  requests: number;
  errors: number;
  ttftSamples: number;
  tpotSamples: number;
  neutral: number;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  ttftMsP99: number | null;
  tpotUsP50: number | null;
  tpotUsP95: number | null;
  tpotUsP99: number | null;
}

export interface AggregateOptions {
  bucket: PerformanceBucketGranularity;
  groupBy: PerformanceGroupBy;
  timezoneOffsetMinutes: number;
}

interface MutableAggregate {
  bucket: string;
  group: string;
  requests: number;
  ttftSamplesOk: number;
  errorsWithOutput: number;
  errorsNoOutput: number;
  neutral: number;
  tpotSamples: number;
  bucketsByMetric: Record<PerformanceMetric, Map<string, HistogramBucket>>;
}

const displayBucket = (hour: string, options: Pick<AggregateOptions, 'bucket' | 'timezoneOffsetMinutes'>): string => {
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
};

const displayGroup = (record: PerformanceTelemetryRecord, options: AggregateOptions, keyToUser: ReadonlyMap<string, number>): string | null => {
  if (options.groupBy === 'none') return 'all';
  if (options.groupBy === 'userId') {
    const userId = keyToUser.get(record.keyId);
    // Drop, don't collapse — userId 0 is a valid real user.
    if (userId === undefined) return null;
    return String(userId);
  }
  return String(record[options.groupBy]);
};

const updateAggregate = (aggregates: Map<string, MutableAggregate>, record: PerformanceTelemetryRecord, options: AggregateOptions, keyToUser: ReadonlyMap<string, number>): void => {
  const bucket = displayBucket(record.hour, options);
  const group = displayGroup(record, options, keyToUser);
  if (group === null) return;
  const key = `${bucket}\0${group}`;
  let aggregate = aggregates.get(key);
  if (!aggregate) {
    aggregate = {
      bucket,
      group,
      requests: 0,
      ttftSamplesOk: 0,
      errorsWithOutput: 0,
      errorsNoOutput: 0,
      neutral: 0,
      tpotSamples: 0,
      bucketsByMetric: { ttft_ms: new Map(), tpot_us: new Map() },
    };
    aggregates.set(key, aggregate);
  }
  aggregate.requests += record.requests;
  aggregate.ttftSamplesOk += record.ttftSamplesOk;
  aggregate.errorsWithOutput += record.errorsWithOutput;
  aggregate.errorsNoOutput += record.errorsNoOutput;
  aggregate.neutral += record.neutral;
  aggregate.tpotSamples += record.tpotSamples;
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
};

const toDisplayRecord = (a: MutableAggregate): PerformanceDisplayRecord => {
  const ttftBuckets = [...a.bucketsByMetric.ttft_ms.values()];
  const tpotBuckets = [...a.bucketsByMetric.tpot_us.values()];
  return {
    bucket: a.bucket,
    group: a.group,
    requests: a.requests,
    // Partial-output failures are counted in both `errors` and `ttftSamples` by design.
    errors: a.errorsWithOutput + a.errorsNoOutput,
    ttftSamples: a.ttftSamplesOk + a.errorsWithOutput,
    tpotSamples: a.tpotSamples,
    neutral: a.neutral,
    ttftMsP50: percentileFromBuckets(ttftBuckets, 0.5),
    ttftMsP95: percentileFromBuckets(ttftBuckets, 0.95),
    ttftMsP99: percentileFromBuckets(ttftBuckets, 0.99),
    tpotUsP50: percentileFromBuckets(tpotBuckets, 0.5),
    tpotUsP95: percentileFromBuckets(tpotBuckets, 0.95),
    tpotUsP99: percentileFromBuckets(tpotBuckets, 0.99),
  };
};

// One-pass multi-axis aggregator. The dashboard overview asks for the same
// records aggregated along 6-8 different (bucket, groupBy) axes; running a
// single-axis loop once per axis walks the record set N times with an
// identical outer traversal. This visits each record once and updates every
// axis's Map in-place, then finalizes them into per-axis display arrays.
export const aggregatePerformanceForDisplay = <K extends string>(
  records: readonly PerformanceTelemetryRecord[],
  axes: Record<K, AggregateOptions>,
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
): Record<K, PerformanceDisplayRecord[]> => {
  const entries = Object.entries(axes) as [K, AggregateOptions][];
  const maps = entries.map(() => new Map<string, MutableAggregate>());
  for (const record of records) {
    for (let i = 0; i < entries.length; i++) {
      const options = entries[i][1];
      if (options.groupBy === 'keyId' && !visibleKeyIds.has(record.keyId)) continue;
      updateAggregate(maps[i], record, options, keyToUser);
    }
  }
  const result = {} as Record<K, PerformanceDisplayRecord[]>;
  for (let i = 0; i < entries.length; i++) {
    result[entries[i][0]] = [...maps[i].values()]
      .map(toDisplayRecord)
      .sort((a, b) => a.bucket.localeCompare(b.bucket) || a.group.localeCompare(b.group));
  }
  return result;
};
