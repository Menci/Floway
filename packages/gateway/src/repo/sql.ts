import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { deleteAllResponsesItemPayloadFiles, parseStoredResponsesPayload, RESPONSES_REFRESH_DEBOUNCE_MS, serializeStoredResponsesPayload } from './responses-payload.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  BackoffRow,
  CachedModelsRow,
  ModelsCacheRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceMetricScope,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  ProxyBackoffRepo,
  ProxyRecord,
  ProxyRepo,
  Repo,
  ResponsesItemsRepo,
  ResponsesSnapshotsRepo,
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
import { serializeStoredConfig, serializeStoredState } from './upstream-json.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import { generateSessionToken } from '../shared/session-tokens.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import { BILLING_DIMENSIONS, type BillingDimension, type ModelPricing, resolveEffectivePricing, unitPriceForDimension } from '@floway-dev/protocols/common';
import type { ProxyFallbackEntry, ModelPrefixConfig, ProviderModel, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { normalizeModelPrefix } from '@floway-dev/provider';

const runStatements = async (db: SqlDatabase, statements: SqlPreparedStatement[]): Promise<SqlResult[]> => {
  if (statements.length === 0) return [];
  if (db.batch) return await db.batch(statements);
  const results: SqlResult[] = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
};

interface ApiKeyRow {
  id: string;
  user_id: number;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string | null;
  deleted_at: string | null;
  dump_retention_seconds: number | null;
}

const API_KEY_COLUMNS = 'id, user_id, name, key, created_at, last_used_at, upstream_ids, deleted_at, dump_retention_seconds';

const serializeUpstreamIds = (value: readonly string[] | null): string | null => (value === null ? null : JSON.stringify(value));

// Throws on bad data: silently returning null would broaden the row's
// upstream access beyond what the admin set.
const parseUpstreamIds = (raw: string | null, label: string): string[] | null => {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`upstream_ids JSON is malformed for ${label}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`upstream_ids is not an array for ${label}`);
  if (!parsed.every(item => typeof item === 'string')) throw new Error(`upstream_ids contains non-string entries for ${label}`);
  return parsed as string[];
};

const toApiKey = (row: ApiKeyRow): ApiKey => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  key: row.key,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? undefined,
  upstreamIds: parseUpstreamIds(row.upstream_ids, `api_keys.id=${row.id}`),
  deletedAt: row.deleted_at,
  dumpRetentionSeconds: row.dump_retention_seconds,
});

class SqlApiKeyRepo implements ApiKeyRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at`)
      .all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async listIncludingDeleted(): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys ORDER BY created_at`)
      .all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async listByUserId(userId: number): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at`)
      .bind(userId)
      .all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async listByUserIdIncludingDeleted(userId: number): Promise<ApiKey[]> {
    const { results } = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = ? ORDER BY created_at`)
      .bind(userId)
      .all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE key = ? AND deleted_at IS NULL`)
      .bind(rawKey)
      .first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db
      .prepare(`SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE id = ? AND deleted_at IS NULL`)
      .bind(id)
      .first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async idsByUserIdIncludingDeleted(userId: number): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM api_keys WHERE user_id = ?')
      .bind(userId)
      .all<{ id: string }>();
    return results.map(r => r.id);
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (${API_KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id = excluded.user_id,
           name = excluded.name,
           key = excluded.key,
           last_used_at = excluded.last_used_at,
           upstream_ids = excluded.upstream_ids,
           deleted_at = excluded.deleted_at,
           dump_retention_seconds = excluded.dump_retention_seconds`,
      )
      .bind(
        key.id,
        key.userId,
        key.name,
        key.key,
        key.createdAt,
        key.lastUsedAt ?? null,
        serializeUpstreamIds(key.upstreamIds),
        key.deletedAt,
        key.dumpRetentionSeconds,
      )
      .run();
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE api_keys SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(new Date().toISOString(), id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async softDeleteByUserId(userId: number): Promise<number> {
    const result = await this.db
      .prepare('UPDATE api_keys SET deleted_at = ? WHERE user_id = ? AND deleted_at IS NULL')
      .bind(new Date().toISOString(), userId)
      .run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM api_keys').run();
  }
}

interface UserRow {
  id: number;
  username: string;
  password_hash: string | null;
  is_admin: number;
  upstream_ids: string | null;
  can_view_global_telemetry: number;
  created_at: string;
  deleted_at: string | null;
}

const USER_COLUMNS = 'id, username, password_hash, is_admin, upstream_ids, can_view_global_telemetry, created_at, deleted_at';

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  isAdmin: row.is_admin === 1,
  upstreamIds: parseUpstreamIds(row.upstream_ids, `users.id=${row.id}`),
  canViewGlobalTelemetry: row.can_view_global_telemetry === 1,
  createdAt: row.created_at,
  deletedAt: row.deleted_at,
});

class SqlUsersRepo implements UsersRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<User[]> {
    const { results } = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY id`)
      .all<UserRow>();
    return results.map(toUser);
  }

  async listIncludingDeleted(): Promise<User[]> {
    const { results } = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`)
      .all<UserRow>();
    return results.map(toUser);
  }

  async getById(id: number): Promise<User | null> {
    const row = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`)
      .bind(id)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const row = await this.db
      .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username = ? AND deleted_at IS NULL`)
      .bind(username)
      .first<UserRow>();
    return row ? toUser(row) : null;
  }

  async createNewUser(template: Omit<User, 'id'>): Promise<User> {
    // INSERT ... SELECT computes id = MAX(id) + 1 in one statement, so
    // concurrent admin creates serialize on D1's per-database write lock and
    // pick distinct ids.
    const row = await this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, can_view_global_telemetry, created_at, deleted_at)
         SELECT COALESCE(MAX(id), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM users
         RETURNING id`,
      )
      .bind(
        template.username,
        template.passwordHash,
        template.isAdmin ? 1 : 0,
        serializeUpstreamIds(template.upstreamIds),
        template.canViewGlobalTelemetry ? 1 : 0,
        template.createdAt,
        template.deletedAt,
      )
      .first<{ id: number }>();
    if (!row) throw new Error('createNewUser: insert returned no rows');
    return { ...template, id: row.id };
  }

  async save(user: User): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (${USER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           username = excluded.username,
           password_hash = excluded.password_hash,
           is_admin = excluded.is_admin,
           upstream_ids = excluded.upstream_ids,
           can_view_global_telemetry = excluded.can_view_global_telemetry,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        user.id,
        user.username,
        user.passwordHash,
        user.isAdmin ? 1 : 0,
        serializeUpstreamIds(user.upstreamIds),
        user.canViewGlobalTelemetry ? 1 : 0,
        user.createdAt,
        user.deletedAt,
      )
      .run();
  }

  async softDelete(id: number): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE users SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .bind(new Date().toISOString(), id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM users').run();
  }
}

interface SessionRow {
  id: string;
  user_id: number;
  created_at: string;
  last_seen_at: string;
}

const SESSION_COLUMNS = 'id, user_id, created_at, last_seen_at';

class SqlSessionsRepo implements SessionsRepo {
  constructor(private db: SqlDatabase) {}

  async getByIdAndTouch(id: string): Promise<Session | null> {
    const row = await this.db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
      .bind(id)
      .first<SessionRow>();
    if (!row) return null;
    const now = new Date().toISOString();
    await this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, id).run();
    return { id: row.id, userId: row.user_id, createdAt: row.created_at, lastSeenAt: now };
  }

  async create(userId: number): Promise<Session> {
    const id = generateSessionToken();
    const now = new Date().toISOString();
    await this.db
      .prepare(`INSERT INTO sessions (${SESSION_COLUMNS}) VALUES (?, ?, ?, ?)`)
      .bind(id, userId, now, now)
      .run();
    return { id, userId, createdAt: now, lastSeenAt: now };
  }

  async deleteById(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteByUserId(userId: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    return result.meta.changes ?? 0;
  }

  async deleteByUserIdExcept(userId: number, exceptId: string): Promise<number> {
    const result = await this.db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?')
      .bind(userId, exceptId)
      .run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM sessions').run();
  }
}

const dimensionRows = (record: UsageRecord): { dimension: BillingDimension; tokens: number; unitPrice: number | null }[] => {
  const effective = resolveEffectivePricing(record.cost, record.tier);
  return BILLING_DIMENSIONS.flatMap(dimension => {
    const tokens = record.tokens[dimension] ?? 0;
    return tokens > 0 ? [{ dimension, tokens, unitPrice: unitPriceForDimension(effective, dimension) }] : [];
  });
};

class SqlUsageRepo implements UsageRepo {
  constructor(private db: SqlDatabase) {}

  async record(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    const statements: SqlPreparedStatement[] = dimensionRows(record).map(row =>
      this.db
        .prepare(
          `INSERT INTO usage (key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET
             tokens = tokens + excluded.tokens,
             unit_price = COALESCE(unit_price, excluded.unit_price)`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.tier, row.dimension, row.tokens, row.unitPrice));
    statements.push(
      this.db
        .prepare(
          `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, tier, requests) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET requests = requests + excluded.requests`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.tier, record.requests),
    );
    await runStatements(this.db, statements);
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const dimensionWhere = opts.keyId ? 'key_id = ? AND hour >= ? AND hour < ?' : 'hour >= ? AND hour < ?';
    const binds = opts.keyId ? [opts.keyId, opts.start, opts.end] : [opts.start, opts.end];
    const [{ results: dimensions }, { results: requests }] = await Promise.all([
      this.db
        .prepare(`SELECT key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price FROM usage WHERE ${dimensionWhere}`)
        .bind(...binds)
        .all<UsageDimensionRow>(),
      this.db
        .prepare(`SELECT key_id, model, upstream, model_key, hour, tier, requests FROM usage_requests WHERE ${dimensionWhere}`)
        .bind(...binds)
        .all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(dimensions, requests);
  }

  async listAll(): Promise<UsageRecord[]> {
    const [{ results: dimensions }, { results: requests }] = await Promise.all([
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price FROM usage').all<UsageDimensionRow>(),
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, tier, requests FROM usage_requests').all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(dimensions, requests);
  }

  async set(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    // Replacement upsert: clear the bucket's existing dimension rows first so
    // dimensions absent from the new record do not linger.
    const statements: SqlPreparedStatement[] = [
      this.db
        .prepare("DELETE FROM usage WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND hour = ? AND COALESCE(tier, '') = COALESCE(?, '')")
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.tier),
      ...dimensionRows(record).map(row =>
        this.db
          .prepare('INSERT INTO usage (key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.tier, row.dimension, row.tokens, row.unitPrice)),
    ];
    statements.push(
      this.db
        .prepare(
          `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, tier, requests) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET requests = excluded.requests`,
        )
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, record.tier, record.requests),
    );
    await runStatements(this.db, statements);
  }

  async deleteAll(): Promise<void> {
    await runStatements(this.db, [this.db.prepare('DELETE FROM usage'), this.db.prepare('DELETE FROM usage_requests')]);
  }
}

interface UsageDimensionRow {
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  hour: string;
  tier: string | null;
  dimension: string;
  tokens: number;
  unit_price: number | null;
}

interface UsageRequestRow {
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  hour: string;
  tier: string | null;
  requests: number;
}

const usageBucketKey = (row: { key_id: string; model: string; upstream: string | null; model_key: string; hour: string; tier: string | null }): string =>
  [row.key_id, row.model, row.upstream ?? '', row.model_key, row.hour, row.tier ?? ''].join('\0');

// Reassemble per-bucket UsageRecords from the two narrow tables. The dimension
// rows carry the disjoint counts and the per-dimension unit_price snapshot,
// which we fold back into a ModelPricing snapshot; usage_requests carries the
// request count. A bucket may appear in either table independently.
const assembleUsageRecords = (dimensions: readonly UsageDimensionRow[], requests: readonly UsageRequestRow[]): UsageRecord[] => {
  const byBucket = new Map<string, UsageRecord>();

  const ensureRecord = (row: { key_id: string; model: string; upstream: string | null; model_key: string; hour: string; tier: string | null }): UsageRecord => {
    const key = usageBucketKey(row);
    let record = byBucket.get(key);
    if (!record) {
      record = { keyId: row.key_id, model: row.model, upstream: row.upstream, modelKey: row.model_key, hour: row.hour, tier: row.tier, requests: 0, tokens: {}, cost: null };
      byBucket.set(key, record);
    }
    return record;
  };

  const pricingByBucket = new Map<string, ModelPricing>();
  for (const row of dimensions) {
    const record = ensureRecord(row);
    record.tokens[row.dimension as BillingDimension] = row.tokens;
    if (row.unit_price !== null) {
      const key = usageBucketKey(row);
      const pricing = pricingByBucket.get(key) ?? {};
      pricing[row.dimension as BillingDimension] = row.unit_price;
      pricingByBucket.set(key, pricing);
    }
  }
  for (const [key, pricing] of pricingByBucket) {
    const record = byBucket.get(key);
    if (record) record.cost = pricing;
  }

  for (const row of requests) ensureRecord(row).requests = row.requests;

  return [...byBucket.values()].sort((a, b) => a.hour.localeCompare(b.hour));
};

class SqlSearchUsageRepo implements SearchUsageRepo {
  constructor(private db: SqlDatabase) {}

  async record(args: { provider: SearchUsageRecord['provider']; keyId: string; action: SearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
    const validProvider = assertWebSearchProviderName(args.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, action, hour, requests) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, key_id, action, hour) DO UPDATE SET
           requests = requests + excluded.requests`,
      )
      .bind(validProvider, args.keyId, args.action, args.hour, args.requests)
      .run();
  }

  async query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; action?: SearchUsageRecord['action']; start: string; end: string }): Promise<SearchUsageRecord[]> {
    const filters = ['hour >= ?', 'hour < ?'];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.provider) {
      const validProvider = assertWebSearchProviderName(opts.provider);
      filters.unshift('provider = ?');
      binds.unshift(validProvider);
    }
    if (opts.keyId) {
      filters.push('key_id = ?');
      binds.push(opts.keyId);
    }
    if (opts.action) {
      filters.push('action = ?');
      binds.push(opts.action);
    }

    const { results } = await this.db
      .prepare(`SELECT provider, key_id, action, hour, requests FROM search_usage WHERE ${filters.join(' AND ')} ORDER BY hour`)
      .bind(...binds)
      .all<{
      provider: string;
      key_id: string;
      action: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    const { results } = await this.db.prepare('SELECT provider, key_id, action, hour, requests FROM search_usage ORDER BY hour').all<{
      provider: string;
      key_id: string;
      action: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, action, hour, requests) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, key_id, action, hour) DO UPDATE SET
           requests = excluded.requests`,
      )
      .bind(provider, record.keyId, record.action, record.hour, record.requests)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM search_usage').run();
  }
}

class SqlPerformanceRepo implements PerformanceRepo {
  constructor(private db: SqlDatabase) {}

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const bucket = latencyBucketForMs(durationMs);
    await runStatements(this.db, [this.addSummaryStatement(sample, 1, 0, durationMs), this.bucketStatement(sample, bucket.lowerMs, bucket.upperMs, 1, 'add')]);
  }

  async recordError(sample: PerformanceErrorSample): Promise<void> {
    await this.addSummaryStatement(sample, 0, 1, 0).run();
  }

  async query(opts: { keyId?: string; metricScope?: PerformanceMetricScope; start: string; end: string }): Promise<PerformanceTelemetryRecord[]> {
    const filters = ['hour >= ?', 'hour < ?'];
    const binds: unknown[] = [opts.start, opts.end];
    if (opts.keyId) {
      filters.push('key_id = ?');
      binds.push(opts.keyId);
    }
    if (opts.metricScope) {
      filters.push('metric_scope = ?');
      binds.push(opts.metricScope);
    }
    return await this.queryWhere(filters.join(' AND '), binds);
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return await this.queryWhere('1 = 1', []);
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    await runStatements(this.db, [
      this.setSummaryStatement(record),
      this.deleteBucketsStatement(record),
      ...record.buckets.map(bucket => this.bucketStatement(record, bucket.lowerMs, bucket.upperMs, bucket.count, 'set')),
    ]);
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM performance_latency_buckets').run();
    await this.db.prepare('DELETE FROM performance_summary').run();
  }

  private async queryWhere(where: string, binds: unknown[]): Promise<PerformanceTelemetryRecord[]> {
    const records = new Map<string, PerformanceTelemetryRecord>();

    const { results: summaries } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, requests, errors, total_ms_sum
         FROM performance_summary WHERE ${where} ORDER BY hour`,
      )
      .bind(...binds)
      .all<PerformanceSummaryRow>();
    for (const row of summaries) {
      const dimensions = performanceDimensionsFromRow(row);
      records.set(performanceRecordKey(dimensions), {
        ...dimensions,
        requests: row.requests,
        errors: row.errors,
        totalMsSum: row.total_ms_sum,
        buckets: [],
      });
    }

    const { results: buckets } = await this.db
      .prepare(
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, lower_ms, upper_ms, count
         FROM performance_latency_buckets WHERE ${where} ORDER BY hour, upper_ms`,
      )
      .bind(...binds)
      .all<PerformanceBucketRow>();
    for (const row of buckets) {
      const dimensions = performanceDimensionsFromRow(row);
      const key = performanceRecordKey(dimensions);
      let record = records.get(key);
      if (!record) {
        record = {
          ...dimensions,
          requests: 0,
          errors: 0,
          totalMsSum: 0,
          buckets: [],
        };
        records.set(key, record);
      }
      record.buckets.push({
        lowerMs: row.lower_ms,
        upperMs: row.upper_ms,
        count: row.count,
      });
    }

    return [...records.values()].sort(comparePerformanceTelemetryRecords);
  }

  private addSummaryStatement(sample: PerformanceDimensions, requests: number, errors: number, totalMsSum: number): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = requests + excluded.requests,
           errors = errors + excluded.errors,
           total_ms_sum = total_ms_sum + excluded.total_ms_sum`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.upstream,
        sample.modelKey,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        requests,
        errors,
        totalMsSum,
      );
  }

  private setSummaryStatement(record: PerformanceTelemetryRecord): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = excluded.requests,
           errors = excluded.errors,
           total_ms_sum = excluded.total_ms_sum`,
      )
      .bind(
        record.hour,
        record.metricScope,
        record.keyId,
        record.model,
        record.upstream,
        record.modelKey,
        record.stream ? 1 : 0,
        record.runtimeLocation,
        record.requests,
        record.errors,
        record.totalMsSum,
      );
  }

  private deleteBucketsStatement(record: PerformanceDimensions): SqlPreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM performance_latency_buckets
         WHERE hour = ? AND metric_scope = ? AND key_id = ? AND model = ? AND upstream IS ? AND model_key = ? AND stream = ? AND runtime_location = ?`,
      )
      .bind(...performanceDimensionBinds(record));
  }

  private bucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number, mode: 'add' | 'set'): SqlPreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, upstream, model_key, stream, runtime_location, lower_ms, upper_ms, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           count = ${mode === 'add' ? 'count + excluded.count' : 'excluded.count'}`,
      )
      .bind(
        sample.hour,
        sample.metricScope,
        sample.keyId,
        sample.model,
        sample.upstream,
        sample.modelKey,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        lowerMs,
        upperMs,
        count,
      );
  }
}

type PerformanceDimensionRow = {
  hour: string;
  metric_scope: string;
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  stream: number;
  runtime_location: string;
};

interface PerformanceSummaryRow extends PerformanceDimensionRow {
  requests: number;
  errors: number;
  total_ms_sum: number;
}

interface PerformanceBucketRow extends PerformanceDimensionRow {
  lower_ms: number;
  upper_ms: number;
  count: number;
}

const performanceDimensionsFromRow = (row: PerformanceDimensionRow): PerformanceDimensions => ({
  hour: row.hour,
  metricScope: row.metric_scope as PerformanceMetricScope,
  keyId: row.key_id,
  model: row.model,
  upstream: row.upstream,
  modelKey: row.model_key,
  stream: row.stream === 1,
  runtimeLocation: row.runtime_location,
});

const performanceRecordKey = (record: PerformanceDimensions): string =>
  [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.stream ? '1' : '0', record.runtimeLocation].join(
    '\0',
  );

const performanceDimensionBinds = (record: PerformanceDimensions): unknown[] =>
  [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.stream ? 1 : 0, record.runtimeLocation];

const comparePerformanceTelemetryRecords = (a: PerformanceTelemetryRecord, b: PerformanceTelemetryRecord): number =>
  a.hour.localeCompare(b.hour) ||
  a.metricScope.localeCompare(b.metricScope) ||
  a.keyId.localeCompare(b.keyId) ||
  a.model.localeCompare(b.model) ||
  (a.upstream ?? '').localeCompare(b.upstream ?? '') ||
  a.modelKey.localeCompare(b.modelKey) ||
  Number(a.stream) - Number(b.stream) ||
  a.runtimeLocation.localeCompare(b.runtimeLocation);

const toSearchUsageRecord = (row: { provider: string; key_id: string; action: string; hour: string; requests: number }): SearchUsageRecord => {
  if (row.action !== 'search' && row.action !== 'fetch_page') {
    throw new TypeError(`Invalid search usage action: ${row.action}`);
  }
  return {
    provider: assertWebSearchProviderName(row.provider),
    keyId: row.key_id,
    action: row.action,
    hour: row.hour,
    requests: row.requests,
  };
};

// `ProviderModel.enabledFlags` is a Set, which JSON.stringify renders as `{}`
// and JSON.parse cannot rebuild on its own. Replace Set with an array on
// write, and rebuild Set under the same key on read so consumers downstream
// of the cache see the same shape providers produced.
const modelsReplacer = (_key: string, value: unknown): unknown =>
  value instanceof Set ? [...value] : value;
const modelsReviver = (key: string, value: unknown): unknown =>
  key === 'enabledFlags' && Array.isArray(value) ? new Set(value) : value;

class SqlModelsCacheRepo implements ModelsCacheRepo {
  constructor(private db: SqlDatabase) {}

  async get(upstreamId: string): Promise<CachedModelsRow | null> {
    const row = await this.db
      .prepare('SELECT fetched_at, models_json, last_error_json FROM models_cache WHERE upstream_id = ?')
      .bind(upstreamId)
      .first<{ fetched_at: number; models_json: string; last_error_json: string | null }>();
    if (!row) return null;
    return {
      fetchedAt: row.fetched_at,
      models: JSON.parse(row.models_json, modelsReviver) as ProviderModel[],
      lastError: row.last_error_json ? JSON.parse(row.last_error_json) as { message: string; at: number } : null,
    };
  }

  async put(upstreamId: string, row: { fetchedAt: number; models: ProviderModel[] }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO models_cache (upstream_id, fetched_at, models_json, last_error_json) VALUES (?, ?, ?, NULL)
         ON CONFLICT (upstream_id) DO UPDATE SET
           fetched_at = excluded.fetched_at,
           models_json = excluded.models_json,
           last_error_json = NULL`,
      )
      .bind(upstreamId, row.fetchedAt, JSON.stringify(row.models, modelsReplacer))
      .run();
  }

  async setLastError(upstreamId: string, error: { message: string; at: number } | null): Promise<void> {
    // lastError annotates a previously-successful fetch, so we do not insert a stub row here.
    await this.db
      .prepare('UPDATE models_cache SET last_error_json = ? WHERE upstream_id = ?')
      .bind(error === null ? null : JSON.stringify(error), upstreamId)
      .run();
  }

  async delete(upstreamId: string): Promise<void> {
    await this.db.prepare('DELETE FROM models_cache WHERE upstream_id = ?').bind(upstreamId).run();
  }
}

const RESPONSES_ITEM_COLUMNS = 'id, api_key_id, upstream_id, upstream_item_id, item_type, origin, payload_json, content_hash, encrypted_content_hash, created_at, refreshed_at';
const RESPONSES_ITEM_ID_SCOPE_SQL = "COALESCE(api_key_id, '') = COALESCE(?, '')";

class SqlResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private db: SqlDatabase) {}

  async lookupMany(apiKeyId: string | null, ids: readonly string[]): Promise<StoredResponsesItem[]> {
    const rows = await this.lookupByColumn(apiKeyId, 'id', ids);
    const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async lookupManyByEncryptedContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'encrypted_content_hash', hashes);
  }

  async lookupManyByContentHash(apiKeyId: string | null, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'content_hash', hashes);
  }

  // D1 caps bound parameters at 100 per query (node:sqlite's default cap is
  // 32766, well above this). A single Responses request can echo back more
  // stored items than D1's cap — long agentic sessions resubmit every prior
  // reasoning/compaction item each turn — so chunk the IN-list well under
  // the tightest backend (the `api_key_id` bind shares the budget) and union
  // the results.
  private async lookupByColumn(apiKeyId: string | null, column: 'id' | 'content_hash' | 'encrypted_content_hash', values: readonly string[]): Promise<StoredResponsesItem[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];

    const CHUNK = 90;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));

    const perChunk = await Promise.all(chunks.map(async chunk => {
      const placeholders = chunk.map(() => '?').join(', ');
      const orderSql = column === 'id' ? '' : ' ORDER BY refreshed_at DESC, created_at DESC, id ASC';
      const scopeSql = column === 'id' ? RESPONSES_ITEM_ID_SCOPE_SQL : 'api_key_id IS ?';
      const { results } = await this.db
        .prepare(`SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items WHERE ${scopeSql} AND ${column} IN (${placeholders})${orderSql}`)
        .bind(apiKeyId, ...chunk)
        .all<ResponsesItemRow>();
      return await Promise.all(results.map(toStoredResponsesItem));
    }));
    return perChunk.flat();
  }

  async insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    const statements = await Promise.all(items.map(async item => {
      const payload = await serializeStoredResponsesPayload(item.id, item.apiKeyId, item.createdAt, item.payload);
      return this.db
        .prepare(
          `INSERT INTO responses_items (${RESPONSES_ITEM_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id, COALESCE(api_key_id, '')) DO NOTHING`,
        )
        .bind(item.id, item.apiKeyId, item.upstreamId, item.upstreamItemId, item.itemType, item.origin, payload, item.contentHash, item.encryptedContentHash, item.createdAt, item.refreshedAt);
    }));
    await runStatements(this.db, statements);
  }

  async fillPayloads(items: readonly StoredResponsesItem[]): Promise<number> {
    const statements = await Promise.all(items.flatMap(item => {
      if (item.payload === null) return [];
      return [serializeStoredResponsesPayload(item.id, item.apiKeyId, item.createdAt, item.payload).then(payload =>
        this.db
          .prepare(
            `UPDATE responses_items
             SET payload_json = ?, content_hash = ?, encrypted_content_hash = ?, created_at = ?, refreshed_at = ?
             WHERE ${RESPONSES_ITEM_ID_SCOPE_SQL} AND id = ? AND payload_json IS NULL`,
          )
          .bind(payload, item.contentHash, item.encryptedContentHash, item.createdAt, item.refreshedAt, item.apiKeyId, item.id))];
    }));
    const results = await runStatements(this.db, statements);
    return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  }

  async refreshMany(apiKeyId: string | null, ids: readonly string[], refreshedAt: number): Promise<number> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return 0;

    const CHUNK = 88;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
    const results = await Promise.all(chunks.map(async chunk => {
      const placeholders = chunk.map(() => '?').join(', ');
      return await this.db
        .prepare(`UPDATE responses_items SET refreshed_at = ? WHERE ${RESPONSES_ITEM_ID_SCOPE_SQL} AND id IN (${placeholders}) AND refreshed_at < ?`)
        .bind(refreshedAt, apiKeyId, ...chunk, refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS)
        .run();
    }));
    return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  }

  async clearPayloadOlderThan(createdBefore: number): Promise<number> {
    const result = await this.db.prepare('UPDATE responses_items SET payload_json = NULL WHERE payload_json IS NOT NULL AND created_at < ?').bind(createdBefore).run();
    return result.meta.changes ?? 0;
  }

  async deleteOlderThan(refreshedBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_items WHERE refreshed_at < ?').bind(refreshedBefore).run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_items').run();
    await deleteAllResponsesItemPayloadFiles();
  }
}

interface ResponsesItemRow {
  id: string;
  api_key_id: string | null;
  upstream_id: string | null;
  upstream_item_id: string | null;
  item_type: string;
  origin: StoredResponsesItem['origin'];
  payload_json: string | null;
  content_hash: string | null;
  encrypted_content_hash: string | null;
  created_at: number;
  refreshed_at: number;
}

const toStoredResponsesItem = async (row: ResponsesItemRow): Promise<StoredResponsesItem> => ({
  id: row.id,
  apiKeyId: row.api_key_id,
  upstreamId: row.upstream_id,
  upstreamItemId: row.upstream_item_id,
  itemType: row.item_type,
  origin: row.origin,
  payload: await parseStoredResponsesPayload(row.id, row.payload_json),
  contentHash: row.content_hash,
  encryptedContentHash: row.encrypted_content_hash,
  createdAt: row.created_at,
  refreshedAt: row.refreshed_at,
});

class SqlResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  constructor(private db: SqlDatabase) {}

  async lookup(apiKeyId: string | null, id: string): Promise<StoredResponsesSnapshot | null> {
    const row = await this.db
      .prepare('SELECT id, api_key_id, item_ids_json, created_at, refreshed_at FROM responses_snapshots WHERE id = ? AND COALESCE(api_key_id, \'\') = COALESCE(?, \'\')')
      .bind(id, apiKeyId)
      .first<ResponsesSnapshotRow>();
    return row ? toStoredResponsesSnapshot(row) : null;
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, created_at, refreshed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id, COALESCE(api_key_id, '')) DO UPDATE SET item_ids_json = excluded.item_ids_json, refreshed_at = excluded.refreshed_at`,
      )
      .bind(snapshot.id, snapshot.apiKeyId, JSON.stringify(snapshot.itemIds), snapshot.createdAt, snapshot.refreshedAt)
      .run();
  }

  async refresh(apiKeyId: string | null, id: string, refreshedAt: number): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE responses_snapshots SET refreshed_at = ? WHERE id = ? AND COALESCE(api_key_id, \'\') = COALESCE(?, \'\') AND refreshed_at < ?')
      .bind(refreshedAt, id, apiKeyId, refreshedAt - RESPONSES_REFRESH_DEBOUNCE_MS)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteOlderThan(refreshedBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_snapshots WHERE refreshed_at < ?').bind(refreshedBefore).run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_snapshots').run();
  }
}

interface ResponsesSnapshotRow {
  id: string;
  api_key_id: string | null;
  item_ids_json: string;
  created_at: number;
  refreshed_at: number;
}

const toStoredResponsesSnapshot = (row: ResponsesSnapshotRow): StoredResponsesSnapshot => {
  const parsed: unknown = JSON.parse(row.item_ids_json);
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string')) {
    throw new Error(`Invalid responses_snapshots.item_ids_json for id=${row.id}`);
  }
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    itemIds: parsed,
    createdAt: row.created_at,
    refreshedAt: row.refreshed_at,
  };
};

class SqlSearchConfigRepo implements SearchConfigRepo {
  constructor(private db: SqlDatabase) {}

  async get(): Promise<unknown | null> {
    const row = await this.db
      .prepare('SELECT provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key FROM search_config WHERE id = 1')
      .first<{ provider: string; tavily_api_key: string; microsoft_grounding_api_key: string; jina_api_key: string }>();
    if (!row) throw new Error('search_config singleton row missing');
    return {
      provider: row.provider,
      tavily: { apiKey: row.tavily_api_key },
      microsoftGrounding: { apiKey: row.microsoft_grounding_api_key },
      jina: { apiKey: row.jina_api_key },
    };
  }

  async save(config: unknown): Promise<void> {
    const { provider, tavily, microsoftGrounding, jina } = config as {
      provider: string;
      tavily: { apiKey: string };
      microsoftGrounding: { apiKey: string };
      jina: { apiKey: string };
    };
    await this.db
      .prepare(
        `INSERT INTO search_config (id, provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key, updated_at)
         VALUES (1, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           tavily_api_key = excluded.tavily_api_key,
           microsoft_grounding_api_key = excluded.microsoft_grounding_api_key,
           jina_api_key = excluded.jina_api_key,
           updated_at = excluded.updated_at`,
      )
      .bind(provider, tavily.apiKey, microsoftGrounding.apiKey, jina.apiKey)
      .run();
  }
}

class SqlUpstreamRepo implements UpstreamRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<UpstreamRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json FROM upstreams ORDER BY sort_order, created_at')
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json FROM upstreams WHERE id = ?')
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    // created_at is deliberately not in the ON CONFLICT update list: the row's first INSERT
    // wins, and re-saves preserve that timestamp regardless of what the caller passes.
    await this.db
      .prepare(
        `INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           name = excluded.name,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           config_json = excluded.config_json,
           state_json = excluded.state_json,
           flag_overrides = excluded.flag_overrides,
           disabled_public_model_ids = excluded.disabled_public_model_ids,
           proxy_fallback_list_json = excluded.proxy_fallback_list_json,
           model_prefix_json = excluded.model_prefix_json`,
      )
      .bind(
        upstream.id,
        upstream.kind,
        upstream.name,
        upstream.enabled ? 1 : 0,
        upstream.sortOrder,
        upstream.createdAt,
        upstream.updatedAt,
        serializeStoredConfig(upstream.config),
        serializeStoredState(upstream.state),
        JSON.stringify(normalizeFlagOverrides(upstream.flagOverrides)),
        JSON.stringify(normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds)),
        JSON.stringify(normalizeProxyFallbackList(upstream.proxyFallbackList)),
        upstream.modelPrefix === null ? null : JSON.stringify(upstream.modelPrefix),
      )
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM upstreams WHERE id = ?').bind(id).run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstreams').run();
  }

  // `IS` (not `=`) so NULL on either side compares correctly — a row whose
  // state_json is SQL NULL still matches when the caller passes
  // expectedState: null. The serialized form here must equal what save()
  // wrote for the predicate to hold on the back-to-back write path.
  async saveState(id: string, newState: unknown, options: { expectedState: unknown }): Promise<{ updated: boolean }> {
    const result = await this.db
      .prepare('UPDATE upstreams SET state_json = ? WHERE id = ? AND state_json IS ?')
      .bind(serializeStoredState(newState), id, serializeStoredState(options.expectedState))
      .run();
    return { updated: (result.meta.changes ?? 0) > 0 };
  }
}

interface UpstreamRow {
  id: string;
  provider: string;
  name: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  config_json: string;
  state_json: string | null;
  flag_overrides: string;
  disabled_public_model_ids: string;
  proxy_fallback_list_json: string;
  model_prefix_json: string | null;
}

const toUpstreamRecord = (row: UpstreamRow): UpstreamRecord => {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json) as unknown;
  } catch (cause) {
    throw new Error(`Malformed upstream config JSON for ${row.id}`, { cause });
  }
  let state: unknown = null;
  if (row.state_json !== null) {
    try {
      state = JSON.parse(row.state_json) as unknown;
    } catch (cause) {
      throw new Error(`Malformed upstream state JSON for ${row.id}`, { cause });
    }
  }

  return {
    id: row.id,
    kind: assertUpstreamProviderKind(row.provider),
    name: row.name,
    enabled: row.enabled !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config,
    state,
    flagOverrides: parseFlagOverrides(row.id, row.flag_overrides),
    disabledPublicModelIds: parseDisabledPublicModelIds(row.id, row.disabled_public_model_ids),
    proxyFallbackList: parseProxyFallbackList(row.id, row.proxy_fallback_list_json),
    modelPrefix: parseModelPrefix(row.id, row.model_prefix_json),
  };
};

const assertUpstreamProviderKind = (provider: string): UpstreamProviderKind => {
  if (provider === 'copilot' || provider === 'custom' || provider === 'azure' || provider === 'codex' || provider === 'claude-code' || provider === 'ollama') return provider;
  throw new TypeError(`Invalid upstream provider kind: ${provider}`);
};

const parseFlagOverrides = (id: string, json: string): Record<string, boolean> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream flag_overrides JSON for ${id}`, { cause });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed;
    throw new Error(`Upstream ${id} flag_overrides must be a JSON object, got ${got}`);
  }
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'boolean') {
      throw new Error(`Upstream ${id} flag_overrides[${JSON.stringify(k)}] must be a boolean, got ${typeof v}`);
    }
    out[k] = v;
  }
  return normalizeFlagOverrides(out);
};

const parseDisabledPublicModelIds = (id: string, json: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream disabled_public_model_ids JSON for ${id}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Upstream ${id} disabled_public_model_ids must be a JSON array, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error(`Upstream ${id} disabled_public_model_ids entries must be strings, got ${typeof entry}`);
    }
  }
  return normalizeDisabledPublicModelIds(parsed as string[]);
};

const parseProxyFallbackList = (id: string, json: string): ProxyFallbackEntry[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream proxy_fallback_list_json for ${id}`, { cause });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Upstream ${id} proxy_fallback_list_json must be a JSON array, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  const entries: ProxyFallbackEntry[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Upstream ${id} proxy_fallback_list_json entries must be objects, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`);
    }
    const entry = raw as { id?: unknown; colos?: unknown };
    if (typeof entry.id !== 'string') {
      throw new Error(`Upstream ${id} proxy_fallback_list entry .id must be a string, got ${typeof entry.id}`);
    }
    let colos: string[] | undefined;
    if (entry.colos !== undefined) {
      if (!Array.isArray(entry.colos)) {
        throw new Error(`Upstream ${id} proxy_fallback_list entry .colos must be an array when set, got ${typeof entry.colos}`);
      }
      colos = [];
      for (const c of entry.colos) {
        if (typeof c !== 'string') {
          throw new Error(`Upstream ${id} proxy_fallback_list entry .colos members must be strings, got ${typeof c}`);
        }
        colos.push(c);
      }
    }
    entries.push(colos === undefined ? { id: entry.id } : { id: entry.id, colos });
  }
  return normalizeProxyFallbackList(entries);
};

const parseModelPrefix = (id: string, json: string | null): ModelPrefixConfig | null => {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`Malformed upstream model_prefix_json for ${id}`, { cause });
  }
  try {
    return normalizeModelPrefix(parsed);
  } catch (cause) {
    throw new Error(`Invalid upstream model_prefix_json shape for ${id}`, { cause });
  }
};

class SqlProxyRepo implements ProxyRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<ProxyRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, name, url, created_at, updated_at, dial_timeout_seconds FROM proxies ORDER BY created_at')
      .all<ProxyRow>();
    return results.map(toProxyRecord);
  }

  async getById(id: string): Promise<ProxyRecord | null> {
    const row = await this.db
      .prepare('SELECT id, name, url, created_at, updated_at, dial_timeout_seconds FROM proxies WHERE id = ?')
      .bind(id)
      .first<ProxyRow>();
    return row ? toProxyRecord(row) : null;
  }

  async insert(input: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<ProxyRecord> {
    const now = new Date().toISOString();
    await this.db
      .prepare('INSERT INTO proxies (id, name, url, created_at, updated_at, dial_timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(input.id, input.name, input.url, now, now, input.dialTimeoutSeconds)
      .run();
    return {
      id: input.id,
      name: input.name,
      url: input.url,
      createdAt: now,
      updatedAt: now,
      dialTimeoutSeconds: input.dialTimeoutSeconds,
    };
  }

  async patch(id: string, patch: { name?: string; url?: string; dialTimeoutSeconds?: number | null }): Promise<{ record: ProxyRecord; urlChanged: boolean } | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const nextName = patch.name ?? existing.name;
    const nextUrl = patch.url ?? existing.url;
    // dialTimeoutSeconds is nullable, so distinguish "not in patch" from
    // "set to null" by hasOwn — `??` would collapse a deliberate clear.
    const nextDialTimeout = Object.hasOwn(patch, 'dialTimeoutSeconds') ? patch.dialTimeoutSeconds! : existing.dialTimeoutSeconds;
    const urlChanged = patch.url !== undefined && patch.url !== existing.url;
    const updatedAt = new Date().toISOString();

    await this.db
      .prepare('UPDATE proxies SET name = ?, url = ?, dial_timeout_seconds = ?, updated_at = ? WHERE id = ?')
      .bind(nextName, nextUrl, nextDialTimeout, updatedAt, id)
      .run();

    return {
      record: {
        ...existing,
        name: nextName,
        url: nextUrl,
        dialTimeoutSeconds: nextDialTimeout,
        updatedAt,
      },
      urlChanged,
    };
  }

  async delete(id: string): Promise<boolean> {
    // Conditional delete that refuses to drop a row currently referenced by
    // any upstream's fallback list. The route layer also reads
    // findUpstreamsReferencing before this call to surface a 409 with the
    // referencing ids — folding the same predicate into the DELETE closes
    // the TOCTOU window where an admin PATCHes an upstream to add the
    // reference between the read and the DELETE.
    const result = await this.db
      .prepare(
        `DELETE FROM proxies
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM upstreams u, json_each(u.proxy_fallback_list_json) j
             WHERE json_extract(j.value, '$.id') = proxies.id
           )`,
      )
      .bind(id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM proxies').run();
  }

  async save(record: { id: string; name: string; url: string; dialTimeoutSeconds: number | null }): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO proxies (id, name, url, created_at, updated_at, dial_timeout_seconds) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           url = excluded.url,
           updated_at = excluded.updated_at,
           dial_timeout_seconds = excluded.dial_timeout_seconds`,
      )
      .bind(record.id, record.name, record.url, now, now, record.dialTimeoutSeconds)
      .run();
  }

  async findUpstreamsReferencing(proxyId: string): Promise<string[]> {
    // json_each unrolls the upstreams.proxy_fallback_list_json array into
    // virtual rows so the predicate matches by element. Both D1 and
    // node:sqlite ship the json1 extension.
    const { results } = await this.db
      .prepare("SELECT DISTINCT u.id FROM upstreams u, json_each(u.proxy_fallback_list_json) j WHERE json_extract(j.value, '$.id') = ?")
      .bind(proxyId)
      .all<{ id: string }>();
    return results.map(row => row.id);
  }
}

interface ProxyRow {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
  dial_timeout_seconds: number | null;
}

const toProxyRecord = (row: ProxyRow): ProxyRecord => ({
  id: row.id,
  name: row.name,
  url: row.url,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  dialTimeoutSeconds: row.dial_timeout_seconds,
});

class SqlProxyBackoffRepo implements ProxyBackoffRepo {
  constructor(private db: SqlDatabase) {}

  async recordDialFailure(proxyId: string, upstreamId: string, errorMessage: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // SQLite reads RHS column references at the start of the UPDATE, before
    // the increment is applied. So `1 << fail_count` resolves against the
    // pre-increment value, yielding the 60 * 2^(n-1) schedule when this
    // call records the n-th consecutive failure. The exponent is clamped
    // at 6 because anything larger already exceeds the 3600s cap and would
    // risk integer overflow if a runaway proxy stays broken for thousands
    // of consecutive calls (the JS mirror in memory.ts wraps at 2^31; SQL
    // is wider but still finite — capping the exponent keeps both impls
    // bounded by construction).
    await this.db
      .prepare(
        `INSERT INTO proxy_upstream_backoffs
           (proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at)
         VALUES (?, ?, 1, ? + 60, ?, ?)
         ON CONFLICT (proxy_id, upstream_id) DO UPDATE SET
           fail_count = fail_count + 1,
           expires_at = ? + min(60 * (1 << min(fail_count, 6)), 3600),
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at`,
      )
      .bind(proxyId, upstreamId, now, errorMessage, now, now)
      .run();
  }

  async recordDialSuccess(proxyId: string, upstreamId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ? AND upstream_id = ?')
      .bind(proxyId, upstreamId)
      .run();
  }

  async listForUpstream(upstreamId: string): Promise<BackoffRow[]> {
    const { results } = await this.db
      .prepare('SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs WHERE upstream_id = ?')
      .bind(upstreamId)
      .all<BackoffRowDb>();
    return results.map(toBackoffRow);
  }

  async listForProxy(proxyId: string): Promise<BackoffRow[]> {
    const { results } = await this.db
      .prepare('SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs WHERE proxy_id = ?')
      .bind(proxyId)
      .all<BackoffRowDb>();
    return results.map(toBackoffRow);
  }

  async listAll(): Promise<BackoffRow[]> {
    const { results } = await this.db
      .prepare('SELECT proxy_id, upstream_id, fail_count, expires_at, last_error, last_error_at FROM proxy_upstream_backoffs')
      .all<BackoffRowDb>();
    return results.map(toBackoffRow);
  }

  async resetForProxy(proxyId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ?')
      .bind(proxyId)
      .run();
  }

  async resetForUpstream(upstreamId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM proxy_upstream_backoffs WHERE upstream_id = ?')
      .bind(upstreamId)
      .run();
  }

  async reset(proxyId: string, upstreamId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM proxy_upstream_backoffs WHERE proxy_id = ? AND upstream_id = ?')
      .bind(proxyId, upstreamId)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM proxy_upstream_backoffs').run();
  }
}

interface BackoffRowDb {
  proxy_id: string;
  upstream_id: string;
  fail_count: number;
  expires_at: number;
  last_error: string | null;
  last_error_at: number | null;
}

const toBackoffRow = (row: BackoffRowDb): BackoffRow => ({
  proxyId: row.proxy_id,
  upstreamId: row.upstream_id,
  failCount: row.fail_count,
  expiresAt: row.expires_at,
  lastError: row.last_error,
  lastErrorAt: row.last_error_at,
});

export class SqlRepo implements Repo {
  users: UsersRepo;
  sessions: SessionsRepo;
  apiKeys: ApiKeyRepo;
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

  constructor(db: SqlDatabase) {
    this.users = new SqlUsersRepo(db);
    this.sessions = new SqlSessionsRepo(db);
    this.apiKeys = new SqlApiKeyRepo(db);
    this.usage = new SqlUsageRepo(db);
    this.searchUsage = new SqlSearchUsageRepo(db);
    this.performance = new SqlPerformanceRepo(db);
    this.modelsCache = new SqlModelsCacheRepo(db);
    this.searchConfig = new SqlSearchConfigRepo(db);
    this.upstreams = new SqlUpstreamRepo(db);
    this.proxies = new SqlProxyRepo(db);
    this.proxyBackoffs = new SqlProxyBackoffRepo(db);
    this.responsesItems = new SqlResponsesItemsRepo(db);
    this.responsesSnapshots = new SqlResponsesSnapshotsRepo(db);
  }
}
