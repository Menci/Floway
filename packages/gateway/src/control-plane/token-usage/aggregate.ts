import type { UsageRecord } from '../../repo/types.ts';
import { addDecimalStrings, multiplyDecimalStrings, tokenUsageUnattributedUserId, type BillingMetric, type DecimalString } from '@floway-dev/protocols/common';

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
