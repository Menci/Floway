import type { UsageMetric } from './types';

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

export const summaryMetrics: UsageMetric[][] = [
  ['requests', 'cost'],
  ['total', 'output'],
  ['input', 'prefill'],
  ['cached', 'cachedRate'],
  ['cacheCreation', 'cacheHitRate'],
];
