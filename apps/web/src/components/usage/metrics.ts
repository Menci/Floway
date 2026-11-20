import type { TokenSummary, UsageMetric } from './types';

export const metricConfig: Record<
  UsageMetric,
  { labelKey: string; kind: 'count' | 'cost' | 'tokens' | 'percent' }
> = {
  requests: { labelKey: 'monitoring.usage.metrics.requests', kind: 'count' },
  cost: { labelKey: 'monitoring.usage.metrics.cost', kind: 'cost' },
  total: { labelKey: 'monitoring.usage.metrics.total', kind: 'tokens' },
  input: { labelKey: 'monitoring.usage.metrics.input', kind: 'tokens' },
  output: { labelKey: 'monitoring.usage.metrics.output', kind: 'tokens' },
  prefill: { labelKey: 'monitoring.usage.metrics.prefill', kind: 'tokens' },
  cached: { labelKey: 'monitoring.usage.metrics.cached', kind: 'tokens' },
  cachedRate: {
    labelKey: 'monitoring.usage.metrics.cachedRate',
    kind: 'percent',
  },
  cacheCreation: {
    labelKey: 'monitoring.usage.metrics.cacheCreation',
    kind: 'tokens',
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
} as const satisfies Record<UsageMetric, keyof TokenSummary>;

export const summaryMetrics: UsageMetric[][] = [
  ['requests', 'cost'],
  ['total', 'output'],
  ['input', 'prefill'],
  ['cached', 'cachedRate'],
  ['cacheCreation'],
];
