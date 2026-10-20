import { expect, it } from 'vitest';

import { copilotMetrics, resolveUpstreamMetricDisplay, resolveUpstreamMetricDisplays } from '../src/upstream-metrics.ts';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

it('retains arbitrary metered Copilot quantities and omits unavailable and unlimited quotas', () => {
  const quota = { entitlement: 100, percent_remaining: 80, quota_remaining: 80, unlimited: false, overage_count: 0, overage_permitted: false };
  expect(copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { future_metric: quota, unavailable: { ...quota, entitlement: 0, percent_remaining: 0 }, unlimited: { ...quota, entitlement: -1, unlimited: true } } })).toEqual([
    { name: 'quota.remaining', labels: { quota: 'future_metric' }, value: 80 },
    { name: 'quota.entitlement', labels: { quota: 'future_metric' }, value: 100 },
  ]);
  expect(resolveUpstreamMetricDisplay({ name: 'quota.remaining', labels: { quota: 'future_metric' } }, { quotaDisplay: 'remaining' })!.name).toBe('remaining_future_metric');
});

it('rejects an entitlement below the documented unlimited sentinel', () => {
  const quota = { entitlement: -2, percent_remaining: 0, quota_remaining: 0, unlimited: false, overage_count: 0, overage_permitted: false };
  expect(() => copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { malformed: quota } })).toThrow(TypeError);
});

it('rejects a sentinel entitlement whose unlimited flag is not canonical', () => {
  const quota = { entitlement: -1, percent_remaining: 100, quota_remaining: -1, unlimited: false, overage_count: 0, overage_permitted: false };
  expect(() => copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { malformed: quota } })).toThrow(TypeError);
});

it('records fractional remaining quantities and changed allowances without storing percentages', () => {
  for (const [remaining, entitlement] of [[0, 300], [300, 300], [9_719_759.1, 10_000_000], [600, 600]]) {
    const metrics = copilotMetrics({ observed_at: '2026-10-01T00:00:00Z', reset_at: null, quotas: { premium_interactions: { entitlement: entitlement!, percent_remaining: 97.1, quota_remaining: remaining!, unlimited: false, overage_count: 0, overage_permitted: false } } });
    expect(metrics).toEqual([
      { name: 'quota.remaining', labels: { quota: 'premium_interactions' }, value: remaining },
      { name: 'quota.entitlement', labels: { quota: 'premium_interactions' }, value: entitlement },
    ]);
  }
});

it('displays premium interaction credits as dollars and leaves other quotas as counts', () => {
  for (const [name, quantity, form] of [['quota.remaining', 'remaining', 'area'], ['quota.entitlement', 'entitlement', 'line']] as const) {
    const premium = resolveUpstreamMetricDisplay({ name, labels: { quota: 'premium_interactions' } }, { quotaDisplay: 'used' })!;
    const axisPriority = quantity === 'remaining' ? upstreamMetricAxisPriority.remainingQuota : upstreamMetricAxisPriority.entitlement;
    expect(premium).toMatchObject({ name: `${quantity}_premium_interactions`, unit: 'usd', axisPriority, form, emptyValue: null });
    expect([0, 270, 300, 10_000_000].map(premium.toDisplayValue)).toEqual([0, 2.7, 3, 100_000]);
    const chat = resolveUpstreamMetricDisplay({ name, labels: { quota: 'chat' } }, { quotaDisplay: 'used' })!;
    expect(chat).toMatchObject({ name: `${quantity}_chat`, unit: 'count', axisPriority });
    expect([0, 200].map(chat.toDisplayValue)).toEqual([0, 200]);
  }
});

it('switches absolute quota series between remaining and used while retaining the allowance', () => {
  const samples = [
    { name: 'quota.remaining', labels: { quota: 'chat' }, timestamp: 1_000, value: 213 },
    { name: 'quota.entitlement', labels: { quota: 'chat' }, timestamp: 1_000, value: 300 },
    { name: 'quota.remaining', labels: { quota: 'chat' }, timestamp: 2_000, value: 180 },
    { name: 'quota.entitlement', labels: { quota: 'chat' }, timestamp: 2_000, value: 300 },
  ];

  const remaining = resolveUpstreamMetricDisplays(samples, { quotaDisplay: 'remaining' });
  expect(remaining.map(series => series.identity.name)).toEqual(['quota.remaining', 'quota.entitlement']);
  expect(remaining[0]!.samples.map(sample => sample.value)).toEqual([213, 180]);
  expect(remaining[0]!.display.labelKey).toBe('dashboard.upstreams.copilotQuota.chat.remaining');

  const used = resolveUpstreamMetricDisplays(samples, { quotaDisplay: 'used' });
  expect(used.map(series => series.identity.name)).toEqual(['quota.used', 'quota.entitlement']);
  expect(used[0]!.samples.map(sample => sample.value)).toEqual([87, 120]);
  expect(used[0]!.display.labelKey).toBe('dashboard.upstreams.copilotQuota.chat.usage');
  expect(used[1]!.samples.map(sample => sample.value)).toEqual([300, 300]);
});

it('rejects an unpaired absolute quota observation', () => {
  expect(() => resolveUpstreamMetricDisplays([
    { name: 'quota.remaining', labels: { quota: 'chat' }, timestamp: 1_000, value: 213 },
  ], { quotaDisplay: 'used' })).toThrow('without an entitlement series');
});
