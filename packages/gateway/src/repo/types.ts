import type { HistogramBucket } from '../shared/performance-histogram.ts';
import type { WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { BillingDimension, ModelPricing } from '@floway-dev/protocols/common';
import type { UpstreamRecord, ProviderModel } from '@floway-dev/provider';

export interface ApiKey {
  id: string;
  userId: number;
  name: string;
  key: string;
  createdAt: string;
  lastUsedAt?: string;
  // null = inherit global upstream order; array = whitelist + priority order.
  upstreamIds: string[] | null;
  deletedAt: string | null;
  // null = dump capture disabled; positive integer = seconds of retention.
  dumpRetentionSeconds: number | null;
}

export interface User {
  id: number;
  username: string;
  // null = the row is not a credential — sign-in is only possible through
  // the ADMIN_KEY backdoor.
  passwordHash: string | null;
  isAdmin: boolean;
  // null = unrestricted at the user level; an array intersects with the
  // per-key whitelist when both are present.
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
  deletedAt: string | null;
}

export interface Session {
  id: string;
  userId: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface UsageRecord {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  // Service tier the upstream stamped on this bucket (Anthropic `speed`,
  // OpenAI `service_tier`). null = the base / default tier. Distinct tiers
  // for the same (keyId, model, upstream, modelKey, hour) are stored as
  // separate buckets so per-tier pricing overrides apply correctly.
  tier: string | null;
  requests: number;
  // Disjoint per-dimension token counts for this bucket. The tier the bucket
  // was stamped under lives on the `tier` field above — do not encode it
  // inside this map.
  tokens: Partial<Record<BillingDimension, number>>;
  // Pricing snapshot taken at write time. null means the provider did not
  // resolve pricing for this model (Custom upstreams, unknown Copilot
  // public id, etc.). The repo derives per-dimension unit prices from it via
  // unitPriceForDimension after `resolveEffectivePricing(cost, tier)` folds
  // in the bucket's tier override; aggregation treats a null snapshot as
  // cost 0.
  cost: ModelPricing | null;
}

// Disjoint per-dimension token counts. Absent keys mean zero for that
// dimension. No key's count overlaps another's. `tier` is the upstream-
// reported service-tier marker (Anthropic `usage.speed`, OpenAI
// `usage.service_tier`) that selects an override against `cost.tiers`
// before any per-dimension unit-price lookup; absent / null = the model's
// base pricing applies.
export interface TokenUsage extends Partial<Record<BillingDimension, number>> {
  tier?: string | null;
}

export type SearchUsageAction = 'search' | 'fetch_page';

export interface SearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  action: SearchUsageAction;
  hour: string;
  requests: number;
}

export type PerformanceMetricScope = 'request_total' | 'upstream_success';

export interface PerformanceDimensions {
  hour: string;
  metricScope: PerformanceMetricScope;
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  stream: boolean;
  runtimeLocation: string;
}

export interface PerformanceLatencySample extends PerformanceDimensions {
  durationMs: number;
}

export type PerformanceErrorSample = PerformanceDimensions;

export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  errors: number;
  totalMsSum: number;
  buckets: HistogramBucket[];
}

export interface ApiKeyRepo {
  list(): Promise<ApiKey[]>;
  // Includes soft-deleted rows so the user_id behind a historical key stays
  // resolvable after the owner rotates or deletes it.
  listIncludingDeleted(): Promise<ApiKey[]>;
  listByUserId(userId: number): Promise<ApiKey[]>;
  // Includes the user's own soft-deleted keys so a rotated key's name still
  // resolves when attributing past usage.
  listByUserIdIncludingDeleted(userId: number): Promise<ApiKey[]>;
  findByRawKey(rawKey: string): Promise<ApiKey | null>;
  getById(id: string): Promise<ApiKey | null>;
  idsByUserIdIncludingDeleted(userId: number): Promise<string[]>;
  save(key: ApiKey): Promise<void>;
  softDelete(id: string): Promise<boolean>;
  softDeleteByUserId(userId: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface UsersRepo {
  list(): Promise<User[]>;
  listIncludingDeleted(): Promise<User[]>;
  getById(id: number): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  // Atomic insert that allocates id = MAX(id) + 1 in a single statement so two
  // concurrent admin creates can't compute the same id and silently overwrite
  // each other.
  createNewUser(template: Omit<User, 'id'>): Promise<User>;
  // Throws when the username is already taken by another active row, so
  // duplicate-username races surface instead of silently overwriting state.
  save(user: User): Promise<void>;
  softDelete(id: number): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface SessionsRepo {
  getByIdAndTouch(id: string): Promise<Session | null>;
  create(userId: number): Promise<Session>;
  deleteById(id: string): Promise<boolean>;
  deleteByUserId(userId: number): Promise<number>;
  deleteByUserIdExcept(userId: number, exceptId: string): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface UsageRepo {
  // Additive upsert: on (keyId, model, upstream, modelKey, hour, tier)
  // conflict, token counts are summed. cost is COALESCED — the first write
  // within a bucket establishes the pricing snapshot for that row, later
  // writes that share the bucket keep the original snapshot.
  record(record: UsageRecord): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  // Replacement upsert: counts and cost are both overwritten from the record.
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface SearchUsageRepo {
  record(args: { provider: WebSearchProviderName; keyId: string; action: SearchUsageAction; hour: string; requests: number }): Promise<void>;
  query(opts: { provider?: WebSearchProviderName; keyId?: string; action?: SearchUsageAction; start: string; end: string }): Promise<SearchUsageRecord[]>;
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

export interface CachedModelsRow {
  fetchedAt: number;
  models: ProviderModel[];
  lastError: { message: string; at: number } | null;
}

export interface ModelsCacheRepo {
  get(upstreamId: string): Promise<CachedModelsRow | null>;
  put(upstreamId: string, row: { fetchedAt: number; models: ProviderModel[] }): Promise<void>;
  setLastError(upstreamId: string, error: { message: string; at: number } | null): Promise<void>;
  delete(upstreamId: string): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown>;
  save(config: unknown): Promise<void>;
}

export interface UpstreamRepo {
  list(): Promise<UpstreamRecord[]>;
  getById(id: string): Promise<UpstreamRecord | null>;
  save(upstream: UpstreamRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  // Gateway autonomous state write with optimistic concurrency. Returns
  // updated:true only if the row's state_json equals the serialized form of
  // options.expectedState at write time. On updated:false the caller re-reads
  // and decides whether to retry or drop the update.
  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }>;
}

export interface ProxyRecord {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  // Operator-set per-proxy override of the dial-stage deadline (seconds).
  // null falls back to the gateway-wide dial-stage default.
  dialTimeoutSeconds: number | null;
}

export interface ProxyRepo {
  list(): Promise<ProxyRecord[]>;
  getById(id: string): Promise<ProxyRecord | null>;
  insert(input: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<ProxyRecord>;
  // Returns the updated record alongside the bit `url` actually changed by
  // this patch so callers that react to URL edits (e.g. wiping outstanding
  // backoff rows) don't need a redundant getById round-trip.
  patch(id: string, patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null }): Promise<{ record: ProxyRecord; urlChanged: boolean } | null>;
  // Upsert: an id collision overwrites the configurable columns (name, url,
  // dial_timeout_seconds) and refreshes updated_at; created_at belongs to the
  // local deployment and is preserved.
  save(record: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  findUpstreamsReferencing(proxyId: string): Promise<string[]>;
}

export interface BackoffRow {
  proxyId: string;
  upstreamId: string;
  failCount: number;
  // Unix seconds.
  expiresAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface ProxyBackoffRepo {
  recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void>;
  recordDialSuccess(proxyId: string, upstreamId: string): Promise<void>;
  listForUpstream(upstreamId: string): Promise<BackoffRow[]>;
  listForProxy(proxyId: string): Promise<BackoffRow[]>;
  listAll(): Promise<BackoffRow[]>;
  resetForProxy(proxyId: string): Promise<void>;
  resetForUpstream(upstreamId: string): Promise<void>;
  reset(proxyId: string, upstreamId: string): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesItem {
  id: string;
  apiKeyId: string | null;
  upstreamId: string | null;
  upstreamItemId: string | null;
  itemType: string;
  origin: 'input' | 'upstream' | 'synthetic';
  payload: StoredResponsesItemPayload | null;
  contentHash: string | null;
  // sha256 of the item's `encrypted_content`, when it carries one (reasoning /
  // compaction). Lets a later turn that echoes the blob without a gateway id
  // recover this row's owning upstream for affinity routing.
  encryptedContentHash: string | null;
  createdAt: number;
  refreshedAt: number;
}

export interface StoredResponsesItemPayload {
  item: unknown;
  // Ancillary state stashed alongside the public `item` body but never sent on
  // the wire: a server-only slot to preserve data a stateless client strips
  // from the echoed item (e.g. the real `web_search_call` results) so a later
  // turn can restore it on replay. Persisted and round-tripped verbatim.
  private?: unknown;
}

export interface ResponsesItemsRepo {
  lookupMany(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItem[]>;
  lookupManyByContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]>;
  lookupManyByEncryptedContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]>;
  insertMany(items: readonly StoredResponsesItem[]): Promise<void>;
  fillPayloads(items: readonly StoredResponsesItem[]): Promise<number>;
  refreshMany(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<number>;
  clearPayloadOlderThan(createdBefore: number): Promise<number>;
  deleteOlderThan(refreshedBefore: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesSnapshot {
  id: string;
  apiKeyId: string | null;
  itemIds: string[];
  createdAt: number;
  refreshedAt: number;
}

export interface ResponsesSnapshotsRepo {
  lookup(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null>;
  insert(snapshot: StoredResponsesSnapshot): Promise<void>;
  refresh(apiKeyId: string | null, id: string, refreshedAt: number): Promise<boolean>;
  deleteOlderThan(refreshedBefore: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface Repo {
  apiKeys: ApiKeyRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  modelsCache: ModelsCacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;
  proxies: ProxyRepo;
  proxyBackoffs: ProxyBackoffRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;
}
