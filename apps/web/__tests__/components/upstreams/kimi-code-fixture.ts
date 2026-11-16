import type { KimiCodeRecord } from '../../../src/components/upstreams/kimi-code-account';
import { upstreamRecord } from '../../api/upstream-fixture';

interface KimiCodeUsageData {
  [field: string]: unknown;
  usages: Record<string, { used_ratio: number | string; reset_time: string }>;
}

export const resetAt = '2026-12-01T00:00:00Z';

export const currentUsage: KimiCodeUsageData = {
  limits: [],
  usages: {
    limit_5h: { used_ratio: 0.2, reset_time: resetAt },
    limit_month_total: { used_ratio: 0.7, reset_time: resetAt },
    limit_month_code: { used_ratio: 0.4, reset_time: resetAt },
  },
};

export const legacyUsage: KimiCodeUsageData = {
  limits: [],
  usage: { limit: '100', used: '30', remaining: '70', resetTime: resetAt },
  usages: {
    limit_5h: { used_ratio: 0.1, reset_time: resetAt },
    limit_7d: { used_ratio: 0.3, reset_time: resetAt },
  },
};

export const kimiCodeRecord = (usage: KimiCodeUsageData | null = currentUsage): KimiCodeRecord => upstreamRecord('up_kimi', {
  kind: 'kimi-code', config: { region: 'china', apiKey: 'sk-kimi-fake-test-key' },
  state: {
    accountProbe: null,
    usageProbe: usage === null ? null : {
      attemptedAt: 1000, error: null, observation: { fetchedAt: 1000, data: usage },
    },
  },
}) as KimiCodeRecord;
