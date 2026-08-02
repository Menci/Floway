import type { WebSearchConfig, WebSearchProviderName } from '../shared/web-search-providers.ts';
import type { AgentSetupRepository } from '@floway-dev/agent-setup';
import type { AliasSelection, AliasTarget, AnnouncedMetadata, BillingMetric, DecimalString, ModelKind, PricingSelector } from '@floway-dev/protocols/common';
import type { PerformanceTelemetryContext, UpstreamModelsCache, UpstreamRecord } from '@floway-dev/provider';

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
  // null = inherit the user-level cap; array = whitelist in priority order.
  // When both levels carry a list the effective list is their intersection
  // taken in this order, so a key that sets one also decides the priority.
  upstreamIds: string[] | null;
  deletedAt: string | null;
  // null = dump capture disabled; positive integer = seconds of retention.
  dumpRetentionSeconds: number | null;
  // 0 = durable Stateful Responses disabled; a positive value is seconds in
  // whole-day increments. Reuse lifetime is quantized to UTC days.
  responsesRetentionSeconds: number;
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
  // per-key whitelist when both are present. Membership only — the key's
  // order carries the intersection, so this order applies only to requests
  // whose key sets no list of its own.
  upstreamIds: string[] | null;
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
  metrics: UsageMetricRecord[];
}

export interface UsageMetricRecord {
  metric: BillingMetric;
  quantity: DecimalString;
  unitPrice: DecimalString | null;
}

export type UsageQuantities = Partial<Record<BillingMetric, DecimalString>>;

// Disjoint protocol-level token counts. Absent keys mean zero for that
// token category. No key's count overlaps another's. `tier` is only the normalized
// upstream observation used as a runtime pricing fact; it is projected into the
// generic `pricingSelector` at recording time and is not persisted directly.
export interface TokenUsage {
  input?: number;
  input_cache_read?: number;
  input_cache_write?: number;
  input_cache_write_1h?: number;
  input_image?: number;
  output?: number;
  output_image?: number;
  tier?: string | null;
}

export type WebSearchUsageAction = 'search' | 'fetch_page';

export interface WebSearchUsageRecord {
  provider: WebSearchProviderName;
  keyId: string;
  action: WebSearchUsageAction;
  hour: string;
  requests: number;
}

// `ttft_ms` is time to first token in milliseconds; `tpot_us` is time per
// output token in microseconds.
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
  update(id: string, patch: ApiKeyUpdate): Promise<ApiKey | null>;
  softDelete(id: string): Promise<boolean>;
  softDeleteByUserId(userId: number): Promise<number>;
  deleteAll(): Promise<void>;
}

export type ApiKeyUpdate = Partial<Pick<
  ApiKey,
  'name' | 'key' | 'lastUsedAt' | 'upstreamIds' | 'dumpRetentionSeconds' | 'responsesRetentionSeconds'
>>;

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
  // pricingSelector, metric) conflict, quantities are summed exactly. The
  // first write establishes the unit-price snapshot, including an unpriced
  // snapshot; later writes that share the row keep it unchanged.
  record(record: UsageRecord): Promise<void>;
  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]>;
  listAll(): Promise<UsageRecord[]>;
  // Replacement upsert: quantities and unit prices are overwritten from the record.
  set(record: UsageRecord): Promise<void>;
  deleteAll(): Promise<void>;
}

export interface WebSearchUsageRepo {
  record(args: { provider: WebSearchProviderName; keyId: string; action: WebSearchUsageAction; hour: string; requests: number }): Promise<void>;
  query(opts: { provider?: WebSearchProviderName; keyId?: string; action?: WebSearchUsageAction; start: string; end: string }): Promise<WebSearchUsageRecord[]>;
  listAll(): Promise<WebSearchUsageRecord[]>;
  set(record: WebSearchUsageRecord): Promise<void>;
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

export interface WebSearchConfigRepo {
  get(): Promise<unknown>;
  save(config: WebSearchConfig): Promise<void>;
}

export interface UpstreamRepo {
  list(): Promise<UpstreamRecord[]>;
  getById(id: string): Promise<UpstreamRecord | null>;
  save(upstream: UpstreamRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  // Upstream state write with optimistic concurrency, used both by the
  // gateway's own token-rotation work and by the operator-triggered OAuth
  // refresh / probe routes. The repo reads, applies `mutate`, and writes under
  // a CAS, retrying against the winner when it loses; exhausting the retries
  // throws. See UpstreamsRepoSlim in @floway-dev/provider for why the change
  // is a function.
  saveState(id: string, mutate: (current: unknown) => unknown): Promise<void>;
  // Catalog-cache writes. They touch only the cache column, so a refresh and a
  // credential write to the same row do not contend — `saveState`'s CAS
  // predicate reads `state_json` alone.
  saveModelsCache(id: string, cache: Omit<UpstreamModelsCache, 'lastError'>): Promise<void>;
  saveModelsCacheError(id: string, error: NonNullable<UpstreamModelsCache['lastError']>): Promise<void>;
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
  // Server-issued row handle. Stable across renames, so it is what the
  // control-plane routes address; `name` is operator-owned public data.
  id: string;
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
  getById(id: string): Promise<ModelAliasRecord | null>;
  getByName(name: string): Promise<ModelAliasRecord | null>;
  // Throws on name collision. The thrown Error's message contains
  // `UNIQUE constraint failed: model_aliases.name` — SQLite's own
  // constraint-violation string — so the route layer can match on the
  // message and surface a 409 without knowing which repo backend fired.
  insert(record: ModelAliasRecord): Promise<void>;
  // Overwrites the row keyed by `record.id`, renames included: `name` is a
  // plain column now, so a rename is one UPDATE. Throws when the id does not
  // exist, or when the new name collides with a different row (same
  // `UNIQUE constraint failed: model_aliases.name` message as `insert`).
  update(record: ModelAliasRecord): Promise<void>;
  delete(id: string): Promise<boolean>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesItem {
  id: string;
  apiKeyId: string;
  payload: StoredResponsesItemPayload;
  itemHash: string;
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
  lookupMany(apiKeyId: string, ids: readonly string[], earliestVisibleCutoff: number): Promise<StoredResponsesItem[]>;
  lookupManyByItemHash(apiKeyId: string, hashes: readonly string[], earliestVisibleCutoff: number): Promise<StoredResponsesItem[]>;
  insertMany(items: readonly StoredResponsesItem[], earliestVisibleCutoff: number): Promise<void>;
  refreshMany(items: readonly StoredResponsesItem[], refreshedAt: number, earliestVisibleCutoff: number): Promise<void>;
  deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number>;
  findOldestRefreshedAt(apiKeyId: string): Promise<number | null>;
  deleteAll(): Promise<void>;
}

export interface StoredResponsesSnapshot {
  id: string;
  apiKeyId: string;
  itemIds: string[];
  refreshedAt: number;
}

export interface ResponsesSnapshotsRepo {
  lookup(apiKeyId: string, id: string, earliestVisibleCutoff: number): Promise<StoredResponsesSnapshot | null>;
  insert(snapshot: StoredResponsesSnapshot): Promise<void>;
  deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number>;
  findOldestRefreshedAt(apiKeyId: string): Promise<number | null>;
  deleteAll(): Promise<void>;
}

export interface SpilledFilesRepo {
  claimCollectible(token: string, now: number, staleClaimedBefore: number, limit: number): Promise<string[]>;
  acknowledge(token: string): Promise<number>;
}

export type ExpirationDomain = 'responses' | 'dumps';

export interface ExpirationSweepClaim {
  domain: ExpirationDomain;
  keyId: string;
  revision: number;
}

export type ExpirationSweepCompletion =
  | { kind: 'drained'; nextDueAt: number | null }
  | { kind: 'partial'; retryAt: number };

export interface ExpirationSweepsRepo {
  backfillCleanupTracking(limit: number): Promise<void>;
  schedule(domain: ExpirationDomain, keyId: string, dueAt: number): Promise<void>;
  claim(token: string, now: number, staleClaimedBefore: number): Promise<ExpirationSweepClaim | null>;
  complete(token: string, expectedRevision: number, completion: ExpirationSweepCompletion): Promise<void>;
}

// The Agent Setup lease store. Its shape, record, and mutation discriminants
// are owned by @floway-dev/agent-setup; the SQL and in-memory implementations
// here satisfy that contract. Re-exported so the repo layer imports one source.
export type { AgentSetupMutation, AgentSetupRecord, AgentSetupRenewal, AgentSetupRepository } from '@floway-dev/agent-setup';

export interface Repo {
  apiKeys: ApiKeyRepo;
  users: UsersRepo;
  sessions: SessionsRepo;
  usage: UsageRepo;
  webSearchUsage: WebSearchUsageRepo;
  performance: PerformanceRepo;
  webSearchConfig: WebSearchConfigRepo;
  upstreams: UpstreamRepo;
  proxies: ProxyRepo;
  proxyBackoffs: ProxyBackoffRepo;
  modelAliases: ModelAliasesRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;
  spilledFiles: SpilledFilesRepo;
  expirationSweeps: ExpirationSweepsRepo;
  agentSetup: AgentSetupRepository;
}
