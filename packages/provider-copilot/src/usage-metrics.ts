import type { CopilotQuotaSnapshot } from './quota.ts';
import type { UsageMetricDisplay } from '@floway-dev/provider';

// https://github.com/github/copilot-sdk/blob/6be623b01b194a61466385e3f708639ec98ce8ac/nodejs/src/generated/rpc.ts#L6572
export const copilotUsageMetrics = (snapshot: CopilotQuotaSnapshot): Map<string, number> => new Map(
  Object.entries(snapshot.quotas)
    .filter(([, quota]) => !quota.unlimited && quota.entitlement > 0)
    .map(([key, quota]) => [key, 100 - quota.percent_remaining]),
);

export const resolveUsageMetricDisplayName = (key: string): UsageMetricDisplay => ({ name: key, unit: 'percent', windowMinutes: null });
