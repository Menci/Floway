import { expect, test } from 'vitest';

import { LEGACY_BALANCE, USAGE_TOTALS, accountUsage } from './usage-fixture.ts';
import { ollamaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import type { UpstreamMetricIdentity } from '@floway-dev/provider';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

test('credit balances and period consumption retain distinct money gauges', () => {
  expect(ollamaMetrics(accountUsage())).toEqual([
    { name: 'balance.usd', labels: { source: 'included' }, value: 18 },
    { name: 'allowance.usd', labels: { source: 'included' }, value: 60 },
    { name: 'balance.usd', labels: { source: 'purchased' }, value: 25 },
    { name: 'activity.cost_usd', labels: { range: '7d' }, value: 3.25 },
  ]);
});

test('legacy plans retain percentage gauges and omit monetary usage when not supplied', () => {
  expect(ollamaMetrics({ balance: LEGACY_BALANCE, usage: { ...USAGE_TOTALS, totals: { request_count: 15 } } })).toEqual([
    { name: 'quota.remaining_percent', labels: { window: 'session' }, value: 75 },
    { name: 'quota.remaining_percent', labels: { window: 'weekly' }, value: 60 },
    { name: 'balance.usd', labels: { source: 'purchased' }, value: 25 },
  ]);
});

test('displays remaining legacy windows and preserves monetary gauges', () => {
  for (const window of ['session', 'weekly']) {
    const display = resolveUpstreamMetricDisplay({ name: 'quota.remaining_percent', labels: { window } }, { quotaDisplay: 'remaining' })!;
    expect(display.axisPriority).toBe(upstreamMetricAxisPriority.subscriptionQuota);
    expect(display.labelKey).toBe(window === 'session' ? 'dashboard.upstreamMetrics.metrics.sessionRemaining' : 'dashboard.upstreamMetrics.metrics.remaining');
    expect(display.toDisplayValue(25)).toBe(25);
    const used = resolveUpstreamMetricDisplay({ name: 'quota.remaining_percent', labels: { window } }, { quotaDisplay: 'used' })!;
    expect(used.labelKey).toBe(window === 'session' ? 'dashboard.upstreamMetrics.metrics.sessionUsage' : 'dashboard.upstreamMetrics.metrics.usage');
    expect(used.toDisplayValue(25)).toBe(75);
  }
  const identities: Array<{ identity: UpstreamMetricIdentity; axisPriority: number }> = [
    { identity: { name: 'balance.usd', labels: { source: 'included' } }, axisPriority: upstreamMetricAxisPriority.includedBalance },
    { identity: { name: 'balance.usd', labels: { source: 'purchased' } }, axisPriority: upstreamMetricAxisPriority.purchasedBalance },
    { identity: { name: 'activity.cost_usd', labels: { range: '7d' } }, axisPriority: upstreamMetricAxisPriority.activityCost },
  ];
  for (const { identity, axisPriority } of identities) {
    const display = resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'used' })!;
    expect(display.axisPriority).toBe(axisPriority);
    expect(display.toDisplayValue(3.25)).toBe(3.25);
  }
});

test('preserves full and exhausted legacy windows without inverting their raw values', () => {
  const balance = { ...LEGACY_BALANCE, included: { session: { ...LEGACY_BALANCE.included.session, remaining_percent: 0 }, weekly: { ...LEGACY_BALANCE.included.weekly, remaining_percent: 100 } } };
  const metrics = ollamaMetrics({ balance, usage: USAGE_TOTALS });
  expect(metrics.find(metric => metric.labels.window === 'session')?.value).toBe(0);
  expect(metrics.find(metric => metric.labels.window === 'weekly')?.value).toBe(100);
});

test('records zero and changed included allowances separately from remaining balance', () => {
  for (const allowance_usd of [0, 60, 120]) {
    const base = accountUsage();
    const body = { ...base, balance: { ...base.balance, included: { ...base.balance.included, allowance_usd } } };
    const metrics = ollamaMetrics(body);
    expect(metrics.find(metric => metric.name === 'allowance.usd')?.value).toBe(allowance_usd);
    expect(metrics.find(metric => metric.name === 'balance.usd' && metric.labels.source === 'included')?.value).toBe(18);
  }
  const display = resolveUpstreamMetricDisplay({ name: 'allowance.usd', labels: { source: 'included' } }, { quotaDisplay: 'used' })!;
  expect(display).toMatchObject({ name: 'included_allowance', unit: 'usd', axisPriority: upstreamMetricAxisPriority.entitlement, form: 'line', emptyValue: null });
  expect(display.toDisplayValue(60)).toBe(60);
});
