import type { ChartProps } from '@fluentui/react-charts';

import type { ChartBucket, DashboardRange } from '../charts/dashboard-time';
import type { ChartSeries } from '../charts/series-legends';
import type { BillingMetric, DecimalString } from '@floway-dev/protocols/common';

export type SearchUsageView = 'all-by-user' | 'self-by-key';
export type UsageRange = DashboardRange;
export type UsageGroupBy = 'keyId' | 'userId' | 'model' | 'upstream';
export type UsageFilters = Record<UsageGroupBy, string[]>;
export type UsageMetric =
  | 'requests' | 'cost' | 'total' | 'input' | 'output' | 'prefill'
  | 'cached' | 'cachedRate' | 'cacheCreation';

export interface DisplayUsageRecord {
  bucket: string;
  group: string;
  requests: number;
  metrics: Partial<Record<BillingMetric, DecimalString>>;
  cost: DecimalString | null;
}

export interface UsageOverviewResponse {
  series: DisplayUsageRecord[];
  axes: Record<UsageGroupBy | 'none', DisplayUsageRecord[]>;
  dimensionValues: {
    keyIds: string[];
    userIds: number[];
    models: string[];
    upstreams: string[];
  };
  users: Array<{ id: number; username: string }>;
  keys: Array<{ id: string; name: string; createdAt: string }>;
}

export interface UsageUpstream {
  id: string;
  name: string;
  hue: number;
}

export interface SearchUsageRecord {
  provider: string;
  keyId: string;
  keyName?: string;
  keyCreatedAt?: string;
  hour: string;
  requests: number;
}

export interface SearchUsageResponse {
  records: SearchUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt?: string }>;
}

// Decimal strings, because aggregate token totals exceed the safe integer range
// and cost is billed to sub-cent precision. Counters stay disjoint: adding a sum
// beside its own addends invites a `+` that concatenates instead of failing.
export interface TokenCounters {
  requests: number;
  cost: DecimalString | null;
  input: DecimalString;
  output: DecimalString;
  cacheRead: DecimalString;
  cacheCreation: DecimalString;
  inputImage: DecimalString;
  outputImage: DecimalString;
}
// Folded: `prompt` is the whole billed prompt side, `output` includes images.
// `cachedRate` is a percentage, null where its denominator has no reading at all.
export interface TokenSummary {
  requests: number;
  cost: DecimalString | null;
  prompt: DecimalString;
  output: DecimalString;
  total: DecimalString;
  prefill: DecimalString;
  cacheRead: DecimalString;
  cacheCreation: DecimalString;
  cachedRate: number | null;
}

export type ChartPlot =
  | { form: 'area'; data: ChartProps }
  | { form: 'line'; data: ChartProps };

interface ChartModelBase {
  entries: ChartSeries[];
  plot: ChartPlot;
  buckets: ChartBucket[];
  range: UsageRange;
}
export type TokenChartModel = ChartModelBase & { kind: 'token'; details: Map<string, Map<string, TokenCounters>> };
// Providers present in the window's data, not the current filter selection.
export type SearchChartModel = ChartModelBase & { kind: 'search'; providers: string[] };
export type UsageChartModel = TokenChartModel | SearchChartModel;

export interface CalloutRow { id: string; label: string; color: string; value: number }
export interface CalloutPoint { x: Date | number | string; rows: CalloutRow[] }
