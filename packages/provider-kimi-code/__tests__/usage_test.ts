import { expect, test } from 'vitest';

import { RESET, usage } from './fixtures.ts';
import { kimiCodeMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import { readKimiCodeUsage } from '../src/usage.ts';

test('new subscriptions expose five-hour and monthly quota with a Code contribution', () => {
  expect(readKimiCodeUsage(usage())).toEqual({
    windows: [{ id: 'five_hour', usedRatio: 0.25, resetsAt: RESET }, { id: 'monthly', usedRatio: 0.5, resetsAt: RESET }],
    monthlyCodeUsedRatio: 0.2,
  });
});

test('quota violations throw instead of publishing made-up readings', () => {
  for (const bad of ['', -0.1]) {
    const body = usage();
    body.usages.limit_5h.used_ratio = bad as number;
    expect(() => readKimiCodeUsage(body)).toThrow();
  }
  const body = usage();
  body.usages.limit_5h.reset_time = 'not-a-date';
  expect(() => readKimiCodeUsage(body)).toThrow('timestamp');
  delete body.usages.limit_5h;
  expect(() => readKimiCodeUsage(body)).toThrow();
});

test('metrics contain percentages of subscription quota with used and remaining displays', () => {
  const metrics = kimiCodeMetrics(usage());
  expect(metrics).toEqual([
    { name: 'quota.used_percent', labels: { window: 'five_hour' }, value: 25 },
    { name: 'quota.used_percent', labels: { window: 'monthly' }, value: 50 },
  ]);
  const used = resolveUpstreamMetricDisplay(metrics[0], { quotaDisplay: 'used' })!;
  const remaining = resolveUpstreamMetricDisplay(metrics[0], { quotaDisplay: 'remaining' })!;
  expect(used.unit).toBe('percent');
  expect(used.windowSeconds).toBe(18_000);
  expect(used.toDisplayValue(25)).toBe(25);
  expect(remaining.toDisplayValue(25)).toBe(75);
  expect(resolveUpstreamMetricDisplay({ name: 'balance.usd', labels: {} }, { quotaDisplay: 'used' })).toBeNull();
});
