import type { TokenSummary, UsageMetric } from './types';

export const metricConfig: Record<
  UsageMetric,
  { labelKey: string; kind: 'count' | 'cost' | 'tokens' | 'percent' }
> = {
  requests: { labelKey: 'dashboard.usage.metrics.requests', kind: 'count' },
  cost: { labelKey: 'dashboard.usage.metrics.cost', kind: 'cost' },
  total: { labelKey: 'dashboard.usage.metrics.total', kind: 'tokens' },
  input: { labelKey: 'dashboard.usage.metrics.input', kind: 'tokens' },
  output: { labelKey: 'dashboard.usage.metrics.output', kind: 'tokens' },
  prefill: { labelKey: 'dashboard.usage.metrics.prefill', kind: 'tokens' },
  cached: { labelKey: 'dashboard.usage.metrics.cached', kind: 'tokens' },
  cachedRate: {
    labelKey: 'dashboard.usage.metrics.cachedRate',
    kind: 'percent',
  },
  cacheCreation: {
    labelKey: 'dashboard.usage.metrics.cacheCreation',
    kind: 'tokens',
  },
  cacheHitRate: {
    labelKey: 'dashboard.usage.metrics.cacheHitRate',
    kind: 'percent',
  },
};

// A metric id is the reader's vocabulary and a summary field is the algebra's;
// this pairing is the only place the two vocabularies meet, so what a metric
// sums stays defined once, in `summarizeCounters`.
export const summaryFieldForMetric = {
  requests: 'requests',
  cost: 'cost',
  total: 'total',
  input: 'prompt',
  output: 'output',
  prefill: 'prefill',
  cached: 'cacheRead',
  cacheCreation: 'cacheCreation',
  cachedRate: 'cachedRate',
  cacheHitRate: 'cacheHitRate',
} as const satisfies Record<UsageMetric, keyof TokenSummary>;

export const summaryMetrics: UsageMetric[][] = [
  ['requests', 'cost'],
  ['total', 'output'],
  ['input', 'prefill'],
  ['cached', 'cachedRate'],
  ['cacheCreation', 'cacheHitRate'],
];
