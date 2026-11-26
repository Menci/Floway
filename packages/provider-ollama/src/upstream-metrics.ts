import { readOllamaAccountUsage } from './account-usage.ts';
import type { UpstreamMetrics } from '@floway-dev/provider';
import { quotaPercentDisplay, resolveUpstreamMetricDisplaySeries as resolveDisplaySeries, upstreamMetricAxisPriority, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricIdentity, type UpstreamMetricSample } from '@floway-dev/provider/browser';

export const ollamaMetrics = (body: unknown): UpstreamMetrics => {
  const { included, purchasedBalanceUsd, activity } = readOllamaAccountUsage(body);
  const metrics = [];
  if (included.kind === 'credits') {
    metrics.push({ name: 'balance.usd', labels: { source: 'included' }, value: included.balanceUsd });
    metrics.push({ name: 'allowance.usd', labels: { source: 'included' }, value: included.allowanceUsd });
  } else {
    for (const window of ['session', 'weekly'] as const) metrics.push({ name: 'quota.remaining_percent', labels: { window }, value: included[window].remainingPercent });
  }
  metrics.push({ name: 'balance.usd', labels: { source: 'purchased' }, value: purchasedBalanceUsd });
  if (activity.usageUsd !== null) metrics.push({ name: 'activity.cost_usd', labels: { range: activity.range }, value: activity.usageUsd });
  return metrics;
};

export const resolveUpstreamMetricDisplay = ({ name, labels }: UpstreamMetricIdentity, options: UpstreamMetricDisplayOptions): UpstreamMetricDisplay | null => {
  if (name === 'quota.remaining_percent' && typeof labels.window === 'string') {
    const session = labels.window === 'session';
    return quotaPercentDisplay(options, 'remaining', {
      name: labels.window,
      labelKey: session
        ? options.quotaDisplay === 'used' ? 'monitoring.upstreams.series.sessionUsage' : 'monitoring.upstreams.series.sessionRemaining'
        : options.quotaDisplay === 'used' ? 'monitoring.upstreams.series.usage' : 'monitoring.upstreams.series.remaining',
      axisPriority: upstreamMetricAxisPriority.subscriptionQuota,
      windowSeconds: session ? null : 604_800,
      tracksResets: session || labels.window === 'weekly',
      ...((session || labels.window === 'weekly') && { quotaCostScope: 'upstream' }),
      emptyValue: null,
      form: 'area',
    });
  }

  const balance = name === 'balance.usd';
  const allowance = name === 'allowance.usd';
  const range = labels.range;
  let metricName: string;
  let labelKey: UpstreamMetricDisplay['labelKey'];
  let axisPriority: number;
  if (name === 'activity.cost_usd' && typeof range === 'string') {
    metricName = `cost_${range}`;
    labelKey = range === '24h' ? 'monitoring.upstreams.series.past24HoursCost' : range === '7d' ? 'monitoring.upstreams.series.past7DaysCost' : 'monitoring.upstreams.series.past30DaysCost';
    axisPriority = upstreamMetricAxisPriority.activityCost;
  } else if (balance && (labels.source === 'included' || labels.source === 'purchased')) {
    metricName = labels.source;
    labelKey = labels.source === 'included' ? 'monitoring.upstreams.series.includedBalance' : 'monitoring.upstreams.series.purchasedBalance';
    axisPriority = labels.source === 'included' ? upstreamMetricAxisPriority.includedBalance : upstreamMetricAxisPriority.purchasedBalance;
  } else if (allowance && labels.source === 'included') {
    metricName = 'included_allowance';
    labelKey = 'monitoring.upstreams.series.includedAllowance';
    axisPriority = upstreamMetricAxisPriority.entitlement;
  } else return null;

  return {
    name: metricName, labelKey, unit: 'usd', axisPriority, windowSeconds: null,
    emptyValue: balance && labels.source === 'purchased' ? 0 : null, form: balance || allowance ? 'line' : 'area',
    ...(balance && labels.source === 'included' && { resetThreshold: { direction: 'remaining', full: { name: 'allowance.usd', labels: { source: 'included' } } } }),
    toDisplayValue: value => value,
  };
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions): UpstreamMetricDisplaySeries[] =>
  resolveDisplaySeries(samples, options, resolveUpstreamMetricDisplay);
