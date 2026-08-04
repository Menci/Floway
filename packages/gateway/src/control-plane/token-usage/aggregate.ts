import type { UsageRecord } from '../../repo/types.ts';
import { addDecimalStrings, multiplyDecimalStrings, type BillingMetric, type DecimalString } from '@floway-dev/protocols/common';

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

export interface DashboardUsageRecord extends DisplayUsageRecord {
  upstream: string | null;
}

export interface DashboardUsageByUserRecord extends DisplayUsageByUserRecord {
  upstream: string | null;
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

export function aggregateUsageForDashboard(records: readonly UsageRecord[]): DashboardUsageRecord[] {
  return aggregateUsage(
    records,
    record => ({
      key: `${record.keyId}\0${record.model}\0${JSON.stringify(record.upstream)}\0${record.hour}`,
      fields: { keyId: record.keyId, upstream: record.upstream },
    }),
    (left, right) => left.hour.localeCompare(right.hour) || left.keyId.localeCompare(right.keyId) || left.model.localeCompare(right.model) || (left.upstream ?? '').localeCompare(right.upstream ?? ''),
  );
}

// Aggregates per-key UsageRecords into per-(user, model, hour) rows. Records
// whose keyId no longer resolves to a user (a key the operator hard-deleted by
// hand directly in the DB, etc.) collapse into a synthetic userId 0 so the
// dashboard can still surface the lost rows; the keyToUser map is populated
// from active + soft-deleted api_keys, so a normal soft delete still resolves.
export function aggregateUsageByUserForDisplay(
  records: readonly UsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DisplayUsageByUserRecord[] {
  return aggregateUsage(
    records,
    record => {
      const userId = keyToUser.get(record.keyId) ?? 0;
      return { key: `${userId}\0${record.model}\0${record.hour}`, fields: { userId } };
    },
    (left, right) => left.hour.localeCompare(right.hour) || left.userId - right.userId || left.model.localeCompare(right.model),
  );
}

export function aggregateUsageByUserForDashboard(
  records: readonly UsageRecord[],
  keyToUser: ReadonlyMap<string, number>,
): DashboardUsageByUserRecord[] {
  return aggregateUsage(
    records,
    record => {
      const userId = keyToUser.get(record.keyId) ?? 0;
      return {
        key: `${userId}\0${record.model}\0${JSON.stringify(record.upstream)}\0${record.hour}`,
        fields: { userId, upstream: record.upstream },
      };
    },
    (left, right) => left.hour.localeCompare(right.hour) || left.userId - right.userId || left.model.localeCompare(right.model) || (left.upstream ?? '').localeCompare(right.upstream ?? ''),
  );
}
