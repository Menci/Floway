import type { UsageRecord } from '../../repo/types.ts';
import { createTelemetryBucket, type TelemetryBucketGranularity } from '../shared/telemetry-bucket.ts';
import { addDecimalStrings, multiplyDecimalStrings, tokenUsageUnattributedUserId, usageUpstreamDimensionValue, type BillingMetric, type DecimalString } from '@floway-dev/protocols/common';

export interface DisplayUsageMetric {
  metric: BillingMetric;
  quantity: DecimalString;
}

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  metrics: DisplayUsageMetric[];
  cost: DecimalString | null;
}

export interface DisplayUsageByUserRecord {
  userId: number;
  model: string;
  hour: string;
  requests: number;
  metrics: DisplayUsageMetric[];
  cost: DecimalString | null;
}

export type UsageOverviewGroupBy = 'keyId' | 'userId' | 'model' | 'upstream';

export interface UsageOverviewRecord {
  bucket: string;
  group: string;
  requests: number;
  metrics: DisplayUsageMetric[];
  cost: DecimalString | null;
}

export interface UsageOverviewAggregateOptions {
  bucket: TelemetryBucketGranularity;
  groupBy: UsageOverviewGroupBy | 'none';
  timeZone?: string;
  timezoneOffsetMinutes: number;
}

const recordCostUsd = (record: UsageRecord): DecimalString | null => {
  let total: DecimalString = '0';
  let priced = false;
  for (const row of record.metrics) {
    if (row.unitPrice === null) continue;
    total = addDecimalStrings(total, multiplyDecimalStrings(row.quantity, row.unitPrice));
    priced = true;
  }
  return priced ? total : null;
};

const accumulate = (
  bucket: { requests: number; cost: DecimalString | null; metrics: DisplayUsageMetric[] },
  record: UsageRecord,
) => {
  bucket.requests += record.requests;
  const cost = recordCostUsd(record);
  if (cost !== null) bucket.cost = addDecimalStrings(bucket.cost ?? '0', cost);
  for (const row of record.metrics) {
    const existing = bucket.metrics.find(candidate => candidate.metric === row.metric);
    if (existing) existing.quantity = addDecimalStrings(existing.quantity, row.quantity);
    else bucket.metrics.push({ metric: row.metric, quantity: row.quantity });
  }
};

interface UsageDisplayFields {
  model: string;
  hour: string;
  requests: number;
  metrics: DisplayUsageMetric[];
  cost: DecimalString | null;
}

const aggregateUsage = <Coordinate extends object>(
  records: readonly UsageRecord[],
  coordinateFor: (record: UsageRecord) => { key: string; fields: Coordinate },
  compare: (left: UsageDisplayFields & Coordinate, right: UsageDisplayFields & Coordinate) => number,
): Array<UsageDisplayFields & Coordinate> => {
  const buckets = new Map<string, UsageDisplayFields & Coordinate>();
  for (const record of records) {
    const coordinate = coordinateFor(record);
    let existing = buckets.get(coordinate.key);
    if (!existing) {
      existing = {
        ...coordinate.fields,
        model: record.model,
        hour: record.hour,
        requests: 0,
        metrics: [],
        cost: null,
      };
      buckets.set(coordinate.key, existing);
    }
    accumulate(existing, record);
  }
  return [...buckets.values()].sort(compare);
};

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  return aggregateUsage(
    records,
    record => ({ key: `${record.keyId}\0${record.model}\0${record.hour}`, fields: { keyId: record.keyId } }),
    (left, right) => left.hour.localeCompare(right.hour) || left.keyId.localeCompare(right.keyId) || left.model.localeCompare(right.model),
  );
}

// Token Usage assigns an unrecoverable key owner to the synthetic user bucket
// so its record and overview responses both preserve unattributed rows.
export const usageUserIdForKey = (
  keyId: string,
  keyToUser: ReadonlyMap<string, number>,
): number => keyToUser.get(keyId) ?? tokenUsageUnattributedUserId;

export function aggregateUsageByUserForDisplay(
  records: readonly UsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DisplayUsageByUserRecord[] {
  return aggregateUsage(
    records,
    record => {
      const userId = usageUserIdForKey(record.keyId, keyToUser);
      return { key: `${userId}\0${record.model}\0${record.hour}`, fields: { userId } };
    },
    (left, right) => left.hour.localeCompare(right.hour) || left.userId - right.userId || left.model.localeCompare(right.model),
  );
}

const overviewGroup = (
  record: UsageRecord,
  groupBy: UsageOverviewAggregateOptions['groupBy'],
  keyToUser: ReadonlyMap<string, number>,
): string | null => {
  if (groupBy === 'none') return 'all';
  if (groupBy === 'userId') {
    return String(usageUserIdForKey(record.keyId, keyToUser));
  }
  if (groupBy === 'upstream') return usageUpstreamDimensionValue(record.upstream);
  return record[groupBy];
};

export const aggregateUsageForOverview = <K extends string>(
  records: readonly UsageRecord[],
  axes: Record<K, UsageOverviewAggregateOptions>,
  keyToUser: ReadonlyMap<string, number>,
  visibleKeyIds: ReadonlySet<string>,
): Record<K, UsageOverviewRecord[]> => {
  const entries = Object.entries(axes) as [K, UsageOverviewAggregateOptions][];
  const maps = entries.map(() => new Map<string, UsageOverviewRecord>());
  const bucketResolvers = entries.map(([, options]) => createTelemetryBucket(options));
  for (const record of records) {
    for (let index = 0; index < entries.length; index++) {
      const options = entries[index][1];
      if (options.groupBy === 'keyId' && !visibleKeyIds.has(record.keyId)) continue;
      const group = overviewGroup(record, options.groupBy, keyToUser);
      if (group === null) continue;
      const bucket = bucketResolvers[index](record.hour);
      const key = `${bucket}\0${group}`;
      let aggregate = maps[index].get(key);
      if (!aggregate) {
        aggregate = { bucket, group, requests: 0, metrics: [], cost: null };
        maps[index].set(key, aggregate);
      }
      accumulate(aggregate, record);
    }
  }

  const result = {} as Record<K, UsageOverviewRecord[]>;
  for (let index = 0; index < entries.length; index++) {
    result[entries[index][0]] = [...maps[index].values()]
      .sort((left, right) => left.bucket.localeCompare(right.bucket) || left.group.localeCompare(right.group));
  }
  return result;
};
