import type { ChartProps, VerticalStackedChartProps } from '@fluentui/react-charts';

import type { BillingMetric } from '../../api/types';
import type { DashboardRange } from '../charts/dashboard-time';
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

export interface UsageBucket { key: string; label: string; date: Date }
// Requests are a plain count; everything else is a decimal string, because
// aggregate token totals exceed the safe integer range and cost is billed to
// sub-cent precision.
//
// Disjoint per-metric counters, exactly as recorded. Nothing derived is stored
// beside them: a sum kept next to its own addends invites a consumer to
// recompute it, and decimal strings make that recomputation silently produce a
// concatenation rather than a type error.
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
// Every figure the dashboard displays for one counter set. `prompt` is the
// whole billed prompt side and `output` folds the separately metered image
// counter in, so no consumer re-derives either.
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
export interface ChartEntry { id: string; label: string; colorSlot: number }

// Token, request and cost figures are sums over a bucket, so they are drawn as
// stacked bars: a bar states "this much was consumed in this interval" and
// nothing between two bars. Rates are a different kind of quantity — they hold
// between samples and have no meaningful sum — so they stay a line, and a
// bucket with no traffic breaks it rather than reading as a measured zero.
export type ChartPlot =
  | { form: 'bars'; bars: VerticalStackedChartProps[] }
  | { form: 'line'; data: ChartProps };

interface ChartModelBase {
  entries: ChartEntry[];
  plot: ChartPlot;
  details: Map<string, Map<string, TokenCounters>>;
  buckets: UsageBucket[];
  range: UsageRange;
}
// A search chart names the providers whose records it actually plotted, which
// is a property of the window's data rather than of the current configuration.
export type SearchChartModel = ChartModelBase & { kind: 'search'; providers: string[] };
export type UsageChartModel = ChartModelBase & ({ kind: 'token' } | { kind: 'search'; providers: string[] });

// One hovered bucket, normalized across the two plot forms so the callout does
// not care which component produced it.
export interface CalloutRow { legend: string; color: string; value: number }
export interface CalloutPoint { x: Date | number | string; rows: CalloutRow[] }
