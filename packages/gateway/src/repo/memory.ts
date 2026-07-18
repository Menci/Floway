import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import {
  cloneStoredResponsesItem,
  cloneStoredResponsesSnapshot,
  compareResponsesItemsByFreshness,
  scopedResponsesKey,
} from './responses-clone.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  BackoffRow,
  CachedModelsRow,
  ModelAliasesRepo,
  ModelAliasRecord,
  ModelsCacheRepo,
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
  SearchConfig,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  Session,
  SessionsRepo,
  StoredResponsesItem,
  StoredResponsesSnapshot,
  UpstreamRepo,
  UsageRecord,
  UsageRepo,
  User,
  UsersRepo,
} from './types.ts';
import { serializeStoredState } from './upstream-json.ts';
import { usageDimensionRows } from './usage-dimensions.ts';
import { bucketForTtftMs, bucketForTpotUs } from '../shared/performance-histogram.ts';
import { generateSessionToken } from '../shared/session-tokens.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import { BILLING_DIMENSIONS, canonicalPricingSelectorKey, canonicalizePricingSelector, type BillingDimension, type PriceVector, type PricingSelector } from '@floway-dev/protocols/common';
import type { ProviderModel, UpstreamRecord } from '@floway-dev/provider';

const SEED_ADMIN_USER: User = {
  id: 1,
  username: 'admin',
  passwordHash: null,
  isAdmin: true,
  upstreamIds: null,
  canViewGlobalTelemetry: true,
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
    if (i >= 0) this.keys[i] = { ...key };
    else this.keys.push({ ...key });
  }

  async softDelete(id: string): Promise<boolean> {
    const i = this.keys.findIndex(k => k.id === id && k.deletedAt === null);
    if (i < 0) return false;
    this.keys[i] = { ...this.keys[i], deletedAt: new Date().toISOString() };
    return true;
  }

  softDeleteByUserId(userId: number): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[i];
      if (k.userId === userId && k.deletedAt === null) {
        this.keys[i] = { ...k, deletedAt: now };
        count += 1;
      }
    }
    return Promise.resolve(count);
  }

  deleteAll(): Promise<void> {
    this.keys = [];
    return Promise.resolve();
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
  tokens: Partial<Record<BillingDimension, number>>;
  unitPrices: Partial<Record<BillingDimension, number>>;
  requests: number;
}

class MemoryUsageRepo implements UsageRepo {
  private store = new Map<string, UsageBucketState>();

  private key(r: UsageBucketIdentity): string {
    return [r.keyId, r.model, r.upstream ?? '', r.modelKey, r.hour, canonicalPricingSelectorKey(r.pricingSelector)].join('\0');
  }

  private toRecord(state: UsageBucketState): UsageRecord {
    const tokens: Partial<Record<BillingDimension, number>> = {};
    let rates: PriceVector | null = null;
    for (const dimension of BILLING_DIMENSIONS) {
      const count = state.tokens[dimension];
      if (count !== undefined) tokens[dimension] = count;
      const unitPrice = state.unitPrices[dimension];
      if (unitPrice !== undefined) (rates ??= {})[dimension] = unitPrice;
    }
    return { keyId: state.keyId, model: state.model, upstream: state.upstream ?? null, modelKey: state.modelKey, hour: state.hour, pricingSelector: state.pricingSelector, requests: state.requests, tokens, rates };
  }

  private bucket(record: UsageRecord): UsageBucketState {
    const pricingSelector = canonicalizePricingSelector(record.pricingSelector);
    const k = this.key({ ...record, pricingSelector });
    let state = this.store.get(k);
    if (!state) {
      state = { keyId: record.keyId, model: record.model, upstream: record.upstream ?? null, modelKey: record.modelKey, hour: record.hour, pricingSelector, tokens: {}, unitPrices: {}, requests: 0 };
      this.store.set(k, state);
    }
    return state;
  }

  record(record: UsageRecord): Promise<void> {
    const state = this.bucket(record);
    state.requests += record.requests;
    for (const { dimension, tokens, unitPrice } of usageDimensionRows(record)) {
      const isFirstWrite = state.tokens[dimension] === undefined;
      state.tokens[dimension] = (state.tokens[dimension] ?? 0) + tokens;
      if (isFirstWrite && unitPrice !== null) state.unitPrices[dimension] = unitPrice;
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
      tokens: {},
      unitPrices: {},
      requests: record.requests,
    };
    for (const { dimension, tokens, unitPrice } of usageDimensionRows(record)) {
      state.tokens[dimension] = tokens;
      if (unitPrice !== null) state.unitPrices[dimension] = unitPrice;
    }
    this.store.set(k, state);
    return Promise.resolve();
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemorySearchUsageRepo implements SearchUsageRepo {
  private store = new Map<string, SearchUsageRecord>();

  private key(r: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string }): string {
    return `${r.provider}\0${r.keyId}\0${r.action}\0${r.hour}`;
  }

  record(args: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
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

  query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; action?: SearchUsageRecord['action']; start: string; end: string }): Promise<SearchUsageRecord[]> {
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

  listAll(): Promise<SearchUsageRecord[]> {
    return Promise.resolve([...this.store.values()].map(r => ({ ...r })).sort((a, b) => a.hour.localeCompare(b.hour)));
  }

  set(record: SearchUsageRecord): Promise<void> {
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

class MemoryModelsCacheRepo implements ModelsCacheRepo {
  private rows = new Map<string, CachedModelsRow>();

  get(upstreamId: string): Promise<CachedModelsRow | null> {
    const row = this.rows.get(upstreamId);
    return Promise.resolve(row ? { ...row, models: [...row.models] } : null);
  }

  put(upstreamId: string, row: { revision: number; fetchedAt: number; models: ProviderModel[] }): Promise<void> {
    this.rows.set(upstreamId, { revision: row.revision, fetchedAt: row.fetchedAt, models: [...row.models], lastError: null });
    return Promise.resolve();
  }

  setLastError(upstreamId: string, error: { message: string; at: number } | null): Promise<void> {
    // No-op when no row exists: lastError annotates a previously-successful fetch.
    const existing = this.rows.get(upstreamId);
    if (!existing) return Promise.resolve();
    this.rows.set(upstreamId, { ...existing, lastError: error });
    return Promise.resolve();
  }

  delete(upstreamId: string): Promise<void> {
    this.rows.delete(upstreamId);
    return Promise.resolve();
  }
}

class MemorySearchConfigRepo implements SearchConfigRepo {
  private config: unknown | null = null;

  get(): Promise<unknown | null> {
    return Promise.resolve(this.config === null ? null : structuredClone(this.config));
  }

  save(config: SearchConfig): Promise<void> {
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

  save(upstream: UpstreamRecord): Promise<void> {
    const existing = this.store.get(upstream.id);
    const preserved = existing ? { ...upstream, createdAt: existing.createdAt } : upstream;
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

  saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }> {
    const existing = this.store.get(id);
    if (!existing) return Promise.resolve({ updated: false });
    if (serializeStoredState(existing.state) !== serializeStoredState(options.expectedState)) {
      return Promise.resolve({ updated: false });
    }
    existing.state = newState === undefined ? null : structuredClone(newState);
    return Promise.resolve({ updated: true });
  }
}

const cloneUpstreamRecord = (upstream: UpstreamRecord): UpstreamRecord => ({
  ...upstream,
  config: structuredClone(upstream.config),
  state: upstream.state === null || upstream.state === undefined ? null : structuredClone(upstream.state),
  flagOverrides: normalizeFlagOverrides(upstream.flagOverrides),
  disabledPublicModelIds: normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds),
  proxyFallbackList: normalizeProxyFallbackList(upstream.proxyFallbackList),
  modelPrefix: structuredClone(upstream.modelPrefix),
  color: upstream.color ?? null,
});

class MemoryResponsesItemsRepo implements ResponsesItemsRepo {
  private store = new Map<string, StoredResponsesItem>();

  lookupMany(apiKeyId: string, ids: readonly string[]): Promise<StoredResponsesItem[]> {
    const rows: StoredResponsesItem[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.store.get(scopedResponsesKey(apiKeyId, id));
      if (row !== undefined) rows.push(cloneStoredResponsesItem(row));
    }
    return Promise.resolve(rows);
  }

  lookupManyByContentHash(apiKeyId: string, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    const wanted = new Set(hashes);
    if (wanted.size === 0) return Promise.resolve([]);
    const rows: StoredResponsesItem[] = [];
    for (const row of this.store.values()) {
      if (row.apiKeyId === apiKeyId && row.contentHash !== null && wanted.has(row.contentHash)) {
        rows.push(cloneStoredResponsesItem(row));
      }
    }
    return Promise.resolve(rows.toSorted(compareResponsesItemsByFreshness));
  }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    for (const item of items) {
      const key = scopedResponsesKey(item.apiKeyId, item.id);
      if (this.store.has(key)) continue;
      this.store.set(key, cloneStoredResponsesItem(item));
    }
    return Promise.resolve();
  }

  refreshMany(items: readonly StoredResponsesItem[], createdAt: number): Promise<void> {
    const existing = items.map(item => this.store.get(scopedResponsesKey(item.apiKeyId, item.id)));
    const missingIndex = existing.findIndex(item => item === undefined);
    if (missingIndex !== -1) {
      return Promise.reject(new Error(`Responses item disappeared before lifetime refresh: ${items[missingIndex].id}`));
    }
    for (const item of existing) item!.createdAt = Math.max(item!.createdAt, createdAt);
    return Promise.resolve();
  }

  deleteOlderThan(createdBefore: number): Promise<number> {
    let changes = 0;
    for (const [key, row] of this.store) {
      if (row.createdAt < createdBefore) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

class MemoryResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  private store = new Map<string, StoredResponsesSnapshot>();

  lookup(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    const snapshot = this.store.get(scopedResponsesKey(apiKeyId, id));
    return Promise.resolve(snapshot ? cloneStoredResponsesSnapshot(snapshot) : null);
  }

  insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    const key = scopedResponsesKey(snapshot.apiKeyId, snapshot.id);
    const existing = this.store.get(key);
    if (existing === undefined || snapshot.createdAt >= existing.createdAt) {
      this.store.set(key, cloneStoredResponsesSnapshot(snapshot));
    }
    return Promise.resolve();
  }

  deleteOlderThan(createdBefore: number): Promise<number> {
    let changes = 0;
    for (const [key, snapshot] of this.store) {
      if (snapshot.createdAt < createdBefore) {
        this.store.delete(key);
        changes += 1;
      }
    }
    return Promise.resolve(changes);
  }

  deleteAll(): Promise<void> {
    this.store.clear();
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
  private store = new Map<string, ModelAliasRecord>();

  list(): Promise<ModelAliasRecord[]> {
    return Promise.resolve(
      [...this.store.values()]
        .map(cloneModelAliasRecord)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)),
    );
  }

  getByName(name: string): Promise<ModelAliasRecord | null> {
    const found = this.store.get(name);
    return Promise.resolve(found ? cloneModelAliasRecord(found) : null);
  }

  insert(record: ModelAliasRecord): Promise<void> {
    if (this.store.has(record.name)) throw new Error('UNIQUE constraint failed: model_aliases.name');
    this.store.set(record.name, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  update(oldName: string, record: ModelAliasRecord): Promise<void> {
    if (!this.store.has(oldName)) throw new Error(`alias ${oldName} not found`);
    if (oldName !== record.name && this.store.has(record.name)) {
      throw new Error('UNIQUE constraint failed: model_aliases.name');
    }
    this.store.delete(oldName);
    this.store.set(record.name, cloneModelAliasRecord(record));
    return Promise.resolve();
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(name));
  }

  deleteAll(): Promise<void> {
    this.store.clear();
    return Promise.resolve();
  }
}

export class InMemoryRepo implements Repo {
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

  constructor() {
    this.users = new MemoryUsersRepo();
    this.sessions = new MemorySessionsRepo();
    this.apiKeys = new MemoryApiKeyRepo();
    this.usage = new MemoryUsageRepo();
    this.searchUsage = new MemorySearchUsageRepo();
    this.performance = new MemoryPerformanceRepo();
    this.modelsCache = new MemoryModelsCacheRepo();
    this.searchConfig = new MemorySearchConfigRepo();
    this.upstreams = new MemoryUpstreamRepo();
    this.proxies = new MemoryProxyRepo(this.upstreams);
    this.proxyBackoffs = new MemoryProxyBackoffRepo();
    this.modelAliases = new MemoryModelAliasesRepo();
    this.responsesItems = new MemoryResponsesItemsRepo();
    this.responsesSnapshots = new MemoryResponsesSnapshotsRepo();
  }
}
