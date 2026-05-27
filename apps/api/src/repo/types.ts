import type { HistogramBucket } from '../shared/performance-histogram.ts';
import type { WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  // null = inherit global upstream order; array = whitelist + priority order.
  upstreamIds: string[] | null;
}

export interface UsageRecord {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  // Pricing snapshot taken at write time. null means the provider did not
  // resolve pricing for this model (Custom upstreams, unknown Copilot
  // public id, etc.). Aggregation treats null as cost 0.
  cost: ModelPricing | null;
}

export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  // Pricing snapshot resolved at request time by the provider that served
  // the call. Travels alongside the identity end-to-end so telemetry writes
  // never have to re-resolve. null when no pricing is configured.
  cost: ModelPricing | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  hour: string;
  requests: number;
}

export type PerformanceMetricScope = 'request_total' | 'upstream_success';
export type PerformanceApiName = 'messages' | 'responses' | 'chat-completions' | 'gemini' | 'embeddings' | 'images_generations' | 'images_edits';

export interface PerformanceDimensions {
  hour: string;
  metricScope: PerformanceMetricScope;
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  sourceApi: PerformanceApiName;
  targetApi: PerformanceApiName;
  stream: boolean;
  runtimeLocation: string;
}

export interface PerformanceLatencySample extends PerformanceDimensions {
  durationMs: number;
}

export interface PerformanceErrorSample extends PerformanceDimensions {}

export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  errors: number;
  totalMsSum: number;
  buckets: HistogramBucket[];
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  save(key: ApiKey): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface UsageRepo {
  // Additive upsert: on (keyId, model, upstream, modelKey, hour) conflict,
  // token counts are summed. cost is COALESCED — the first write within a
  // bucket establishes the pricing snapshot for that row, later writes that
  // share the bucket keep the original snapshot.
  record(record: UsageRecord): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  // Replacement upsert (counts and cost both overwritten from the record).
  // Used by import/restore flows.
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchUsageRepo {
  record(provider: WebSearchProviderName, keyId: string, hour: string, requests: number): Promise<void>;
  query(opts: { provider?: WebSearchProviderName; keyId?: string; start: string; end: string }): Promise<SearchUsageRecord[]>;
  listAll(): Promise<SearchUsageRecord[]>;
  set(record: SearchUsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface PerformanceRepo {
  recordLatency(sample: PerformanceLatencySample): Promise<void>;
  recordError(sample: PerformanceErrorSample): Promise<void>;
  query(opts: { keyId?: string; metricScope?: PerformanceMetricScope; start: string; end: string }): Promise<PerformanceTelemetryRecord[]>;
  listAll(): Promise<PerformanceTelemetryRecord[]>;
  set(record: PerformanceTelemetryRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CacheRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown | null>;
  save(config: unknown): Promise<void>;
}

export type UpstreamProviderKind = 'copilot' | 'custom' | 'azure';

export interface UpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  config: unknown;
  flagOverrides: Record<string, boolean>;
}

export interface UpstreamRepo {
  list(): Promise<UpstreamRecord[]>;
  getById(id: string): Promise<UpstreamRecord | null>;
  save(upstream: UpstreamRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;
}
