import { normalizeDisabledPublicModelIds } from '../../src/repo/disabled-public-models.ts';
import { normalizeFlagOverrides } from '../../src/repo/flag-overrides.ts';
import { normalizeProxyFallbackList } from '../../src/repo/proxy-fallback-list.ts';
import {
  assertSameStoredResponsesItem,
  cloneStoredResponsesItem,
  cloneStoredResponsesSnapshot,
  compareResponsesItemsByFreshness,
  scopedResponsesKey,
} from '../../src/repo/responses-clone.ts';
import { quantizeResponsesRefreshedAt, RESPONSES_REFRESH_GRANULARITY_MS, responsesStateCutoff } from '../../src/repo/responses-retention.ts';
import { SEED_ADMIN_USER_ID } from '../../src/repo/seed-admin.ts';
import { generateSessionToken } from '../../src/repo/session-tokens.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  ApiKeyUpdate,
  ExpirationDomain,
  ExpirationSweepCompletion,
  ExpirationSweepClaim,
  ExpirationSweepsRepo,
  AgentSetupMutation,
  AgentSetupRecord,
  AgentSetupRenewal,
  AgentSetupRepository,
  BackoffRow,
  ModelAliasesRepo,
  ModelAliasRecord,
  PerformanceDimensions,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  PerformanceSample,
  PerformanceBucketRow,
  PerformanceMetric,
  ProxyBackoffRepo,
  ProxyRecord,
  ProxyRepo,
  Repo,
  ResponsesItemsRepo,
  ResponsesSnapshotsRepo,
  SpilledFilesRepo,
  WebSearchConfigRepo,
  WebSearchUsageRecord,
  WebSearchUsageRepo,
  Session,
  SessionsRepo,
  StoredResponsesItem,
  StoredResponsesSnapshot,
  UpstreamRepo,
  UsageRecord,
  UsageRepo,
  User,
  UsersRepo,
} from '../../src/repo/types.ts';
import { serializeStoredState } from '../../src/repo/upstream-json.ts';
import { usageMetricRows } from '../../src/repo/usage-metrics.ts';
import { bucketForTtftMs, bucketForTpotUs } from '../../src/shared/performance-histogram.ts';
import { assertWebSearchProviderName, type WebSearchConfig } from '../../src/shared/web-search-providers.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';
import { addDecimalStrings, canonicalPricingSelectorKey, canonicalizePricingSelector, type BillingMetric, type DecimalString, type PricingSelector } from '@floway-dev/protocols/common';
import { UpstreamGoneError, type UpstreamModelsCache, type UpstreamRecord } from '@floway-dev/provider';

const SEED_ADMIN_USER: User = {
  id: SEED_ADMIN_USER_ID,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  upstreamIds: null,
  createdAt: new Date(0).toISOString(),
  deletedAt: null,
};

// Mirror the SQL `username TEXT COLLATE NOCASE` collation: usernames match
// case-insensitively for both lookup and uniqueness. `USERNAME_PATTERN`
// restricts usernames to ASCII, so a plain `toLowerCase()` fold is exactly
// SQLite's NOCASE.
const usernamesMatch = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

class MemoryUsersRepo implements UsersRepo {
  private users: User[] = [{ ...SEED_ADMIN_USER }];

  list(): Promise<User[]> {
    return Promise.resolve(this.users.filter(u => u.deletedAt === null).map(u => ({ ...u })));
  }

  listIncludingDeleted(): Promise<User[]> {
    return Promise.resolve(this.users.map(u => ({ ...u })));
  }

  getById(id: number): Promise<User | null> {
    const u = this.users.find(u => u.id === id && u.deletedAt === null);
    return Promise.resolve(u ? { ...u } : null);
  }

  findByUsername(username: string): Promise<User | null> {
    const u = this.users.find(u => usernamesMatch(u.username, username) && u.deletedAt === null);
    return Promise.resolve(u ? { ...u } : null);
  }

  createNewUser(template: Omit<User, 'id'>): Promise<User> {
    const collision = this.users.find(u => usernamesMatch(u.username, template.username) && u.deletedAt === null);
    if (collision) throw new Error(`username taken: ${template.username}`);
    const id = this.users.reduce((max, u) => Math.max(max, u.id), 0) + 1;
    const user: User = { ...template, id };
    this.users.push(user);
    return Promise.resolve({ ...user });
  }

  async save(user: User): Promise<void> {
    // Match SQL's partial unique index `WHERE deleted_at IS NULL`: a clash is
    // only meaningful when the new row is also active. A soft-deleted import
    // can carry a username already in use by an active row without colliding.
    const collision = this.users.find(u => usernamesMatch(u.username, user.username) && u.deletedAt === null && u.id !== user.id);
    if (collision && user.deletedAt === null) throw new Error(`username taken: ${user.username}`);
    const i = this.users.findIndex(u => u.id === user.id);
    if (i >= 0) this.users[i] = { ...user };
    else this.users.push({ ...user });
  }

  async softDelete(id: number): Promise<boolean> {
    const i = this.users.findIndex(u => u.id === id && u.deletedAt === null);
    if (i < 0) return false;
    this.users[i] = { ...this.users[i], deletedAt: new Date().toISOString() };
    return true;
  }

  deleteAll(): Promise<void> {
    this.users = [];
    return Promise.resolve();
  }
}

class MemorySessionsRepo implements SessionsRepo {
  private sessions: Session[] = [];

  getByIdAndTouch(id: string): Promise<Session | null> {
    const i = this.sessions.findIndex(s => s.id === id);
    if (i < 0) return Promise.resolve(null);
    const now = new Date().toISOString();
    this.sessions[i] = { ...this.sessions[i], lastSeenAt: now };
    return Promise.resolve({ ...this.sessions[i] });
  }

  create(userId: number): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = { id: generateSessionToken(), userId, createdAt: now, lastSeenAt: now };
    this.sessions.push(session);
    return Promise.resolve({ ...session });
  }

  deleteById(id: string): Promise<boolean> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.id !== id);
    return Promise.resolve(this.sessions.length < before);
  }

  deleteByUserId(userId: number): Promise<number> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.userId !== userId);
    return Promise.resolve(before - this.sessions.length);
  }

  deleteByUserIdExcept(userId: number, exceptId: string): Promise<number> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(s => s.userId !== userId || s.id === exceptId);
    return Promise.resolve(before - this.sessions.length);
  }

  deleteAll(): Promise<void> {
    this.sessions = [];
    return Promise.resolve();
  }
}

class MemoryApiKeyRepo implements ApiKeyRepo {
  private keys: ApiKey[] = [];

  constructor(private readonly expirationSweeps: ExpirationSweepsRepo) {}

  private schedulePolicyChanges(previous: ApiKey, next: ApiKey): Promise<void> {
    const schedules: Promise<void>[] = [];
    if (previous.responsesRetentionSeconds !== next.responsesRetentionSeconds || previous.deletedAt !== next.deletedAt) {
      schedules.push(this.expirationSweeps.schedule('responses', next.id, 0));
    }
    if (previous.dumpRetentionSeconds !== next.dumpRetentionSeconds || previous.deletedAt !== next.deletedAt) {
      schedules.push(this.expirationSweeps.schedule('dumps', next.id, 0));
    }
    return Promise.all(schedules).then(() => undefined);
  }

  list(): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.deletedAt === null).map(k => ({ ...k })));
  }

  listIncludingDeleted(): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.map(k => ({ ...k })));
  }

  listByUserId(userId: number): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.userId === userId && k.deletedAt === null).map(k => ({ ...k })));
  }

  listByUserIdIncludingDeleted(userId: number): Promise<ApiKey[]> {
    return Promise.resolve(this.keys.filter(k => k.userId === userId).map(k => ({ ...k })));
  }

  findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const k = this.keys.find(k => k.key === rawKey && k.deletedAt === null);
    return Promise.resolve(k ? { ...k } : null);
  }

  getById(id: string): Promise<ApiKey | null> {
    const k = this.keys.find(k => k.id === id && k.deletedAt === null);
    return Promise.resolve(k ? { ...k } : null);
  }

  async save(key: ApiKey): Promise<void> {
    const i = this.keys.findIndex(k => k.id === key.id);
    if (i >= 0) {
      const previous = this.keys[i];
      this.keys[i] = { ...key };
      try {
        await this.schedulePolicyChanges(previous, key);
      } catch (error) {
        this.keys[i] = previous;
        throw error;
      }
    } else this.keys.push({ ...key });
  }

  async update(id: string, patch: ApiKeyUpdate): Promise<ApiKey | null> {
    const i = this.keys.findIndex(key => key.id === id && key.deletedAt === null);
    if (i < 0) return null;
    const previous = this.keys[i];
    const next = { ...previous, ...patch };
    this.keys[i] = next;
    try {
      await this.schedulePolicyChanges(previous, next);
    } catch (error) {
      this.keys[i] = previous;
      throw error;
    }
    return { ...next };
  }

  async softDelete(id: string): Promise<boolean> {
    const i = this.keys.findIndex(k => k.id === id && k.deletedAt === null);
    if (i < 0) return false;
    const previous = this.keys[i];
    const next = { ...previous, deletedAt: new Date().toISOString(), responsesRetentionSeconds: 0 };
    this.keys[i] = next;
    try {
      await this.schedulePolicyChanges(previous, next);
    } catch (error) {
      this.keys[i] = previous;
      throw error;
    }
    return true;
  }

  async softDeleteByUserId(userId: number): Promise<number> {
    const now = new Date().toISOString();
    const updates: Array<{ index: number; previous: ApiKey; next: ApiKey }> = [];
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (k.userId === userId && k.deletedAt === null) {
        const next = { ...k, deletedAt: now, responsesRetentionSeconds: 0 };
        updates.push({ index: i, previous: k, next });
      }
    }
    for (const update of updates) this.keys[update.index] = update.next;
    try {
      await Promise.all(updates.map(update => this.schedulePolicyChanges(update.previous, update.next)));
    } catch (error) {
      for (const update of updates) this.keys[update.index] = update.previous;
      throw error;
    }
    return updates.length;
  }

  async deleteAll(): Promise<void> {
    const previous = this.keys;
    this.keys = [];
    try {
      await Promise.all(previous.flatMap(key => [
        this.expirationSweeps.schedule('responses', key.id, 0),
        this.expirationSweeps.schedule('dumps', key.id, 0),
      ]));
    } catch (error) {
      this.keys = previous;
      throw error;
    }
  }
}

interface UsageBucketIdentity {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  hour: string;
  pricingSelector: PricingSelector;
}

interface UsageBucketState extends UsageBucketIdentity {
  metrics: Map<BillingMetric, { metric: BillingMetric; quantity: DecimalString; unitPrice: DecimalString | null }>;
  requests: number;
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageBucketState>();

  private key(r: UsageBucketIdentity): string {
    return [r.keyId, r.model, r.upstream ?? '', r.modelKey, r.hour, canonicalPricingSelectorKey(r.pricingSelector)].join('\0');
  }

  private toRecord(state: UsageBucketState): UsageRecord {
    return { keyId: state.keyId, model: state.model, upstream: state.upstream ?? null, modelKey: state.modelKey, hour: state.hour, pricingSelector: state.pricingSelector, requests: state.requests, metrics: [...state.metrics.values()].map(row => ({ ...row })) };
  }

  private bucket(record: UsageRecord): UsageBucketState {
    const pricingSelector = canonicalizePricingSelector(record.pricingSelector);
    const k = this.key({ ...record, pricingSelector });
    let state = this.store.get(k);
    if (!state) {
      state = { keyId: record.keyId, model: record.model, upstream: record.upstream ?? null, modelKey: record.modelKey, hour: record.hour, pricingSelector, metrics: new Map(), requests: 0 };
      this.store.set(k, state);
    }
    return state;
  }

  record(record: UsageRecord): Promise<void> {
    const state = this.bucket(record);
    state.requests += record.requests;
    for (const row of usageMetricRows(record)) {
      const current = state.metrics.get(row.metric);
      state.metrics.set(row.metric, current
        ? { ...current, quantity: addDecimalStrings(current.quantity, row.quantity) }
        : { ...row });
    }
    return Promise.resolve();
  }

  query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .filter(r => {
          if (opts.keyId && r.keyId !== opts.keyId) return false;
          return r.hour >= opts.start && r.hour < opts.end;
        })
        .map(r => this.toRecord(r))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
    );
  }

  listAll(): Promise<UsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => this.toRecord(r)).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: UsageRecord): Promise<void> {
    const pricingSelector = canonicalizePricingSelector(record.pricingSelector);
    const k = this.key({ ...record, pricingSelector });
    const state: UsageBucketState = {
      keyId: record.keyId,
      model: record.model,
      upstream: record.upstream ?? null,
      modelKey: record.modelKey,
      hour: record.hour,
      pricingSelector,
      metrics: new Map(),
      requests: record.requests,
    };
    for (const row of usageMetricRows(record)) {
      state.metrics.set(row.metric, { ...row });
    }
    this.store.set(k, state);
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryWebSearchUsageRepo implements WebSearchUsageRepo {
  private store = new Map<string, WebSearchUsageRecord>();

  private key(r: { provider: WebSearchUsageRecord['provider']; keyId: string; action: WebSearchUsageRecord['action']; hour: string }): string {
    return `${r.provider}\0${r.keyId}\0${r.action}\0${r.hour}`;
  }

  record(args: { provider: WebSearchUsageRecord['provider']; keyId: string; action: WebSearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
    return Promise.resolve().then(() => {
      const validProvider = assertWebSearchProviderName(args.provider);
      const k = this.key({ provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour });
      const existing = this.store.get(k);
      if (existing) {
        existing.requests += args.requests;
      } else {
        this.store.set(k, { provider: validProvider, keyId: args.keyId, action: args.action, hour: args.hour, requests: args.requests });
      }
    });
  }

  query(opts: { provider?: WebSearchUsageRecord['provider']; keyId?: string; action?: WebSearchUsageRecord['action']; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    return Promise.resolve().then(() => {
      const provider = opts.provider ? assertWebSearchProviderName(opts.provider) : undefined;
      return [...this.store.values()]
        .filter(r => !provider || r.provider === provider)
        .filter(r => !opts.keyId || r.keyId === opts.keyId)
        .filter(r => !opts.action || r.action === opts.action)
        .filter(r => r.hour >= opts.start && r.hour < opts.end)
        .map(r => ({ ...r }))
        .sort((a, b) => a.hour.localeCompare(b.hour));
    });
  }

  listAll(): Promise<WebSearchUsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => ({ ...r })).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: WebSearchUsageRecord): Promise<void> {
    return Promise.resolve().then(() => {
      const provider = assertWebSearchProviderName(record.provider);
      const validRecord = { ...record, provider };
      this.store.set(this.key(validRecord), validRecord);
    });
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

type StoredPerformanceRow = Omit<PerformanceTelemetryRecord, 'buckets'> & { bucketMap: Map<string, PerformanceBucketRow> };

const comparePerformanceRow = (a: StoredPerformanceRow, b: StoredPerformanceRow): number =>
  a.hour.localeCompare(b.hour)
  || a.keyId.localeCompare(b.keyId)
  || a.model.localeCompare(b.model)
  || a.upstream.localeCompare(b.upstream)
  || a.operation.localeCompare(b.operation)
  || a.runtimeLocation.localeCompare(b.runtimeLocation);

const compareBucketRow = (a: PerformanceBucketRow, b: PerformanceBucketRow): number =>
  a.metric.localeCompare(b.metric) || a.lower - b.lower;

const freezePerformanceRow = ({ bucketMap, ...rest }: StoredPerformanceRow): PerformanceTelemetryRecord => ({
  ...rest,
  buckets: [...bucketMap.values()].map(b => ({ ...b })).sort(compareBucketRow),
});

class MemoryPerformanceRepo implements PerformanceRepo {
  private readonly summaries = new Map<string, StoredPerformanceRow>();

  async recordSample(sample: PerformanceSample): Promise<void> {
    const row = this.upsertRow(sample);
    row.requests += 1;
    if (sample.success) row.ttftSamplesOk += 1;
    else row.errorsWithOutput += 1;
    row.ttftMsSum += sample.ttftMs;
    this.incrementBucket(row, 'ttft_ms', bucketForTtftMs(sample.ttftMs));
    if (sample.tpotUs !== undefined) {
      row.tpotSamples += 1;
      row.tpotUsSum += sample.tpotUs;
      this.incrementBucket(row, 'tpot_us', bucketForTpotUs(sample.tpotUs));
    }
  }

  async recordZeroOutputError(dims: PerformanceDimensions): Promise<void> {
    const row = this.upsertRow(dims);
    row.requests += 1;
    row.errorsNoOutput += 1;
  }

  async recordNeutral(dims: PerformanceDimensions): Promise<void> {
    const row = this.upsertRow(dims);
    row.requests += 1;
    row.neutral += 1;
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<PerformanceTelemetryRecord[]> {
    return [...this.summaries.values()]
      .filter(r => (opts.keyId ? r.keyId === opts.keyId : true) && r.hour >= opts.start && r.hour < opts.end)
      .sort(comparePerformanceRow)
      .map(freezePerformanceRow);
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return [...this.summaries.values()].sort(comparePerformanceRow).map(freezePerformanceRow);
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    const key = this.rowKey(record);
    const { buckets, ...dims } = record;
    const bucketMap = new Map(buckets.map(b => [`${b.metric}\0${b.lower}`, { ...b }] as const));
    this.summaries.set(key, { ...dims, bucketMap });
  }

  async deleteAll(): Promise<void> {
    this.summaries.clear();
  }

  private rowKey(dims: PerformanceDimensions): string {
    return `${dims.hour}\0${dims.keyId}\0${dims.model}\0${dims.upstream}\0${dims.operation}\0${dims.runtimeLocation}`;
  }

  private upsertRow(dims: PerformanceDimensions): StoredPerformanceRow {
    const key = this.rowKey(dims);
    let row = this.summaries.get(key);
    if (!row) {
      row = {
        hour: dims.hour,
        keyId: dims.keyId,
        model: dims.model,
        upstream: dims.upstream,
        operation: dims.operation,
        runtimeLocation: dims.runtimeLocation,
        requests: 0,
        ttftSamplesOk: 0,
        errorsWithOutput: 0,
        errorsNoOutput: 0,
        neutral: 0,
        tpotSamples: 0,
        ttftMsSum: 0,
        tpotUsSum: 0,
        bucketMap: new Map(),
      };
      this.summaries.set(key, row);
    }
    return row;
  }

  private incrementBucket(row: StoredPerformanceRow, metric: PerformanceMetric, edges: { lower: number; upper: number | null }) {
    const key = `${metric}\0${edges.lower}`;
    const existing = row.bucketMap.get(key);
    if (existing) { existing.count += 1; return; }
    row.bucketMap.set(key, { metric, lower: edges.lower, upper: edges.upper, count: 1 });
  }
}

class MemoryWebSearchConfigRepo implements WebSearchConfigRepo {
  private config: unknown | null = null;

  get(): Promise<unknown | null> {
    return Promise.resolve(this.config === null ? null : structuredClone(this.config));
  }

  save(config: WebSearchConfig): Promise<void> {
    this.config = structuredClone(config);
    return Promise.resolve();
  }
}

class MemoryUpstreamRepo implements UpstreamRepo {
  private store = new Map<string, UpstreamRecord>();

  list(): Promise<UpstreamRecord[]> {
    return Promise.resolve([...this.store.values()].map(cloneUpstreamRecord).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)));
  }

  getById(id: string): Promise<UpstreamRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneUpstreamRecord(found) : null);
  }

  // Mirrors the SQL INSERT/UPDATE column list, which omits the cache column:
  // an existing row keeps whatever the refresh path last wrote there, and a new
  // row starts uncached whatever the caller's record carried.
  save(upstream: UpstreamRecord): Promise<void> {
    const existing = this.store.get(upstream.id);
    const preserved = existing
      ? { ...upstream, createdAt: existing.createdAt, modelsCache: existing.modelsCache }
      : { ...upstream, modelsCache: null };
    this.store.set(preserved.id, cloneUpstreamRecord(preserved));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  // No retry loop: this store is single-threaded, so the mutator always sees
  // the current state and the write always lands. Serialization still round-
  // trips through the canonical encoder so a mutator that returns its argument
  // unchanged is a no-op here too.
  saveState(id: string, mutate: (current: unknown) => unknown): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) throw new UpstreamGoneError(id);
    const next = mutate(existing.state);
    const serialized = serializeStoredState(next);
    existing.state = serialized === null ? null : (JSON.parse(serialized) as unknown);
    return Promise.resolve();
  }

  saveModelsCache(id: string, cache: Omit<UpstreamModelsCache, 'lastError'>): Promise<void> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve();
    existing.modelsCache = { revision: cache.revision, fetchedAt: cache.fetchedAt, models: [...cache.models], lastError: null };
    return Promise.resolve();
  }

  // No-op on a row that has never cached a catalog: the annotation belongs to a
  // previously-successful fetch.
  saveModelsCacheError(id: string, error: NonNullable<UpstreamModelsCache['lastError']>): Promise<void> {
    const cache = this.store.get(id)?.modelsCache;
    if (!cache) return Promise.resolve();
    cache.lastError = error;
    return Promise.resolve();
  }
}

const cloneUpstreamRecord = (upstream: UpstreamRecord): UpstreamRecord => ({
  ...upstream,
  config: structuredClone(upstream.config),
  state: upstream.state === null || upstream.state === undefined ? null : structuredClone(upstream.state),
  modelsCache: upstream.modelsCache === null ? null : { ...upstream.modelsCache, models: [...upstream.modelsCache.models] },
  flagOverrides: normalizeFlagOverrides(upstream.flagOverrides),
  disabledPublicModelIds: normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds),
  proxyFallbackList: normalizeProxyFallbackList(upstream.proxyFallbackList),
  modelPrefix: structuredClone(upstream.modelPrefix),
  hue: upstream.hue,
});

const responsesCleanupDueAt = async (
  apiKeys: ApiKeyRepo,
  apiKeyId: string,
  refreshedAt: number,
): Promise<number> => {
  const apiKey = (await apiKeys.listIncludingDeleted()).find(candidate => candidate.id === apiKeyId);
  if (apiKey === undefined) throw new Error(`API key not found for Responses state: ${apiKeyId}`);
  return apiKey.deletedAt !== null || apiKey.responsesRetentionSeconds === 0
    ? 0
    : refreshedAt + apiKey.responsesRetentionSeconds * 1000 + RESPONSES_REFRESH_GRANULARITY_MS + 1;
};

class MemoryResponsesItemsRepo implements ResponsesItemsRepo {
  private store = new Map<string, StoredResponsesItem>();

  constructor(
    private readonly apiKeys: ApiKeyRepo,
    private readonly expirationSweeps: ExpirationSweepsRepo,
  ) {}

  lookupMany(apiKeyId: string, ids: readonly string[], earliestVisibleCutoff: number): Promise<StoredResponsesItem[]> {
    const rows: StoredResponsesItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.store.get(scopedResponsesKey(apiKeyId, id));
      if (row !== undefined && row.refreshedAt >= earliestVisibleCutoff) rows.push(cloneStoredResponsesItem(row));
    }
    return Promise.resolve(rows);
  }

  lookupManyByItemHash(apiKeyId: string, hashes: readonly string[], earliestVisibleCutoff: number): Promise<StoredResponsesItem[]> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return Promise.resolve([]);
    const rows: StoredResponsesItem[] = [];
    for (const row of this.store.values()) {
      if (row.apiKeyId === apiKeyId && row.refreshedAt >= earliestVisibleCutoff && wanted.has(row.itemHash)) {
        rows.push(cloneStoredResponsesItem(row));
      }
    }
    return Promise.resolve(rows.toSorted(compareResponsesItemsByFreshness));
  }

  async insertMany(items: readonly StoredResponsesItem[], earliestVisibleCutoff: number): Promise<void> {
    const quantizedItems = items.map(item => ({
      ...item,
      refreshedAt: quantizeResponsesRefreshedAt(item.refreshedAt),
    }));
    const pending = new Map<string, StoredResponsesItem>();
    const dueByApiKey = new Map<string, number>();
    for (const item of quantizedItems) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      const existing = pending.get(key) ?? this.store.get(key);
      if (existing !== undefined && existing.refreshedAt >= earliestVisibleCutoff) {
        assertSameStoredResponsesItem(item, existing);
      } else {
        pending.set(key, item);
      }
      const refreshedAt = Math.max(existing?.refreshedAt ?? item.refreshedAt, item.refreshedAt);
      const dueAt = await responsesCleanupDueAt(this.apiKeys, item.apiKeyId, refreshedAt);
      dueByApiKey.set(item.apiKeyId, Math.min(dueByApiKey.get(item.apiKeyId) ?? dueAt, dueAt));
    }
    const previous = new Map<string, StoredResponsesItem | undefined>();
    for (const item of items) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      if (!previous.has(key)) previous.set(key, this.store.has(key) ? cloneStoredResponsesItem(this.store.get(key)!) : undefined);
    }
    for (const [key, item] of pending) this.store.set(key, cloneStoredResponsesItem(item));
    for (const item of quantizedItems) {
      const stored = this.store.get(scopedResponsesKey(item.apiKeyId, item.id))!;
      if (stored.refreshedAt < item.refreshedAt) stored.refreshedAt = item.refreshedAt;
    }
    try {
      await Promise.all([...dueByApiKey].map(([apiKeyId, dueAt]) =>
        this.expirationSweeps.schedule('responses', apiKeyId, dueAt)));
    } catch (error) {
      for (const [key, item] of previous) {
        if (item === undefined) this.store.delete(key);
        else this.store.set(key, item);
      }
      throw error;
    }
  }

  async refreshMany(items: readonly StoredResponsesItem[], refreshedAt: number, earliestVisibleCutoff: number): Promise<void> {
    const quantizedRefreshedAt = quantizeResponsesRefreshedAt(refreshedAt);
    const existing = items.map(item => this.store.get(scopedResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item =>
      item === undefined || item.refreshedAt < earliestVisibleCutoff);
    if (missingIndex !== -1) {
      throw new Error(`Responses item disappeared before retention refresh: ${items[missingIndex].id}`);
    }
    const dueByApiKey = new Map<string, number>();
    for (let index = 0; index < existing.length; index += 1) {
      assertSameStoredResponsesItem(items[index], existing[index]!);
      const nextRefreshedAt = Math.max(existing[index]!.refreshedAt, quantizedRefreshedAt);
      const dueAt = await responsesCleanupDueAt(this.apiKeys, items[index].apiKeyId, nextRefreshedAt);
      dueByApiKey.set(items[index].apiKeyId, Math.min(dueByApiKey.get(items[index].apiKeyId) ?? dueAt, dueAt));
    }
    const previous = new Map(existing.map(item => {
      const row = item!;
      return [scopedResponsesKey(row.apiKeyId, row.id), cloneStoredResponsesItem(row)] as const;
    }));
    for (const item of existing) {
      if (item!.refreshedAt < quantizedRefreshedAt) item!.refreshedAt = quantizedRefreshedAt;
    }
    try {
      await Promise.all([...dueByApiKey].map(([apiKeyId, dueAt]) =>
        this.expirationSweeps.schedule('responses', apiKeyId, dueAt)));
    } catch (error) {
      for (const [key, item] of previous) this.store.set(key, item);
      throw error;
    }
  }

  async deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number> {
    let changes = 0;
    for (const [key, row] of this.store) {
      if (row.apiKeyId !== apiKeyId || changes >= limit) continue;
      const apiKey = await this.apiKeys.getById(row.apiKeyId);
      if (
        apiKey === null
        || apiKey.responsesRetentionSeconds === 0
        || row.refreshedAt < responsesStateCutoff(now, apiKey.responsesRetentionSeconds)
      ) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return changes;
  }

  findOldestRefreshedAt(apiKeyId: string): Promise<number | null> {
    const rows = [...this.store.values()].filter(row => row.apiKeyId === apiKeyId);
    return Promise.resolve(rows.length === 0 ? null : Math.min(...rows.map(row => row.refreshedAt)));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  private store = new Map<string, StoredResponsesSnapshot>();

  constructor(
    private readonly apiKeys: ApiKeyRepo,
    private readonly expirationSweeps: ExpirationSweepsRepo,
  ) {}

  lookup(apiKeyId: string, id: string, earliestVisibleCutoff: number): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.store.get(scopedResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot !== undefined && snapshot.refreshedAt >= earliestVisibleCutoff ? cloneStoredResponsesSnapshot(snapshot) : null);
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    const quantized = {
      ...snapshot,
      refreshedAt: quantizeResponsesRefreshedAt(snapshot.refreshedAt),
    };
    const key = scopedResponsesKey(quantized.apiKeyId, quantized.id);
    const existing = this.store.get(key);
    if (existing === undefined || quantized.refreshedAt > existing.refreshedAt) {
      this.store.set(key, cloneStoredResponsesSnapshot(quantized));
      try {
        await this.expirationSweeps.schedule('responses', quantized.apiKeyId, await responsesCleanupDueAt(
          this.apiKeys,
          quantized.apiKeyId,
          quantized.refreshedAt,
        ));
      } catch (error) {
        if (existing === undefined) this.store.delete(key);
        else this.store.set(key, existing);
        throw error;
      }
    }
  }

  async deleteExpiredBatch(apiKeyId: string, now: number, limit: number): Promise<number> {
    let changes = 0;
    for (const [key, snapshot] of this.store) {
      if (snapshot.apiKeyId !== apiKeyId || changes >= limit) continue;
      const apiKey = await this.apiKeys.getById(snapshot.apiKeyId);
      if (
        apiKey === null
        || apiKey.responsesRetentionSeconds === 0
        || snapshot.refreshedAt < responsesStateCutoff(now, apiKey.responsesRetentionSeconds)
      ) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return changes;
  }

  findOldestRefreshedAt(apiKeyId: string): Promise<number | null> {
    const rows = [...this.store.values()].filter(row => row.apiKeyId === apiKeyId);
    return Promise.resolve(rows.length === 0 ? null : Math.min(...rows.map(row => row.refreshedAt)));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemorySpilledFilesRepo implements SpilledFilesRepo {
  private readonly files = new Map<string, {
    collectAfter: number;
    claimToken: string | null;
    claimedAt: number | null;
  }>();

  claimCollectible(token: string, now: number, staleClaimedBefore: number, limit: number): Promise<string[]> {
    const keys = [...this.files]
      .filter(([, file]) =>
        file.collectAfter <= now && (file.claimToken === null || file.claimedAt! < staleClaimedBefore))
      .map(([fileKey]) => fileKey)
      .sort()
      .slice(0, limit);
    for (const key of keys) {
      const file = this.files.get(key)!;
      file.claimToken = token;
      file.claimedAt = now;
    }
    return Promise.resolve(keys);
  }

  acknowledge(token: string): Promise<number> {
    let changes = 0;
    for (const [key, file] of this.files) {
      if (file.claimToken !== token) continue;
      this.files.delete(key);
      changes += 1;
    }
    return Promise.resolve(changes);
  }

}

interface MemoryExpirationSweepRow extends ExpirationSweepClaim {
  dueAt: number;
  claimToken: string | null;
  claimedAt: number | null;
}

class MemoryExpirationSweepsRepo implements ExpirationSweepsRepo {
  private readonly rows = new Map<string, MemoryExpirationSweepRow>();

  private key(domain: ExpirationDomain, keyId: string): string {
    return `${domain}\0${keyId}`;
  }

  backfillCleanupTracking(): Promise<void> {
    return Promise.resolve();
  }

  schedule(domain: ExpirationDomain, keyId: string, dueAt: number): Promise<void> {
    const key = this.key(domain, keyId);
    const existing = this.rows.get(key);
    this.rows.set(key, existing === undefined
      ? { domain, keyId, dueAt, revision: 0, claimToken: null, claimedAt: null }
      : { ...existing, dueAt: Math.min(existing.dueAt, dueAt), revision: existing.revision + 1 });
    return Promise.resolve();
  }

  claim(token: string, now: number, staleClaimedBefore: number): Promise<ExpirationSweepClaim | null> {
    const row = [...this.rows.values()]
      .filter(candidate => candidate.dueAt <= now && (candidate.claimToken === null || candidate.claimedAt! < staleClaimedBefore))
      .toSorted((a, b) => a.dueAt - b.dueAt || a.keyId.localeCompare(b.keyId) || a.domain.localeCompare(b.domain))[0];
    if (row === undefined) return Promise.resolve(null);
    row.claimToken = token;
    row.claimedAt = now;
    return Promise.resolve({ domain: row.domain, keyId: row.keyId, revision: row.revision });
  }

  complete(token: string, expectedRevision: number, completion: ExpirationSweepCompletion): Promise<void> {
    const row = [...this.rows.values()].find(candidate => candidate.claimToken === token);
    if (row === undefined) return Promise.resolve();
    const key = this.key(row.domain, row.keyId);
    if (row.revision === expectedRevision && completion.kind === 'drained' && completion.nextDueAt === null) {
      this.rows.delete(key);
      return Promise.resolve();
    }
    const nextDueAt = completion.kind === 'partial' ? completion.retryAt : completion.nextDueAt;
    if (nextDueAt !== null) {
      row.dueAt = row.revision === expectedRevision || completion.kind === 'partial'
        ? nextDueAt
        : Math.min(row.dueAt, nextDueAt);
    }
    row.claimToken = null;
    row.claimedAt = null;
    return Promise.resolve();
  }
}

class MemoryProxyRepo implements ProxyRepo {
  private store = new Map<string, ProxyRecord>();

  constructor(private upstreams: UpstreamRepo) {}

  list(): Promise<ProxyRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .map(cloneProxyRecord)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  getById(id: string): Promise<ProxyRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneProxyRecord(found) : null);
  }

  insert(input: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<ProxyRecord> {
    const now = new Date().toISOString();
    const record: ProxyRecord = {
      id: input.id,
      name: input.name,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      dialTimeoutSeconds: input.dialTimeoutSeconds,
    };
    this.store.set(record.id, record);
    return Promise.resolve(cloneProxyRecord(record));
  }

  patch(id: string, patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null }): Promise<{ record: ProxyRecord; urlChanged: boolean } | null> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve(null);

    const urlChanged = patch.url !== undefined && patch.url !== existing.url;
    // Distinguish "absent" from "explicit null" — `??` would collapse a
    // deliberate clear back to the existing value.
    const nextDialTimeout = Object.hasOwn(patch, 'dialTimeoutSeconds') ? patch.dialTimeoutSeconds! : existing.dialTimeoutSeconds;
    const updated: ProxyRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      url: patch.url ?? existing.url,
      dialTimeoutSeconds: nextDialTimeout,
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return Promise.resolve({ record: cloneProxyRecord(updated), urlChanged });
  }

  async delete(id: string): Promise<boolean> {
    // Mirror the SQL repo's atomic delete: refuse if any upstream's fallback
    // list still references the row, so an admin race adding the reference
    // between a prior findUpstreamsReferencing read and this delete is
    // rejected at the storage layer.
    const upstreams = await this.upstreams.list();
    if (upstreams.some(u => u.proxyFallbackList.some(e => e.id === id))) return false;
    return this.store.delete(id);
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }

  save(record: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<void> {
    // Upsert that mirrors the SQL ON CONFLICT path: preserve the existing
    // row's createdAt on collision so the import never overwrites the
    // local deployment's first-seen timestamp.
    const existing = this.store.get(record.id);
    const now = new Date().toISOString();
    const next: ProxyRecord = {
      id: record.id,
      name: record.name,
      url: record.url,
      dialTimeoutSeconds: record.dialTimeoutSeconds,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    this.store.set(record.id, next);
    return Promise.resolve();
  }

  async findUpstreamsReferencing(proxyId: string): Promise<string[]> {
    const upstreams = await this.upstreams.list();
    return upstreams.filter(u => u.proxyFallbackList.some(e => e.id === proxyId)).map(u => u.id);
  }
}

const cloneProxyRecord = (record: ProxyRecord): ProxyRecord => ({ ...record });

class MemoryProxyBackoffRepo implements ProxyBackoffRepo {
  private rows = new Map<string, BackoffRow>();

  private key(proxyId: string, upstreamId: string): string {
    return `${proxyId}\0${upstreamId}`;
  }

  recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void> {
    const k = this.key(proxyId, upstreamId);
    const now = Math.floor(Date.now() / 1000);
    const existing = this.rows.get(k);
    if (!existing) {
      this.rows.set(k, {
        proxyId,
        upstreamId,
        failCount: 1,
        expiresAt: now + 60,
        lastError: errorMessage,
        lastErrorAt: now,
      });
      return Promise.resolve();
    }
    // Mirror the SQL UPSERT schedule (see SqlProxyBackoffRepo.recordDialFailure).
    // The exponent is clamped at 6 to stay within JS's 32-bit signed shift
    // semantics — `1 << 31` wraps to negative and would resolve `Math.min`
    // to a far-past expiresAt, effectively voiding the backoff.
    const previousFailCount = existing.failCount;
    this.rows.set(k, {
      proxyId,
      upstreamId,
      failCount: previousFailCount + 1,
      expiresAt: now + Math.min(60 * (1 << Math.min(previousFailCount, 6)), 3600),
      lastError: errorMessage,
      lastErrorAt: now,
    });
    return Promise.resolve();
  }

  recordDialSuccess(proxyId: string, upstreamId: string): Promise<void> {
    this.rows.delete(this.key(proxyId, upstreamId));
    return Promise.resolve();
  }

  listForUpstream(upstreamId: string): Promise<BackoffRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(r => r.upstreamId === upstreamId).map(cloneBackoffRow),
    );
  }

  listForProxy(proxyId: string): Promise<BackoffRow[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(r => r.proxyId === proxyId).map(cloneBackoffRow),
    );
  }

  listAll(): Promise<BackoffRow[]> {
    return Promise.resolve([...this.rows.values()].map(cloneBackoffRow));
  }

  resetForProxy(proxyId: string): Promise<void> {
    for (const [k, r] of this.rows) {
      if (r.proxyId === proxyId) this.rows.delete(k);
    }
    return Promise.resolve();
  }

  resetForUpstream(upstreamId: string): Promise<void> {
    for (const [k, r] of this.rows) {
      if (r.upstreamId === upstreamId) this.rows.delete(k);
    }
    return Promise.resolve();
  }

  reset(proxyId: string, upstreamId: string): Promise<void> {
    this.rows.delete(this.key(proxyId, upstreamId));
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.rows.clear();
    return Promise.resolve();
  }
}

const cloneBackoffRow = (row: BackoffRow): BackoffRow => ({ ...row });

const cloneModelAliasRecord = (record: ModelAliasRecord): ModelAliasRecord => ({
  ...record,
  targets: structuredClone(record.targets),
  announcedMetadata: record.announcedMetadata === null ? null : structuredClone(record.announcedMetadata),
});

class MemoryModelAliasesRepo implements ModelAliasesRepo {
  // Keyed by id, mirroring the table's primary key; the name uniqueness the
  // SQL backend enforces with a UNIQUE index is checked by scan here.
  private store = new Map<string, ModelAliasRecord>();

  private nameTaken(name: string, exceptId: string | null): boolean {
    return [...this.store.values()].some(record => record.name === name && record.id !== exceptId);
  }

  list(): Promise<ModelAliasRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .map(cloneModelAliasRecord)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)),
    );
  }

  getById(id: string): Promise<ModelAliasRecord | null> {
    const found = this.store.get(id);
    return Promise.resolve(found ? cloneModelAliasRecord(found) : null);
  }

  getByName(name: string): Promise<ModelAliasRecord | null> {
    const found = [...this.store.values()].find(record => record.name === name);
    return Promise.resolve(found ? cloneModelAliasRecord(found) : null);
  }

  insert(record: ModelAliasRecord): Promise<void> {
    if (this.nameTaken(record.name, null)) throw new Error('UNIQUE constraint failed: model_aliases.name');
    this.store.set(record.id, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  update(record: ModelAliasRecord): Promise<void> {
    if (!this.store.has(record.id)) throw new Error(`alias ${record.id} not found`);
    if (this.nameTaken(record.name, record.id)) {
      throw new Error('UNIQUE constraint failed: model_aliases.name');
    }
    this.store.set(record.id, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(id));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

const compareLatestAgentSetupRecord = (a: AgentSetupRecord, b: AgentSetupRecord): number =>
  b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || (a.token < b.token ? 1 : -1);

class MemoryAgentSetupRepo implements AgentSetupRepository {
  // Keyed by token: a user may own many concurrent leases at once.
  private byToken = new Map<string, AgentSetupRecord>();

  findByToken(token: string): Promise<AgentSetupRecord | null> {
    const found = this.byToken.get(token);
    return Promise.resolve(found ? { ...found } : null);
  }

  latestByUserId(userId: number): Promise<AgentSetupRecord | null> {
    let latest: AgentSetupRecord | undefined;
    for (const record of this.byToken.values()) {
      if (record.userId !== userId) continue;
      if (latest === undefined || compareLatestAgentSetupRecord(record, latest) < 0) latest = record;
    }
    return Promise.resolve(latest ? { ...latest } : null);
  }

  insertForUser(input: {
    userId: number;
    token: string;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupRecord> {
    if (this.byToken.has(input.token)) throw new AgentSetupTokenCollisionError();
    const record: AgentSetupRecord = {
      userId: input.userId,
      token: input.token,
      configurationJson: input.configurationJson,
      configurationRevision: 1,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.byToken.set(record.token, record);
    // Mirror the AFTER INSERT trigger: sweep only this user's already-expired
    // rows, measured against the new row's created_at, never the new row.
    for (const [token, existing] of this.byToken) {
      if (existing.userId === input.userId && token !== record.token && existing.expiresAt <= input.now) this.byToken.delete(token);
    }
    return Promise.resolve({ ...record });
  }

  updateConfiguration(input: {
    userId: number;
    token: string;
    expectedRevision: number;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupMutation> {
    const existing = this.byToken.get(input.token);
    if (!existing || existing.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    if (existing.configurationRevision !== input.expectedRevision) {
      return Promise.resolve({ status: 'revision-conflict', record: { ...existing } });
    }
    const record: AgentSetupRecord = {
      ...existing,
      configurationJson: input.configurationJson,
      configurationRevision: existing.configurationRevision + 1,
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    this.byToken.set(record.token, record);
    return Promise.resolve({ status: 'ok', record: { ...record } });
  }

  renewLease(input: {
    userId: number;
    token: string;
    expiresAt: number;
  }): Promise<AgentSetupRenewal> {
    const existing = this.byToken.get(input.token);
    if (!existing || existing.userId !== input.userId) return Promise.resolve({ status: 'missing' });
    // Expiry-only: updated_at and the revision stay put.
    const record: AgentSetupRecord = { ...existing, expiresAt: input.expiresAt };
    this.byToken.set(record.token, record);
    return Promise.resolve({ status: 'ok', record: { ...record } });
  }
}

export class InMemoryRepo implements Repo {
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

  constructor() {
    this.users = new MemoryUsersRepo();
    this.sessions = new MemorySessionsRepo();
    this.expirationSweeps = new MemoryExpirationSweepsRepo();
    this.apiKeys = new MemoryApiKeyRepo(this.expirationSweeps);
    this.usage = new MemoryUsageRepo();
    this.webSearchUsage = new MemoryWebSearchUsageRepo();
    this.performance = new MemoryPerformanceRepo();
    this.webSearchConfig = new MemoryWebSearchConfigRepo();
    this.upstreams = new MemoryUpstreamRepo();
    this.proxies = new MemoryProxyRepo(this.upstreams);
    this.proxyBackoffs = new MemoryProxyBackoffRepo();
    this.modelAliases = new MemoryModelAliasesRepo();
    this.responsesItems = new MemoryResponsesItemsRepo(this.apiKeys, this.expirationSweeps);
    this.responsesSnapshots = new MemoryResponsesSnapshotsRepo(this.apiKeys, this.expirationSweeps);
    this.spilledFiles = new MemorySpilledFilesRepo();
    this.agentSetup = new MemoryAgentSetupRepo();
  }
}
