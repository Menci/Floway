import type { ClaudeCodeQuotaSnapshot } from './quota.ts';
import { decimalStringToNumber, multiplyDecimalStrings } from '@floway-dev/protocols/common';
import type { UpstreamMetrics } from '@floway-dev/provider';
import { quotaPercentDisplay, resolveUpstreamMetricDisplaySeries as resolveDisplaySeries, upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricIdentity, type UpstreamMetricSample } from '@floway-dev/provider/browser';

// Headers report fractions while OAuth usage reports percentages; both are stored as percentages.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.288.tgz
// The fraction is scaled in decimal so a header reading equals the OAuth percentage for the same
// usage; binary multiplication turns 0.07 into 7.000000000000001.
const fractionToPercent = (fraction: number): number => decimalStringToNumber(multiplyDecimalStrings(String(fraction), '100'));

// The `anthropic-ratelimit-unified-overage-utilization` header and the OAuth usage body's
// `extra_usage.utilization` both report the share of the extra usage (usage credits) monthly
// spend limit that is used, so they are recorded as one `extra_usage` series. Claude Code renders
// the body field as used_credits / monthly_limit:
// https://github.com/ghboke/claude-code-reverse/blob/main/src/src/components/Settings/Usage.tsx
// Independent captures describe the header as the extra usage budget consumed, and as reading 0.0
// on an uncapped account that has spent money:
// https://github.com/ArkNill/claude-code-hidden-problem-analysis/blob/main/02_RATELIMIT-HEADERS.md
// https://github.com/weltern/Clawdmeter/blob/main/docs/overage-mechanics.md
export const claudeCodeQuotaMetrics = (snapshot: ClaudeCodeQuotaSnapshot): UpstreamMetrics => {
  const metrics = [];
  for (const [key, window] of [['five_hour', snapshot.fiveHour], ['seven_day', snapshot.sevenDay], ['extra_usage', snapshot.overage]] as const) {
    if (window !== null && window.utilization !== null) metrics.push({ name: 'quota.utilization', labels: { quota: key }, value: fractionToPercent(window.utilization) });
  }
  return metrics;
};

export const claudeCodeProbeMetrics = (body: Record<string, unknown>): UpstreamMetrics => {
  const metrics = [];
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && 'utilization' in value && typeof value.utilization === 'number') metrics.push({ name: 'quota.utilization', labels: { quota: key }, value: value.utilization });
  }
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity, options: UpstreamMetricDisplayOptions): UpstreamMetricDisplay | null => {
  const quota = labels.quota;
  if (name !== 'quota.utilization' || typeof quota !== 'string' || Object.keys(labels).length !== 1) return null;
  const extra = quota === 'extra_usage';
  if (extra) {
    return {
      name: quota,
      labelKey: 'dashboard.upstreamMetrics.metrics.extraUsage',
      unit: 'percent',
      axisPriority: upstreamMetricAxisPriority.extraUsage,
      windowSeconds: null,
      emptyValue: 0,
      form: 'area',
      toDisplayValue: value => value,
    };
  }
  const named = quota === 'seven_day_sonnet' ? 'Sonnet' : quota === 'seven_day_opus' ? 'Opus' : null;
  return quotaPercentDisplay(options, 'used', {
    name: quota,
    labelKey: named === null
      ? options.quotaDisplay === 'used' ? 'dashboard.upstreamMetrics.metrics.usage' : 'dashboard.upstreamMetrics.metrics.remaining'
      : `dashboard.upstreamMetrics.metrics.named${options.quotaDisplay === 'used' ? 'Usage' : 'Remaining'}`,
    labelValues: named === null ? undefined : { name: named },
    axisPriority: upstreamMetricAxisPriority.subscriptionQuota,
    windowSeconds: quota === 'five_hour' ? 18_000 : 604_800,
    emptyValue: null,
    form: 'area',
  });
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions): UpstreamMetricDisplaySeries[] =>
  resolveDisplaySeries(samples, options, resolveUpstreamMetricDisplay);
