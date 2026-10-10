import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import type { UsageMetricDisplay } from '@floway-dev/provider';

// Header utilization is fractional; the OAuth usage body reports percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
export const claudeCodeQuotaUsageMetrics = (snapshot: ClaudeCodeQuotaSnapshot): Map<string, number> => {
  const metrics = new Map<string, number>();
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['overage', snapshot.overage]] as const) {
    if (window !== null && window.utilization !== null) metrics.set(key, window.utilization * 100);
  }
  return metrics;
};

export const claudeCodeProbeUsageMetrics = (body: unknown): Map<string, number> => {
  const metrics = new Map<string, number>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new TypeError('Claude Code usage observation must be an object');
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && 'utilization' in value && typeof value.utilization === 'number' && Number.isFinite(value.utilization)) metrics.set(key, value.utilization);
  }
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): UsageMetricDisplay => ({ name: key, unit: 'percent', windowMinutes: null });
