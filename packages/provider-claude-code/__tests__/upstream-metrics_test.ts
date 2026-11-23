import { expect, it } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';

it('records header fractions and probe percentages as one canonical percent metric', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.25', 'anthropic-ratelimit-unified-7d-utilization': '0.5' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([
    { name: 'quota.utilization', labels: { quota: 'five_hour' }, value: 25 },
    { name: 'quota.utilization', labels: { quota: 'seven_day' }, value: 50 },
  ]);
  expect(claudeCodeProbeMetrics({ five_hour: { utilization: 25 }, seven_day_sonnet: { utilization: 40 }, unknown: null })).toEqual([
    { name: 'quota.utilization', labels: { quota: 'five_hour' }, value: 25 },
    { name: 'quota.utilization', labels: { quota: 'seven_day_sonnet' }, value: 40 },
  ]);
});

it('records header overage and OAuth extra usage as one series', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({ 'anthropic-ratelimit-unified-overage-utilization': '0.2' }));
  expect(claudeCodeQuotaMetrics(snapshot)).toEqual([{ name: 'quota.utilization', labels: { quota: 'extra_usage' }, value: 20 }]);
  expect(claudeCodeProbeMetrics({ extra_usage: { utilization: 30 } })).toEqual([{ name: 'quota.utilization', labels: { quota: 'extra_usage' }, value: 30 }]);
});

it('scales header fractions in decimal so they equal the OAuth percentages', () => {
  const snapshot = parseClaudeCodeQuotaHeaders(new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.07',
    'anthropic-ratelimit-unified-7d-utilization': '0.29',
    'anthropic-ratelimit-unified-overage-utilization': '1e-7',
  }));
  expect(claudeCodeQuotaMetrics(snapshot).map(metric => metric.value)).toEqual([7, 29, 0.00001]);
});

it('describes refill thresholds for the five-hour and weekly limits, independently of display preference', () => {
  const display = (quota: string, quotaDisplay: 'used' | 'remaining') =>
    resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota } }, { quotaDisplay });
  expect(display('five_hour', 'used')).toMatchObject({ windowSeconds: 18_000, resetThreshold: { direction: 'used', full: 0 } });
  expect(display('seven_day', 'remaining')).toMatchObject({ windowSeconds: 604_800, resetThreshold: { direction: 'used', full: 0 } });
  expect(display('extra_usage', 'remaining')?.resetThreshold).toBeUndefined();
  expect(display('unknown', 'remaining')?.resetThreshold).toBeUndefined();
});
