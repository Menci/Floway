import type { SearchConfig, WebSearchProviderName } from '../shared/web-search-providers.ts';
export type { SearchConfig } from '../shared/web-search-providers.ts';
import type { AliasSelection, AliasTarget, AnnouncedMetadata, BillingDimension, ModelKind, PriceVector, PricingSelector } from '@floway-dev/protocols/common';
import type { PerformanceTelemetryContext, ProviderModel, UpstreamRecord } from '@floway-dev/provider';

export interface ApiKey {
  id: string;
  userId: number;
  name: string;
  key: string;
  // Hidden server-private key material attached to this API key. Normal CRUD
  // never exposes it; admin data transfer preserves it across deployments.
  serverSecret: string;
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
  // null = the row is not a credential — sign-in is only possible via
  // the blank-username /auth/login path (ADMIN_KEY match, or the
  // dev-only passwordless shortcut when ADMIN_KEY is unset).
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
  // Canonical, self-describing selector coordinate for this bucket. The SQL
  // identity stores its sorted-key JSON form; repository reads expose the typed
  // object. `{}` is the base coordinate.
  pricingSelector: PricingSelector;
  requests: number;
  // Disjoint per-dimension token counts for this selector bucket.
  tokens: Partial<Record<BillingDimension, number>>;
  // Resolved per-dimension price snapshot for this exact selector coordinate.
  // null means the model had no pricing metadata. Selector misses inside a
  // configured rate card resolve to Base before reaching the repo. Repos
  // persist one unit price per token-bearing dimension; null contributes zero
  // realized cost.
  rates: PriceVector | null;
}

// Disjoint per-dimension token counts. Absent keys mean zero for that
// dimension. No key's count overlaps another's. `tier` is only the normalized
// upstream observation used as a runtime pricing fact; it is projected into the
// generic `pricingSelector` at recording time and is not persisted directly.
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

export type PerformanceMetric = 'ttft_ms' | 'tpot_us';

// A performance-summary row is a `PerformanceTelemetryContext` (the provider-
// facing telemetry identity the recorder threads through the request) plus
// the aggregation bucket. Keeping the shape a strict extension guarantees a
// context can be spread into a dimensions object without repeating field
// names or drifting them out of sync.
export interface PerformanceDimensions extends PerformanceTelemetryContext {
  hour: string;              // 'YYYY-MM-DDTHH'
}

// TPOT is measurable only when at least two output tokens are streamed; the
// caller (recordPerformance) enforces that gate before setting `tpotUs`. A
// TTFT-only sample omits it entirely.
//
// `success` discriminates a healthy TTFT sample from a partial-output failure
// — the stream produced enough to yield a real TTFT (and possibly TPOT)
// sample before failing. The repo routes the row to `ttft_samples_ok` when
// success is true, or `errors_with_output` when false, so the counter
// partition stays disjoint by construction.
export interface PerformanceSample extends PerformanceDimensions {
  ttftMs: number;
  tpotUs?: number;
  success: boolean;
}

export interface PerformanceBucketRow {
  metric: PerformanceMetric;
  lower: number;
  upper: number | null;
  count: number;
}

// Partition-first counters — exactly one of the four counters bumps per
// request, and their sum equals `requests`. `tpotSamples` is orthogonal (a
// subset of `ttftSamplesOk + errorsWithOutput` where the stream produced
// at least two output tokens). Display-friendly totals derive at
// aggregation time:
//   ttftSamples = ttftSamplesOk + errorsWithOutput
//   errors      = errorsWithOutput + errorsNoOutput
export interface PerformanceTelemetryRecord extends PerformanceDimensions {
  requests: number;
  ttftSamplesOk: number;      // successful streams with a TTFT stamp
  errorsWithOutput: number;   // failures that streamed at least one token (carry a TTFT sample)
  errorsNoOutput: number;     // pre-stream / usage-never-arrived failures
  neutral: number;            // successes with no TTFT (non-chat / no upstream call / no first-token frame)
  tpotSamples: number;        // subset of TTFT-carrying rows with a measurable inter-token interval
  ttftMsSum: number;
  tpotUsSum: number;
  buckets: readonly PerformanceBucketRow[];
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
  // Additive upsert: on (keyId, model, upstream, modelKey, hour,
  // pricingSelector) conflict, token counts are summed. The first write for
  // each dimension establishes its pricing snapshot, including an unpriced
  // snapshot; later writes that share the bucket keep it unchanged.
  record(record: UsageRecord): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  // Replacement upsert: counts and rates are both overwritten from the record.
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
  // Bumps `requests` + one of {ttftSamplesOk, errorsWithOutput} based on
  // `sample.success`, and adds `sample.ttftMs` to `ttftMsSum` plus one TTFT
  // bucket. When `sample.tpotUs` is set, also bumps `tpotSamples`, adds to
  // `tpotUsSum`, and lands one TPOT bucket — a partial-output failure whose
  // stream produced a real TTFT before dying still contributes latency data
  // alongside its error accounting.
  recordSample(sample: PerformanceSample): Promise<void>;
  // Increments `requests` and `errorsNoOutput`; leaves the latency sums,
  // sample counts, and buckets untouched. Used for failures that produced no
  // output tokens (pre-stream / usage-never-arrived errors).
  recordZeroOutputError(dims: PerformanceDimensions): Promise<void>;
  // Increments `requests` and `neutral`; leaves the error counts, latency
  // sums, sample counts, and buckets untouched. Used for successful non-chat
  // calls and chat successes that never got a first output token or a real
  // upstream call.
  recordNeutral(dims: PerformanceDimensions): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<PerformanceTelemetryRecord[]>;
  listAll(): Promise<PerformanceTelemetryRecord[]>;
  // Replacement upsert used by admin restore paths.
  set(record: PerformanceTelemetryRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface CachedModelsRow {
  revision: number;
  fetchedAt: number;
  models: ProviderModel[];
  lastError: { message: string; at: number } | null;
}

export interface ModelsCacheRepo {
  get(upstreamId: string): Promise<CachedModelsRow | null>;
  put(upstreamId: string, row: { revision: number; fetchedAt: number; models: ProviderModel[] }): Promise<void>;
  setLastError(upstreamId: string, error: { message: string; at: number } | null): Promise<void>;
  delete(upstreamId: string): Promise<void>;
}

export interface SearchConfigRepo {
  get(): Promise<unknown>;
  save(config: SearchConfig): Promise<void>;
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

// One alias row. The wire DTO (`ModelAlias` in @floway-dev/protocols/common)
// is the snake_case projection of this record; conversion lives in
// control-plane/model-aliases/serialize.ts.
export interface ModelAliasRecord {
  name: string;
  kind: ModelKind;
  selection: AliasSelection;
  // null = derive at render time from targets + rules.
  displayName: string | null;
  // Listing-only visibility: filtered by `synthesizeListedAliases` before
  // an alias enters /v1/models. Dispatch stays alias-agnostic on this flag,
  // so a hidden alias remains resolvable at request time.
  visibleInModelsList: boolean;
  // Order is meaningful for selection=first-available; preserved (but
  // ignored) for selection=random.
  targets: AliasTarget[];
  // null = compute the announced /v1/models payload automatically from
  // targets + rules at listing time. A non-null payload replaces the
  // computed value at the top-level sub-block boundary (`limits` /
  // `chat`); omitted sub-blocks fall back to the computation but a
  // present sub-block wins wholesale (it does not merge per-leaf).
  announcedMetadata: AnnouncedMetadata | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelAliasesRepo {
  list(): Promise<ModelAliasRecord[]>;
  getByName(name: string): Promise<ModelAliasRecord | null>;
  // Throws on primary-key collision. The thrown Error's message contains
  // `UNIQUE constraint failed: model_aliases.name` — SQLite's own PK
  // violation string — so the route layer can match on the message and
  // surface a 409 without knowing which repo backend fired.
  insert(record: ModelAliasRecord): Promise<void>;
  // Replaces the row keyed by `oldName`. When oldName === record.name the
  // call is a plain UPDATE; when they differ this is a rename, executed as
  // INSERT(new) + DELETE(old) inside one transaction so dependent reads
  // stay consistent. Throws when `oldName` does not exist, or when the
  // rename target already collides with a different row (same
  // `UNIQUE constraint failed: model_aliases.name` message as `insert`).
  update(oldName: string, record: ModelAliasRecord): Promise<void>;
  delete(name: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesItem {
  id: string;
  apiKeyId: string;
  itemType: string;
  payload: StoredResponsesItemPayload;
  contentHash: string | null;
  createdAt: number;
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
  lookupMany(apiKeyId: string, ids: readonly string[]): Promise<StoredResponsesItem[]>;
  lookupManyByContentHash(apiKeyId: string, hashes: readonly string[]): Promise<StoredResponsesItem[]>;
  insertMany(items: readonly StoredResponsesItem[]): Promise<void>;
  refreshMany(items: readonly StoredResponsesItem[], createdAt: number): Promise<void>;
  deleteOlderThan(createdBefore: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesSnapshot {
  id: string;
  apiKeyId: string;
  itemIds: string[];
  createdAt: number;
}

export interface ResponsesSnapshotsRepo {
  lookup(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null>;
  insert(snapshot: StoredResponsesSnapshot): Promise<void>;
  deleteOlderThan(createdBefore: number): Promise<number>;
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
  modelAliases: ModelAliasesRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;
}
