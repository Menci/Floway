import { getProviderRepo } from './repo.ts';
import { normalizeUpstreamMetricIdentity, upstreamMetricIdentityKey, type UpstreamMetricIdentity, type UpstreamMetricLabels } from './upstream-metric-identity.ts';
import type { QuotaDisplay } from '@floway-dev/protocols/common';

export interface UpstreamMetricObservation extends UpstreamMetricIdentity { value: number }
export type UpstreamMetrics = readonly UpstreamMetricObservation[];
export type UpstreamMetricUnit = 'percent' | 'usd' | 'credits' | 'count' | 'none';
export const upstreamMetricAxisPriority = {
  subscriptionQuota: 100,
  remainingQuota: 90,
  includedBalance: 80,
  entitlement: 70,
  activityCost: 60,
  extraUsage: 50,
  purchasedBalance: 40,
  unknown: 0,
} as const;

/** Keys the dashboard resolves to name a metric series. */
export type UpstreamMetricLabelKey =
  | 'dashboard.upstreams.copilotQuota.chat.allowance'
  | 'dashboard.upstreams.copilotQuota.chat.remaining'
  | 'dashboard.upstreams.copilotQuota.chat.usage'
  | 'dashboard.upstreams.copilotQuota.completions.allowance'
  | 'dashboard.upstreams.copilotQuota.completions.remaining'
  | 'dashboard.upstreams.copilotQuota.completions.usage'
  | 'dashboard.upstreams.copilotQuota.other.allowance'
  | 'dashboard.upstreams.copilotQuota.other.remaining'
  | 'dashboard.upstreams.copilotQuota.other.usage'
  | 'dashboard.upstreams.copilotQuota.premiumInteractions.allowance'
  | 'dashboard.upstreams.copilotQuota.premiumInteractions.remaining'
  | 'dashboard.upstreams.copilotQuota.premiumInteractions.usage'
  | 'dashboard.upstreamMetrics.metrics.credits'
  | 'dashboard.upstreamMetrics.metrics.extraUsage'
  | 'dashboard.upstreamMetrics.metrics.includedBalance'
  | 'dashboard.upstreamMetrics.metrics.includedAllowance'
  | 'dashboard.upstreamMetrics.metrics.namedRemaining'
  | 'dashboard.upstreamMetrics.metrics.namedUsage'
  | 'dashboard.upstreamMetrics.metrics.past24HoursCost'
  | 'dashboard.upstreamMetrics.metrics.past30DaysCost'
  | 'dashboard.upstreamMetrics.metrics.past7DaysCost'
  | 'dashboard.upstreamMetrics.metrics.purchasedBalance'
  | 'dashboard.upstreamMetrics.metrics.remaining'
  | 'dashboard.upstreamMetrics.metrics.sessionRemaining'
  | 'dashboard.upstreamMetrics.metrics.sessionUsage'
  | 'dashboard.upstreamMetrics.metrics.usage';

export interface UpstreamMetricDisplay {
  name: string;
  /** Translation key for this series, or null when `name` is data rather than prose. */
  labelKey: UpstreamMetricLabelKey | null;
  /** Values the label key interpolates, if it interpolates any. */
  labelValues?: Record<string, string | number>;
  unit: UpstreamMetricUnit;
  axisPriority: number;
  windowSeconds: number | null;
  emptyValue: number | null;
  form: 'line' | 'area';
  toDisplayValue: (storedValue: number) => number;
}

export interface UpstreamMetricDisplayOptions {
  /**
   * Whether quota values are presented as the amount remaining or the amount
   * used. A provider applies it to both percentages and absolute quantities.
   */
  quotaDisplay: QuotaDisplay;
}

export interface UpstreamMetricSample extends UpstreamMetricIdentity {
  timestamp: number;
  value: number;
}

export interface UpstreamMetricDisplaySeries {
  identity: UpstreamMetricIdentity;
  display: UpstreamMetricDisplay;
  samples: UpstreamMetricSample[];
}

export interface GroupedUpstreamMetricSamples {
  identity: UpstreamMetricIdentity;
  samples: UpstreamMetricSample[];
}

/**
 * A quota percentage whose stored value is `storedDirection` percent.
 * `quotaDisplay` decides the display value and the key that names what it
 * counts; the provider supplies the direction its upstream stores, so the
 * conversion stays beside the wire format that defines it.
 */
export const quotaPercentDisplay = (
  options: UpstreamMetricDisplayOptions,
  storedDirection: QuotaDisplay,
  display: Omit<UpstreamMetricDisplay, 'toDisplayValue' | 'unit'>,
): UpstreamMetricDisplay => ({
  ...display,
  unit: 'percent',
  toDisplayValue: value => options.quotaDisplay === storedDirection ? value : 100 - value,
});

export const formatUpstreamMetricIdentity = ({ name, labels }: UpstreamMetricIdentity): string => {
  const entries = Object.entries(labels);
  if (entries.length === 0) return name;
  return `${name}{${entries.map(([key, value]) => `${key}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`).join(',')}}`;
};

export const groupUpstreamMetricSamples = (samples: readonly UpstreamMetricSample[]): GroupedUpstreamMetricSamples[] => {
  const groups = new Map<string, GroupedUpstreamMetricSamples>();
  for (const sample of samples) {
    const id = upstreamMetricIdentityKey(sample);
    const group = groups.get(id);
    if (group === undefined) {
      groups.set(id, { identity: { name: sample.name, labels: sample.labels }, samples: [sample] });
    } else {
      group.samples.push(sample);
    }
  }
  return [...groups.values()];
};

const rawMetricDisplay = (identity: UpstreamMetricIdentity): UpstreamMetricDisplay => ({
  name: formatUpstreamMetricIdentity(identity),
  labelKey: null,
  unit: 'none',
  axisPriority: upstreamMetricAxisPriority.unknown,
  windowSeconds: null,
  emptyValue: null,
  form: 'line',
  toDisplayValue: value => value,
});

export const resolveUpstreamMetricDisplaySeries = (
  samples: readonly UpstreamMetricSample[],
  options: UpstreamMetricDisplayOptions,
  resolve: (identity: UpstreamMetricIdentity, options: UpstreamMetricDisplayOptions) => UpstreamMetricDisplay | null,
): UpstreamMetricDisplaySeries[] => groupUpstreamMetricSamples(samples).map(group => ({
  ...group,
  display: resolve(group.identity, options) ?? rawMetricDisplay(group.identity),
}));

export const recordUpstreamMetric = (upstreamId: string, name: string, labels: UpstreamMetricLabels, value: number, timestamp: number): Promise<void> => {
  const identity = normalizeUpstreamMetricIdentity(name, labels);
  return getProviderRepo().recordUpstreamMetric(upstreamId, identity.name, identity.labels, value, timestamp);
};

export const recordUpstreamMetrics = async (
  upstreamId: string,
  metrics: UpstreamMetrics,
  timestamp: number,
): Promise<void> => {
  await Promise.all(metrics.map(metric => recordUpstreamMetric(upstreamId, metric.name, metric.labels, metric.value, timestamp)));
};
