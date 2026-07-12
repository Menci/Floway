import type { UsageRecord } from '../../repo/types.ts';
import { BILLING_DIMENSIONS, type BillingDimension } from '@floway-dev/protocols/common';

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  // Disjoint per-dimension token counts. Absent dimensions are zero.
  tokens: Partial<Record<BillingDimension, number>>;
  cost: number;
}

export interface DisplayUsageByUserRecord {
  userId: number;
  model: string;
  hour: string;
  requests: number;
  tokens: Partial<Record<BillingDimension, number>>;
  cost: number;
}

// Cost is a pure sum over disjoint per-dimension token counts:
// Σ tokens × unit_price / 1e6. No subtraction needed.
const recordCostUsd = (record: UsageRecord): number => {
  let total = 0;
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0;
    if (tokens === 0) continue;
    const unitPrice = record.rates?.[dimension] ?? null;
    if (unitPrice !== null) total += tokens * unitPrice;
  }
  return total / 1e6;
};

const accumulate = (
  bucket: { requests: number; cost: number; tokens: Partial<Record<BillingDimension, number>> },
  record: UsageRecord,
) => {
  bucket.requests += record.requests;
  bucket.cost += recordCostUsd(record);
  for (const dimension of BILLING_DIMENSIONS) {
    const tokens = record.tokens[dimension] ?? 0;
    if (tokens > 0) bucket.tokens[dimension] = (bucket.tokens[dimension] ?? 0) + tokens;
  }
};

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>();

  for (const record of records) {
    const key = `${record.keyId}\0${record.model}\0${record.hour}`;
    let existing = byKey.get(key);
    if (!existing) {
      existing = { keyId: record.keyId, model: record.model, hour: record.hour, requests: 0, tokens: {}, cost: 0 };
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
      existing = { userId, model: record.model, hour: record.hour, requests: 0, tokens: {}, cost: 0 };
      byUser.set(key, existing);
    }
    accumulate(existing, record);
  }

  return [...byUser.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.userId - b.userId || a.model.localeCompare(b.model));
}
