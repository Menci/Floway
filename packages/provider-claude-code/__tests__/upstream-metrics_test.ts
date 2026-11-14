import { expect, it } from 'vitest';

import { parseClaudeCodeQuotaHeaders } from '../src/quota.ts';
import { claudeCodeProbeMetrics, claudeCodeQuotaMetrics, resolveUpstreamMetricDisplay } from '../src/upstream-metrics.ts';
import { upstreamMetricAxisPriority } from '@floway-dev/provider/browser';

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

it('delivers nonfinite numeric utilization to the recording boundary', () => {
  const body = JSON.parse('{"five_hour":{"utilization":1e400}}') as Record<string, unknown>;
  expect(claudeCodeProbeMetrics(body)[0]?.value).toBe(Infinity);
});

it('converts canonical utilization percent into the direction the preference names', () => {
  const identity = { name: 'quota.utilization', labels: { quota: 'five_hour' } };
  const remaining = resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'remaining' })!;
  expect(remaining.axisPriority).toBe(upstreamMetricAxisPriority.subscriptionQuota);
  expect(remaining.labelKey).toBe('dashboard.upstreamMetrics.metrics.remaining');
  expect(remaining.toDisplayValue(25)).toBe(75);
  const used = resolveUpstreamMetricDisplay(identity, { quotaDisplay: 'used' })!;
  expect(used.labelKey).toBe('dashboard.upstreamMetrics.metrics.usage');
  expect(used.toDisplayValue(25)).toBe(25);
  const extra = resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota: 'extra_usage' } }, { quotaDisplay: 'remaining' })!;
  expect(extra.axisPriority).toBe(upstreamMetricAxisPriority.extraUsage);
  expect(extra.labelKey).toBe('dashboard.upstreamMetrics.metrics.extraUsage');
  expect(extra.toDisplayValue(25)).toBe(25);
  expect(extra.emptyValue).toBe(0);
});

it('leaves labels outside the Claude utilization metric schema undecoded', () => {
  expect(resolveUpstreamMetricDisplay({ name: 'quota.utilization', labels: { quota: 'five_hour', region: 'us' } }, { quotaDisplay: 'used' })).toBeNull();
});
