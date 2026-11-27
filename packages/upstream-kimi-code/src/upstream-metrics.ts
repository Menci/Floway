import { KIMI_CODE_WINDOW_SECONDS, readKimiCodeUsage, type KimiCodeQuotaWindow } from './usage.ts';
import type { UpstreamMetrics } from '@floway-dev/upstream';
import { quotaPercentDisplay, resolveUpstreamMetricDisplaySeries, upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricIdentity, type UpstreamMetricSample } from '@floway-dev/upstream/browser';

export const kimiCodeMetrics = (data: unknown): UpstreamMetrics => readKimiCodeUsage(data).windows.map(window => ({
  name: 'quota.used_percent', labels: { window: window.id }, value: window.usedRatio * 100,
}));

// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/apps/kimi-code/src/utils/usage/usage-format.ts#L92-L114
const WINDOW_DISPLAYS: Record<KimiCodeQuotaWindow['id'], { used: NonNullable<UpstreamMetricDisplay['labelKey']>; remaining: NonNullable<UpstreamMetricDisplay['labelKey']> }> = {
  five_hour: { used: 'monitoring.upstreams.series.usage', remaining: 'monitoring.upstreams.series.remaining' },
  monthly: { used: 'monitoring.upstreams.series.monthlyUsage', remaining: 'monitoring.upstreams.series.monthlyRemaining' },
  weekly: { used: 'monitoring.upstreams.series.usage', remaining: 'monitoring.upstreams.series.remaining' },
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity, options: UpstreamMetricDisplayOptions): UpstreamMetricDisplay | null => {
  if (name !== 'quota.used_percent' || typeof labels.window !== 'string' || !Object.hasOwn(WINDOW_DISPLAYS, labels.window)) return null;
  const window = WINDOW_DISPLAYS[labels.window as KimiCodeQuotaWindow['id']];
  return quotaPercentDisplay(options, 'used', {
    name: labels.window,
    labelKey: options.quotaDisplay === 'used' ? window.used : window.remaining,
    axisPriority: upstreamMetricAxisPriority.subscriptionQuota,
    windowSeconds: KIMI_CODE_WINDOW_SECONDS[labels.window as KimiCodeQuotaWindow['id']],
    emptyValue: null,
    form: 'area',
  });
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions) =>
  resolveUpstreamMetricDisplaySeries(samples, options, resolveUpstreamMetricDisplay);
