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

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>();

  for (const record of records) {
    const key = `${record.keyId}\0${record.model}\0${record.hour}`;
    let existing = byKey.get(key);
    if (!existing) {
      existing = { keyId: record.keyId, model: record.model, hour: record.hour, requests: 0, metrics: [], cost: null };
      byKey.set(key, existing);
    }
    accumulate(existing, record);
  }

  return [...byKey.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.model.localeCompare(b.model));
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
  const byUser = new Map<string, DisplayUsageByUserRecord>();

  for (const record of records) {
    const userId = keyToUser.get(record.keyId) ?? 0;
    const key = `${userId}\0${record.model}\0${record.hour}`;
    let existing = byUser.get(key);
    if (!existing) {
      existing = { userId, model: record.model, hour: record.hour, requests: 0, metrics: [], cost: null };
      byUser.set(key, existing);
    }
    accumulate(existing, record);
  }

  return [...byUser.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.userId - b.userId || a.model.localeCompare(b.model));
}
