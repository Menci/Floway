import type { PerformanceDisplayRecord, PerformanceGroupBy, PerformanceMetric, PerformanceTelemetryRecord } from '../../src/repo/types.ts';
import { type HistogramBucket, percentileFromBuckets } from '../../src/shared/performance-histogram.ts';

export interface AggregateOptions {
  groupBy: PerformanceGroupBy;
  bucketForHour: (hour: string) => string;
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

const displayGroup = (
  record: PerformanceTelemetryRecord,
  options: AggregateOptions,
  keyToUser: ReadonlyMap<string, number>,
): string | null => {
  if (options.groupBy === 'none') return 'all';
  if (options.groupBy === 'userId') {
    const userId = keyToUser.get(record.keyId);
    return userId === undefined ? null : String(userId);
  }
  return String(record[options.groupBy]);
};

const updateAggregate = (
  aggregates: Map<string, MutableAggregate>,
  record: PerformanceTelemetryRecord,
  bucketFor: (hour: string) => string,
  options: AggregateOptions,
  keyToUser: ReadonlyMap<string, number>,
) => {
  const bucket = bucketFor(record.hour);
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
  for (const bucketRow of record.buckets) {
    const metricMap = aggregate.bucketsByMetric[bucketRow.metric];
    const existing = metricMap.get(String(bucketRow.lower));
    if (existing) existing.count += bucketRow.count;
    else metricMap.set(String(bucketRow.lower), { ...bucketRow });
  }
};

const toDisplayRecord = (aggregate: MutableAggregate): PerformanceDisplayRecord => {
  const ttftBuckets = [...aggregate.bucketsByMetric.ttft_ms.values()];
  const tpotBuckets = [...aggregate.bucketsByMetric.tpot_us.values()];
  return {
    bucket: aggregate.bucket,
    group: aggregate.group,
    requests: aggregate.requests,
    errors: aggregate.errorsWithOutput + aggregate.errorsNoOutput,
    ttftSamples: aggregate.ttftSamplesOk + aggregate.errorsWithOutput,
    tpotSamples: aggregate.tpotSamples,
    neutral: aggregate.neutral,
    ttftMsP50: percentileFromBuckets(ttftBuckets, 0.5),
    ttftMsP95: percentileFromBuckets(ttftBuckets, 0.95),
    ttftMsP99: percentileFromBuckets(ttftBuckets, 0.99),
    tpotUsP50: percentileFromBuckets(tpotBuckets, 0.5),
    tpotUsP95: percentileFromBuckets(tpotBuckets, 0.95),
    tpotUsP99: percentileFromBuckets(tpotBuckets, 0.99),
  };
};

export const aggregatePerformanceForDisplay = <K extends string>(
  records: readonly PerformanceTelemetryRecord[],
  axes: Record<K, AggregateOptions>,
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
): Record<K, PerformanceDisplayRecord[]> => {
  const entries = Object.entries(axes) as [K, AggregateOptions][];
  const maps = entries.map(() => new Map<string, MutableAggregate>());
  const bucketResolvers = entries.map(([, options]) => options.bucketForHour);
  for (const record of records) {
    for (let index = 0; index < entries.length; index++) {
      const options = entries[index][1];
      if (options.groupBy === 'keyId' && !visibleKeyIds.has(record.keyId)) continue;
      updateAggregate(maps[index], record, bucketResolvers[index], options, keyToUser);
    }
  }
  const result = {} as Record<K, PerformanceDisplayRecord[]>;
  for (let index = 0; index < entries.length; index++) {
    result[entries[index][0]] = [...maps[index].values()]
      .map(toDisplayRecord)
      .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.group.localeCompare(right.group));
  }
  return result;
};
