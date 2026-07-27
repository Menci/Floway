import type { ChartProps } from "@fluentui/react-charts";

import type { BillingDimension } from "../../api/types";

export type UsageView = "all-by-user" | "self-by-key";
export type UsageRange = "today" | "7d" | "30d";
export type UsageMetric =
  | "requests" | "cost" | "total" | "input" | "output" | "prefill"
  | "cached" | "cachedRate" | "cacheCreation" | "cacheHitRate";

export interface DisplayUsageRecord {
  keyId: string;
  keyName?: string;
  keyCreatedAt?: string;
  model: string;
  hour: string;
  requests: number;
  tokens: Partial<Record<BillingDimension, number>>;
  cost: number;
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
  activeProvider: string;
}

export interface UsageBucket { key: string; label: string; date: Date }
export interface TokenSummary {
  requests: number; cost: number; input: number; output: number; total: number;
  prefill: number; cacheRead: number; cacheCreation: number;
}
export interface TokenDetail extends TokenSummary { inputImage: number; outputImage: number }
export interface ChartEntry { id: string; label: string; colorSlot: number }
export interface UsageChartModel {
  entries: ChartEntry[];
  data: ChartProps;
  details: Map<string, Map<string, TokenDetail>>;
  buckets: UsageBucket[];
  kind: "token" | "search";
  range: UsageRange;
  stacked: boolean;
}
