import { expect, it } from 'vitest';

import { resetMetricForKind } from '../../../src/data-plane/providers/registry.ts';

it('lets each provider own the full-quota representation for reset detection', () => {
  expect(resetMetricForKind('codex', { name: 'quota.window.used_percent', labels: { limit: 'codex', window_seconds: 18_000 } })?.resetValue).toBe(0);
  expect(resetMetricForKind('claude-code', { name: 'quota.utilization', labels: { quota: 'five_hour' } })?.resetValue).toBe(0);
  expect(resetMetricForKind('ollama', { name: 'quota.remaining_percent', labels: { window: 'session' } })?.resetValue).toBe(100);
  expect(resetMetricForKind('ollama', { name: 'balance.usd', labels: { source: 'included' } })?.resetValue).toEqual({ name: 'allowance.usd', labels: { source: 'included' } });
  expect(resetMetricForKind('copilot', { name: 'quota.remaining', labels: { quota: 'premium_interactions' } })?.resetValue).toEqual({ name: 'quota.entitlement', labels: { quota: 'premium_interactions' } });
});

it('includes observed quota identities without predefined names or durations', () => {
  expect(resetMetricForKind('claude-code', { name: 'quota.utilization', labels: { quota: 'unlisted_quota' } })).toMatchObject({
    name: 'quota.utilization{quota="unlisted_quota"}', labelKey: null, windowSeconds: null, resetValue: 0,
  });
  expect(resetMetricForKind('ollama', { name: 'quota.remaining_percent', labels: { window: 'unlisted_window' } })).toMatchObject({
    name: 'quota.remaining_percent{window="unlisted_window"}', labelKey: null, windowSeconds: null, resetValue: 100,
  });
  expect(resetMetricForKind('codex', { name: 'quota.window.used_percent', labels: { limit: 'unlisted_family', window_seconds: 125 } })).toMatchObject({
    name: 'unlisted_family', labelValues: { name: 'unlisted_family' }, windowSeconds: 125, resetValue: 0,
  });
});

it('excludes purchased balances, allowance totals, overage, and unknown telemetry from reset metrics', () => {
  expect(resetMetricForKind('codex', { name: 'credits.balance', labels: {} })).toBeNull();
  expect(resetMetricForKind('claude-code', { name: 'quota.utilization', labels: { quota: 'extra_usage' } })).toBeNull();
  expect(resetMetricForKind('ollama', { name: 'balance.usd', labels: { source: 'purchased' } })).toBeNull();
  expect(resetMetricForKind('copilot', { name: 'quota.entitlement', labels: { quota: 'chat' } })).toBeNull();
  expect(resetMetricForKind('custom', { name: 'quota.remaining_percent', labels: {} })).toBeNull();
});
