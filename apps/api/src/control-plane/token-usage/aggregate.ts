import type { UsageRecord } from '../../repo/types.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

export interface DisplayUsageRecord {
  keyId: string;
  model: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cost: number;
}

const recordCostUsd = (pricing: ModelPricing | null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens: number): number => {
  if (!pricing) return 0;
  const prefillInput = inputTokens - cacheReadTokens - cacheCreationTokens;
  const inputCost = prefillInput * pricing.input;
  const cacheReadCost = cacheReadTokens * (pricing.cache_read ?? pricing.input);
  const cacheWriteCost = cacheCreationTokens * (pricing.cache_write ?? pricing.input);
  const outputCost = outputTokens * pricing.output;
  return (inputCost + cacheReadCost + cacheWriteCost + outputCost) / 1e6;
};

const usageRecordKey = (record: DisplayUsageRecord): string => `${record.keyId}\0${record.model}\0${record.hour}`;

export function aggregateUsageForDisplay(records: readonly UsageRecord[]): DisplayUsageRecord[] {
  const byKey = new Map<string, DisplayUsageRecord>();

  for (const record of records) {
    const cacheRead = record.cacheReadTokens ?? 0;
    const cacheCreation = record.cacheCreationTokens ?? 0;
    const cost = recordCostUsd(record.cost, record.inputTokens, record.outputTokens, cacheRead, cacheCreation);

    const displayRecord: DisplayUsageRecord = {
      keyId: record.keyId,
      model: record.model,
      hour: record.hour,
      requests: record.requests,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      cost,
    };
    const key = usageRecordKey(displayRecord);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, displayRecord);
      continue;
    }

    existing.requests += displayRecord.requests;
    existing.inputTokens += displayRecord.inputTokens;
    existing.outputTokens += displayRecord.outputTokens;
    existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (displayRecord.cacheReadTokens ?? 0);
    existing.cacheCreationTokens = (existing.cacheCreationTokens ?? 0) + (displayRecord.cacheCreationTokens ?? 0);
    existing.cost += displayRecord.cost;
  }

  return [...byKey.values()].sort((a, b) => a.hour.localeCompare(b.hour) || a.keyId.localeCompare(b.keyId) || a.model.localeCompare(b.model));
}
