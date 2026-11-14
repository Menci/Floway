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
        ? options.quotaDisplay === 'used' ? 'dashboard.upstreamMetrics.metrics.sessionUsage' : 'dashboard.upstreamMetrics.metrics.sessionRemaining'
        : options.quotaDisplay === 'used' ? 'dashboard.upstreamMetrics.metrics.usage' : 'dashboard.upstreamMetrics.metrics.remaining',
      axisPriority: upstreamMetricAxisPriority.subscriptionQuota,
      windowSeconds: session ? null : 604_800,
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
    labelKey = range === '24h' ? 'dashboard.upstreamMetrics.metrics.past24HoursCost' : range === '7d' ? 'dashboard.upstreamMetrics.metrics.past7DaysCost' : 'dashboard.upstreamMetrics.metrics.past30DaysCost';
    axisPriority = upstreamMetricAxisPriority.activityCost;
  } else if (balance && (labels.source === 'included' || labels.source === 'purchased')) {
    metricName = labels.source;
    labelKey = labels.source === 'included' ? 'dashboard.upstreamMetrics.metrics.includedBalance' : 'dashboard.upstreamMetrics.metrics.purchasedBalance';
    axisPriority = labels.source === 'included' ? upstreamMetricAxisPriority.includedBalance : upstreamMetricAxisPriority.purchasedBalance;
  } else if (allowance && labels.source === 'included') {
    metricName = 'included_allowance';
    labelKey = 'dashboard.upstreamMetrics.metrics.includedAllowance';
    axisPriority = upstreamMetricAxisPriority.entitlement;
  } else return null;

  return { name: metricName, labelKey, unit: 'usd', axisPriority, windowSeconds: null, emptyValue: balance && labels.source === 'purchased' ? 0 : null, form: balance || allowance ? 'line' : 'area', toDisplayValue: value => value };
};

export const resolveUpstreamMetricDisplays = (samples: readonly UpstreamMetricSample[], options: UpstreamMetricDisplayOptions): UpstreamMetricDisplaySeries[] =>
  resolveDisplaySeries(samples, options, resolveUpstreamMetricDisplay);
