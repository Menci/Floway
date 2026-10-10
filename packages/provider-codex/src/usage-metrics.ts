import type { CodexQuotaSnapshot } from './state.ts';
import type { UsageMetricDisplay } from '@floway-dev/provider';

// https://github.com/openai/codex/blob/6c0c6759d0617d7670826b61aca0a931bbb6db1f/codex-rs/codex-api/src/rate_limits.rs
export const codexUsageMetrics = (snapshot: CodexQuotaSnapshot): Map<string, number> => {
  const metrics = new Map<string, number>();
  for (const [value, minutes] of [
    [snapshot.primary_used_percent, snapshot.primary_window_minutes],
    [snapshot.secondary_used_percent, snapshot.secondary_window_minutes],
  ]) {
    if (value !== undefined && minutes !== undefined && minutes > 0) {
      metrics.set(JSON.stringify(['window', snapshot.active_limit ?? '', minutes]), value);
    }
  }
  if (snapshot.credits_balance !== undefined) metrics.set('credits_balance', snapshot.credits_balance);
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): UsageMetricDisplay => {
  if (key === 'credits_balance') return { name: key, unit: 'credits', windowMinutes: null };
  const [kind, name, windowMinutes] = JSON.parse(key) as [string, string, number];
  if (kind !== 'window' || typeof name !== 'string' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new TypeError('Invalid Codex usage metric key');
  return { name, unit: 'percent', windowMinutes };
};
