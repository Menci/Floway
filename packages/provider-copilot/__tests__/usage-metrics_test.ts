import { expect, it } from 'vitest';

import { copilotUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

it('retains arbitrary metered Copilot dimensions and omits unavailable and unlimited quotas', () => {
  const quota = { entitlement: 100, percent_remaining: 80, quota_remaining: 80, unlimited: false, overage_count: 0, overage_permitted: false };
  expect(copilotUsageMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { future_metric: quota, unavailable: { ...quota, entitlement: 0, percent_remaining: 0 }, unlimited: { ...quota, unlimited: true } } })).toEqual(new Map([['future_metric', 20]]));
  expect(resolveUsageMetricDisplayName('future_metric').name).toBe('future_metric');
});
