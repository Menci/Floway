import type { CodexQuotaSnapshot } from './state.ts';
import type { UpstreamMetrics } from '@floway-dev/provider';
import { quotaPercentDisplay, resolveUpstreamMetricDisplaySeries as resolveDisplaySeries, upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricIdentity, type UpstreamMetricSample } from '@floway-dev/provider/browser';

// https://github.com/openai/codex/blob/6c0c6759d0617d7670826b61aca0a931bbb6db1f/codex-rs/codex-api/src/rate_limits.rs
export const codexMetrics = (snapshot: CodexQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [value, minutes] of [
    [snapshot.primary_used_percent, snapshot.primary_window_minutes],
    [snapshot.secondary_used_percent, snapshot.secondary_window_minutes],
  ]) {
    if (value !== undefined && minutes !== undefined && minutes > 0) {
      metrics.push({ name: 'quota.window.used_percent', labels: { limit: snapshot.active_limit ?? '', window_seconds: minutes * 60 }, value });
    }
  }
  if (snapshot.credits_balance !== undefined) metrics.push({ name: 'credits.balance', labels: {}, value: snapshot.credits_balance });
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity, options: UpstreamMetricDisplayOptions): UpstreamMetricDisplay | null => {
  if (name === 'credits.balance' && Object.keys(labels).length === 0) return { name: 'credits_balance', labelKey: 'dashboard.upstreamMetrics.metrics.credits', unit: 'credits', axisPriority: upstreamMetricAxisPriority.purchasedBalance, windowSeconds: null, emptyValue: 0, form: 'line', toDisplayValue: value => value };
  const limit = labels.limit;
  const windowSeconds = labels.window_seconds;
  if (name !== 'quota.window.used_percent' || typeof limit !== 'string' || typeof windowSeconds !== 'number' || windowSeconds <= 0) return null;
  // "codex" identifies the default quota family, so only named families qualify the window label.
  // https://github.com/openai/codex/blob/6c0c6759d0617d7670826b61aca0a931bbb6db1f/codex-rs/codex-api/src/rate_limits.rs#L55-L64
  return quotaPercentDisplay(options, 'used', {
    name: limit === 'codex' ? '' : limit,
    labelKey: limit === 'codex'
      ? options.quotaDisplay === 'used' ? 'dashboard.upstreamMetrics.metrics.usage' : 'dashboard.upstreamMetrics.metrics.remaining'
      : `dashboard.upstreamMetrics.metrics.named${options.quotaDisplay === 'used' ? 'Usage' : 'Remaining'}`,
    labelValues: limit === 'codex' ? undefined : { name: limit },
    axisPriority: upstreamMetricAxisPriority.subscriptionQuota,
    windowSeconds,
    emptyValue: null,
    form: 'area',
  });
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions): UpstreamMetricDisplaySeries[] =>
  resolveDisplaySeries(samples, options, resolveUpstreamMetricDisplay);
