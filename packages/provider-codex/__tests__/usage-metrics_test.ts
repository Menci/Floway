import { expect, it } from 'vitest';

import { codexUsageMetrics, resolveUsageMetricDisplayName } from '../src/usage-metrics.ts';

it('uses actual durations and active limits to identify reordered Codex windows', () => {
  const snapshot = { observed_at: '2026-10-01T00:00:00Z', active_limit: 'codex', primary_used_percent: 25, primary_window_minutes: 300, secondary_used_percent: 50, secondary_window_minutes: 10080, credits_balance: 0 };
  const reordered = { ...snapshot, primary_used_percent: 50, primary_window_minutes: 10080, secondary_used_percent: 25, secondary_window_minutes: 300 };
  expect([...codexUsageMetrics(snapshot)].sort()).toEqual([...codexUsageMetrics(reordered)].sort());
  const key = JSON.stringify(['window', 'codex', 300]);
  expect(resolveUsageMetricDisplayName(key)).toEqual({ name: 'codex', unit: 'percent', windowMinutes: 300 });
  expect(codexUsageMetrics(snapshot).get('credits_balance')).toBe(0);
  expect(codexUsageMetrics({ observed_at: snapshot.observed_at, primary_used_percent: 50 }).size).toBe(0);
});
