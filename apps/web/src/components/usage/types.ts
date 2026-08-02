import type { ChartProps } from '@fluentui/react-charts';

import type { BillingMetric } from '../../api/types';
import type { ChartBucket, DashboardRange } from '../charts/dashboard-time';
import type { ChartSeries } from '../charts/series-legends';
import type { DecimalString } from '@floway-dev/protocols/common';

export type UsageView = 'all-by-user' | 'self-by-key';
export type UsageRange = DashboardRange;
export type UsageMetric =
  | 'requests' | 'cost' | 'total' | 'input' | 'output' | 'prefill'
  | 'cached' | 'cachedRate' | 'cacheCreation' | 'cacheHitRate';

export interface DisplayUsageRecord {
  keyId: string;
  keyName?: string;
  keyCreatedAt?: string;
  model: string;
  hour: string;
  requests: number;
  metrics: Partial<Record<BillingMetric, DecimalString>>;
  cost: DecimalString | null;
}

export interface UsageResponse {
  records: DisplayUsageRecord[];
  keys: Array<{ id: string; name: string; createdAt?: string }>;
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
// and cost is billed to sub-cent precision. Counters stay disjoint: a sum kept
// beside its own addends invites a recomputation that decimal strings would
// silently turn into a concatenation rather than a type error.
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
// `prompt` is the whole billed prompt side and `output` folds the separately
// metered image counter in, so no consumer re-derives either.
export interface TokenSummary {
  requests: number;
  cost: DecimalString | null;
  prompt: DecimalString;
  output: DecimalString;
  total: DecimalString;
  prefill: DecimalString;
  cacheRead: DecimalString;
  cacheCreation: DecimalString;
}

// Percentage rates stay lines so their shared 0-100 scale remains readable.
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
// The providers actually plotted, which is a property of the window's data
// rather than of the current configuration.
export type SearchChartModel = ChartModelBase & { kind: 'search'; providers: string[] };
export type UsageChartModel = TokenChartModel | SearchChartModel;

export interface CalloutRow { id: string; label: string; color: string; value: number }
export interface CalloutPoint { x: Date | number | string; rows: CalloutRow[] }
