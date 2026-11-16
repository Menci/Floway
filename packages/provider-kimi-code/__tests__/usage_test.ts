import { expect, test } from 'vitest';

import { RESET, usage } from './fixtures.ts';
import { kimiCodeMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import { KIMI_CODE_WINDOW_SECONDS, readKimiCodeUsage } from '../src/usage.ts';

test('new subscriptions expose five-hour and monthly quota with a Code contribution', () => {
  expect(readKimiCodeUsage(usage())).toEqual({
    windows: [{ id: 'five_hour', usedRatio: 0.25, resetsAt: RESET }, { id: 'monthly', usedRatio: 0.5, resetsAt: RESET }],
    monthlyCodeUsedRatio: 0.2,
  });
});

test('legacy subscriptions expose five-hour and weekly quota independently of the extra wallet', () => {
  expect(readKimiCodeUsage(usage(true))).toEqual({
    windows: [{ id: 'five_hour', usedRatio: 0.25, resetsAt: RESET }, { id: 'weekly', usedRatio: 0.5, resetsAt: RESET }],
    monthlyCodeUsedRatio: null,
  });
});

test('quota violations throw instead of publishing made-up readings', () => {
  for (const bad of [null, '', 'not-a-ratio', -0.1, Number.NaN]) {
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

test('all subscription windows resolve through localized metric keys without interpolating internal ids', () => {
  for (const [id, seconds] of [['five_hour', 18_000], ['weekly', 604_800], ['monthly', null]] as const) {
    expect(KIMI_CODE_WINDOW_SECONDS[id]).toBe(seconds);
    for (const direction of ['used', 'remaining'] as const) {
      const display = resolveUpstreamMetricDisplay({ name: 'quota.used_percent', labels: { window: id } }, { quotaDisplay: direction })!;
      expect(display.labelKey).toBe(id === 'monthly'
        ? direction === 'used' ? 'dashboard.upstreamMetrics.metrics.monthlyUsage' : 'dashboard.upstreamMetrics.metrics.monthlyRemaining'
        : direction === 'used' ? 'dashboard.upstreamMetrics.metrics.usage' : 'dashboard.upstreamMetrics.metrics.remaining');
      expect(display.labelValues).toBeUndefined();
      expect(display.windowSeconds).toBe(seconds);
    }
  }
});

test.each([false, true])('unconsumed quota fields cannot invalidate usable windows (legacy=%s)', legacy => {
  const body = usage(legacy);
  expect(readKimiCodeUsage({ ...body, limits: null, booster_wallet: 'opaque' })).toEqual(readKimiCodeUsage(body));
  const { limits: _limits, booster_wallet: _wallet, ...consumed } = body;
  expect(readKimiCodeUsage(consumed)).toEqual(readKimiCodeUsage(body));
});
