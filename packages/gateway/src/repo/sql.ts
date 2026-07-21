import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { scopedResponsesKey } from './responses-clone.ts';
import { deleteAllResponsesItemPayloadFiles, parseStoredResponsesPayload, RESPONSES_STATE_TTL_MS, responsesItemPayloadExpiryBucketPrefix, serializeStoredResponsesPayload, storedResponsesPayloadFileKey } from './responses-payload.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  AgentSetupMutation,
  AgentSetupRecord,
  AgentSetupRenewal,
  AgentSetupRepository,
  BackoffRow,
  CachedModelsRow,
  ModelAliasesRepo,
  ModelAliasRecord,
  ModelsCacheRepo,
  PerformanceBucketRow,
  PerformanceDimensions,
  PerformanceMetric,
  PerformanceRepo,
  PerformanceSample,
  PerformanceTelemetryRecord,
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
import { serializeStoredConfig, serializeStoredState } from './upstream-json.ts';
import { parseUpstreamColor, parseUpstreamKind } from './upstream-parse.ts';
import { usageMetricRows } from './usage-metrics.ts';
import { bucketForTtftMs, bucketForTpotUs } from '../shared/performance-histogram.ts';
import { parseServerSecret } from '../shared/server-secret.ts';
import { generateSessionToken } from '../shared/session-tokens.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';
import { getFileProvider, type SqlDatabase, type SqlPreparedStatement, type SqlResult } from '@floway-dev/platform';
import { addDecimalStrings, canonicalPricingSelectorKey, parseBillingMetric, parseNonNegativeDecimalString, parsePricingSelectorKey, type AliasSelection, type AliasTarget, type AnnouncedMetadata, type ModelKind } from '@floway-dev/protocols/common';
import type { ProviderModel, ProxyFallbackEntry, ModelPrefixConfig, PerformanceOperation, UpstreamRecord } from '@floway-dev/provider';
import { normalizeModelPrefix } from '@floway-dev/provider';

const runStatements = async (db: SqlDatabase, statements: SqlPreparedStatement[]): Promise<SqlResult[]> => {
  if (statements.length === 0) return [];
  if (db.batch) return await db.batch(statements);
  const results: SqlResult[] = [];
  for (const statement of statements) results.push(await statement.run());
  return results;
};

const mapSequentially = async <T, U>(values: readonly T[], mapper: (value: T) => Promise<U>): Promise<U[]> => {
  const mapped: U[] = [];
  for (const value of values) mapped.push(await mapper(value));
  return mapped;
};

interface ApiKeyRow {
  id: string;
  user_id: number;
  name: string;
  key: string;
  server_secret: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string | null;
  deleted_at: string | null;
  dump_retention_seconds: number | null;
}

const API_KEY_COLUMNS = 'id, user_id, name, key, server_secret, created_at, last_used_at, upstream_ids, deleted_at, dump_retention_seconds';

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
  serverSecret: parseServerSecret(row.server_secret, `api_keys.server_secret for id=${row.id}`),
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

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (${API_KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id = excluded.user_id,
           name = excluded.name,
           key = excluded.key,
           server_secret = excluded.server_secret,
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
        key.serverSecret,
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

class SqlUsageRepo implements UsageRepo {
  constructor(private db: SqlDatabase) {}

  private async addMetric(
    record: UsageRecord,
    upstream: string | null,
    selector: string,
    row: ReturnType<typeof usageMetricRows>[number],
  ): Promise<void> {
    const identity = [record.keyId, record.model, upstream, record.modelKey, record.hour, selector, row.metric];
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await this.db.prepare(
        "SELECT quantity FROM usage WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND hour = ? AND pricing_selector = ? AND metric = ?",
      ).bind(...identity).first<{ quantity: string }>();
      if (!current) {
        const inserted = await this.db.prepare(
          'INSERT OR IGNORE INTO usage (key_id, model, upstream, model_key, hour, pricing_selector, metric, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).bind(...identity, row.quantity, row.unitPrice).run();
        if (inserted.meta.changes === undefined) throw new Error('SQL runtime did not report inserted usage row count');
        if (inserted.meta.changes > 0) return;
        continue;
      }

      const quantity = addDecimalStrings(current.quantity, row.quantity);
      const updated = await this.db.prepare(
        "UPDATE usage SET quantity = ? WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND hour = ? AND pricing_selector = ? AND metric = ? AND quantity = ?",
      ).bind(quantity, ...identity, current.quantity).run();
      if (updated.meta.changes === undefined) throw new Error('SQL runtime did not report updated usage row count');
      if (updated.meta.changes > 0) return;
    }
    throw new Error(`Failed to aggregate usage metric ${row.metric} after 100 concurrent updates`);
  }

  async record(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    const selector = canonicalPricingSelectorKey(record.pricingSelector);
    await this.db.prepare(
      `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, pricing_selector, requests) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET requests = requests + excluded.requests`,
    ).bind(record.keyId, record.model, upstream, record.modelKey, record.hour, selector, record.requests).run();
    await Promise.all(usageMetricRows(record).map(row => this.addMetric(record, upstream, selector, row)));
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const where = opts.keyId ? 'key_id = ? AND hour >= ? AND hour < ?' : 'hour >= ? AND hour < ?';
    const binds = opts.keyId ? [opts.keyId, opts.start, opts.end] : [opts.start, opts.end];
    const [{ results: metrics }, { results: requests }] = await Promise.all([
      this.db.prepare(`SELECT key_id, model, upstream, model_key, hour, pricing_selector, metric, quantity, unit_price FROM usage WHERE ${where} ORDER BY rowid`).bind(...binds).all<UsageMetricRow>(),
      this.db.prepare(`SELECT key_id, model, upstream, model_key, hour, pricing_selector, requests FROM usage_requests WHERE ${where}`).bind(...binds).all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(metrics, requests);
  }

  async listAll(): Promise<UsageRecord[]> {
    const [{ results: metrics }, { results: requests }] = await Promise.all([
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, pricing_selector, metric, quantity, unit_price FROM usage ORDER BY rowid').all<UsageMetricRow>(),
      this.db.prepare('SELECT key_id, model, upstream, model_key, hour, pricing_selector, requests FROM usage_requests').all<UsageRequestRow>(),
    ]);
    return assembleUsageRecords(metrics, requests);
  }

  async set(record: UsageRecord): Promise<void> {
    const upstream = record.upstream ?? null;
    const selector = canonicalPricingSelectorKey(record.pricingSelector);
    const statements: SqlPreparedStatement[] = [
      this.db.prepare("DELETE FROM usage WHERE key_id = ? AND model = ? AND COALESCE(upstream, '') = COALESCE(?, '') AND model_key = ? AND hour = ? AND pricing_selector = ?")
        .bind(record.keyId, record.model, upstream, record.modelKey, record.hour, selector),
      ...usageMetricRows(record).map(row => this.db.prepare(
        'INSERT INTO usage (key_id, model, upstream, model_key, hour, pricing_selector, metric, quantity, unit_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(record.keyId, record.model, upstream, record.modelKey, record.hour, selector, row.metric, row.quantity, row.unitPrice)),
    ];
    statements.push(this.db.prepare(
      `INSERT INTO usage_requests (key_id, model, upstream, model_key, hour, pricing_selector, requests) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET requests = excluded.requests`,
    ).bind(record.keyId, record.model, upstream, record.modelKey, record.hour, selector, record.requests));
    await runStatements(this.db, statements);
  }

  async deleteAll(): Promise<void> {
    await runStatements(this.db, [this.db.prepare('DELETE FROM usage'), this.db.prepare('DELETE FROM usage_requests')]);
  }
}

interface UsageMetricRow {
  key_id: string; model: string; upstream: string | null; model_key: string; hour: string;
  pricing_selector: string; metric: string; quantity: string; unit_price: string | null;
}
interface UsageRequestRow {
  key_id: string; model: string; upstream: string | null; model_key: string; hour: string;
  pricing_selector: string; requests: number;
}

type UsageIdentityRow = Pick<UsageMetricRow, 'key_id' | 'model' | 'upstream' | 'model_key' | 'hour' | 'pricing_selector'>;
const usageBucketKey = (row: UsageIdentityRow): string =>
  [row.key_id, row.model, row.upstream ?? '', row.model_key, row.hour, row.pricing_selector].join('\0');

const assembleUsageRecords = (metrics: readonly UsageMetricRow[], requests: readonly UsageRequestRow[]): UsageRecord[] => {
  const byBucket = new Map<string, UsageRecord>();
  const ensureRecord = (row: UsageIdentityRow): UsageRecord => {
    const key = usageBucketKey(row);
    let record = byBucket.get(key);
    if (!record) {
      record = { keyId: row.key_id, model: row.model, upstream: row.upstream, modelKey: row.model_key, hour: row.hour, pricingSelector: parsePricingSelectorKey(row.pricing_selector), requests: 0, metrics: [] };
      byBucket.set(key, record);
    }
    return record;
  };
  for (const row of metrics) {
    const record = ensureRecord(row);
    const metric = parseBillingMetric(row.metric, 'usage.metric');
    const quantity = parseNonNegativeDecimalString(row.quantity, `usage metric ${metric} quantity`);
    const unitPrice = row.unit_price === null ? null : parseNonNegativeDecimalString(row.unit_price, `usage metric ${metric} unit price`);
    if (quantity !== row.quantity) throw new TypeError(`Stored usage metric ${metric} quantity must be canonical: ${JSON.stringify(row.quantity)}`);
    if (unitPrice !== row.unit_price) throw new TypeError(`Stored usage metric ${metric} unit price must be canonical: ${JSON.stringify(row.unit_price)}`);
    const existing = record.metrics.find(candidate => candidate.metric === metric);
    if (existing) throw new Error(`Duplicate stored usage metric: ${metric}`);
    record.metrics.push({ metric, quantity, unitPrice });
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

type PerformanceDimensionRow = {
  hour: string;
  key_id: string;
  model: string;
  upstream: string;
  operation: string;
  runtime_location: string;
};

const performanceDimensionsFromRow = (row: PerformanceDimensionRow): PerformanceDimensions => ({
  hour: row.hour,
  keyId: row.key_id,
  model: row.model,
  upstream: row.upstream,
  operation: row.operation as PerformanceOperation,
  runtimeLocation: row.runtime_location,
});

const performanceRecordKey = (dims: PerformanceDimensions): string =>
  `${dims.hour}\0${dims.keyId}\0${dims.model}\0${dims.upstream}\0${dims.operation}\0${dims.runtimeLocation}`;

const performanceDimensionBinds = (dims: PerformanceDimensions): unknown[] =>
  [dims.hour, dims.keyId, dims.model, dims.upstream, dims.operation, dims.runtimeLocation];

const PERFORMANCE_SUMMARY_COUNT_COLUMNS = ['requests', 'ttft_samples_ok', 'errors_with_output', 'errors_no_output', 'neutral', 'tpot_samples', 'ttft_ms_sum', 'tpot_us_sum'] as const;
type PerformanceSummaryCountColumn = typeof PERFORMANCE_SUMMARY_COUNT_COLUMNS[number];

const buildPerformanceSummarySql = (mode: 'add' | 'set'): string => {
  const dimensionColumns = ['hour', 'key_id', 'model', 'upstream', 'operation', 'runtime_location'] as const;
  const allColumns = [...dimensionColumns, ...PERFORMANCE_SUMMARY_COUNT_COLUMNS];
  const placeholders = allColumns.map(() => '?').join(', ');
  const conflictKey = dimensionColumns.join(', ');
  const updates = PERFORMANCE_SUMMARY_COUNT_COLUMNS
    .map(col => (mode === 'add' ? `${col} = ${col} + excluded.${col}` : `${col} = excluded.${col}`))
    .join(', ');
  return `INSERT INTO performance_summary (${allColumns.join(', ')}) VALUES (${placeholders})
          ON CONFLICT (${conflictKey}) DO UPDATE SET ${updates}`;
};

const PERFORMANCE_SUMMARY_ADD_SQL = buildPerformanceSummarySql('add');
const PERFORMANCE_SUMMARY_SET_SQL = buildPerformanceSummarySql('set');

class SqlPerformanceRepo implements PerformanceRepo {
  constructor(private readonly db: SqlDatabase) {}

  async recordSample(sample: PerformanceSample): Promise<void> {
    const summaryStmt = this.upsertSummary(sample, {
      requests: 1,
      ttft_samples_ok: sample.success ? 1 : 0,
      errors_with_output: sample.success ? 0 : 1,
      errors_no_output: 0,
      neutral: 0,
      tpot_samples: sample.tpotUs === undefined ? 0 : 1,
      ttft_ms_sum: sample.ttftMs,
      tpot_us_sum: sample.tpotUs ?? 0,
    }, 'add');
    const stmts: SqlPreparedStatement[] = [summaryStmt, this.buildBucketStmt(sample, 'ttft_ms', bucketForTtftMs(sample.ttftMs))];
    if (sample.tpotUs !== undefined) stmts.push(this.buildBucketStmt(sample, 'tpot_us', bucketForTpotUs(sample.tpotUs)));
    await runStatements(this.db, stmts);
  }

  async recordZeroOutputError(dims: PerformanceDimensions): Promise<void> {
    await this.upsertSummary(dims, { requests: 1, errors_no_output: 1 }, 'add').run();
  }

  async recordNeutral(dims: PerformanceDimensions): Promise<void> {
    await this.upsertSummary(dims, { requests: 1, neutral: 1 }, 'add').run();
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<PerformanceTelemetryRecord[]> {
    return await this.rowsFor(opts);
  }

  async listAll(): Promise<PerformanceTelemetryRecord[]> {
    return await this.rowsFor({});
  }

  async set(record: PerformanceTelemetryRecord): Promise<void> {
    const summaryStmt = this.upsertSummary(record, {
      requests: record.requests,
      ttft_samples_ok: record.ttftSamplesOk,
      errors_with_output: record.errorsWithOutput,
      errors_no_output: record.errorsNoOutput,
      neutral: record.neutral,
      tpot_samples: record.tpotSamples,
      ttft_ms_sum: record.ttftMsSum,
      tpot_us_sum: record.tpotUsSum,
    }, 'set');

    const deleteStmt = this.db.prepare(
      'DELETE FROM performance_buckets WHERE hour = ? AND key_id = ? AND model = ? AND upstream = ? AND operation = ? AND runtime_location = ?',
    ).bind(...performanceDimensionBinds(record));

    const bucketStmts = record.buckets.map(bucket => this.db.prepare(
      `INSERT INTO performance_buckets (hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(...performanceDimensionBinds(record), bucket.metric, bucket.lower, bucket.upper, bucket.count));

    await runStatements(this.db, [summaryStmt, deleteStmt, ...bucketStmts]);
  }

  // 'add' takes a partial map because missing columns are a no-op increment.
  // 'set' rewrites the row wholesale, so a missing column would zero the
  // existing value — the overload forces callers to spell out every count.
  private upsertSummary(dims: PerformanceDimensions, counts: Partial<Record<PerformanceSummaryCountColumn, number>>, mode: 'add'): SqlPreparedStatement;
  private upsertSummary(dims: PerformanceDimensions, counts: Record<PerformanceSummaryCountColumn, number>, mode: 'set'): SqlPreparedStatement;
  private upsertSummary(
    dims: PerformanceDimensions,
    counts: Partial<Record<PerformanceSummaryCountColumn, number>>,
    mode: 'add' | 'set',
  ): SqlPreparedStatement {
    const sql = mode === 'add' ? PERFORMANCE_SUMMARY_ADD_SQL : PERFORMANCE_SUMMARY_SET_SQL;
    const countBinds = PERFORMANCE_SUMMARY_COUNT_COLUMNS.map(col => {
      const value = counts[col];
      if (value === undefined) {
        if (mode === 'set') throw new Error(`upsertSummary('set'): missing count column ${col}`);
        return 0;
      }
      return value;
    });
    return this.db.prepare(sql).bind(...performanceDimensionBinds(dims), ...countBinds);
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM performance_buckets').run();
    await this.db.prepare('DELETE FROM performance_summary').run();
  }

  private buildBucketStmt(dims: PerformanceDimensions, metric: PerformanceMetric, edges: { lower: number; upper: number | null }): SqlPreparedStatement {
    return this.db.prepare(
      `INSERT INTO performance_buckets (hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (hour, key_id, model, upstream, operation, runtime_location, metric, lower) DO UPDATE SET
         count = count + 1`,
    ).bind(...performanceDimensionBinds(dims), metric, edges.lower, edges.upper);
  }

  private async rowsFor(opts: { keyId?: string; start?: string; end?: string }): Promise<PerformanceTelemetryRecord[]> {
    const clauses: string[] = [];
    const binds: unknown[] = [];
    if (opts.start !== undefined) {
      clauses.push('hour >= ?');
      binds.push(opts.start);
    }
    if (opts.end !== undefined) {
      clauses.push('hour < ?');
      binds.push(opts.end);
    }
    if (opts.keyId !== undefined) {
      clauses.push('key_id = ?');
      binds.push(opts.keyId);
    }
    const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';

    const { results: summaryRows } = await this.db.prepare(
      `SELECT hour, key_id, model, upstream, operation, runtime_location, requests, ttft_samples_ok, errors_with_output, errors_no_output, neutral, tpot_samples, ttft_ms_sum, tpot_us_sum
       FROM performance_summary${whereClause} ORDER BY hour`,
    ).bind(...binds).all<PerformanceDimensionRow & { requests: number; ttft_samples_ok: number; errors_with_output: number; errors_no_output: number; neutral: number; tpot_samples: number; ttft_ms_sum: number; tpot_us_sum: number }>();

    const records = new Map<string, Omit<PerformanceTelemetryRecord, 'buckets'> & { buckets: PerformanceBucketRow[] }>();
    for (const row of summaryRows) {
      const dims = performanceDimensionsFromRow(row);
      records.set(performanceRecordKey(dims), {
        ...dims,
        requests: row.requests,
        ttftSamplesOk: row.ttft_samples_ok,
        errorsWithOutput: row.errors_with_output,
        errorsNoOutput: row.errors_no_output,
        neutral: row.neutral,
        tpotSamples: row.tpot_samples,
        ttftMsSum: row.ttft_ms_sum,
        tpotUsSum: row.tpot_us_sum,
        buckets: [],
      });
    }

    const { results: bucketRows } = await this.db.prepare(
      `SELECT hour, key_id, model, upstream, operation, runtime_location, metric, lower, upper, count
       FROM performance_buckets${whereClause} ORDER BY hour, metric, lower`,
    ).bind(...binds).all<PerformanceDimensionRow & { metric: PerformanceMetric; lower: number; upper: number | null; count: number }>();
    for (const row of bucketRows) {
      const dims = performanceDimensionsFromRow(row);
      const key = performanceRecordKey(dims);
      const record = records.get(key);
      // Every write path inserts the summary + buckets atomically, so a bucket
      // row without its summary is a DB invariant violation, not a domain case.
      if (!record) throw new Error(`performance_buckets row has no matching summary for key ${key}`);
      record.buckets.push({ metric: row.metric, lower: row.lower, upper: row.upper, count: row.count });
    }

    return [...records.values()];
  }
}

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
      .prepare('SELECT revision, fetched_at, models_json, last_error_json FROM models_cache WHERE upstream_id = ?')
      .bind(upstreamId)
      .first<{ revision: number; fetched_at: number; models_json: string; last_error_json: string | null }>();
    if (!row) return null;
    return {
      revision: row.revision,
      fetchedAt: row.fetched_at,
      models: JSON.parse(row.models_json, modelsReviver) as ProviderModel[],
      lastError: row.last_error_json ? JSON.parse(row.last_error_json) as { message: string; at: number } : null,
    };
  }

  async put(upstreamId: string, row: { revision: number; fetchedAt: number; models: ProviderModel[] }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO models_cache (upstream_id, revision, fetched_at, models_json, last_error_json) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (upstream_id) DO UPDATE SET
           revision = excluded.revision,
           fetched_at = excluded.fetched_at,
           models_json = excluded.models_json,
           last_error_json = NULL`,
      )
      .bind(upstreamId, row.revision, row.fetchedAt, JSON.stringify(row.models, modelsReplacer))
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

const RESPONSES_ITEM_COLUMNS = 'id, api_key_id, upstream_id, upstream_item_id, item_type, payload_json, content_hash, created_at';
// D1 permits 100 bound parameters per query. Descriptor reads reserve one
// bind for api_key_id; inserts use eight binds per item; refresh CASE updates
// use four per item plus created_at and api_key_id.
// https://developers.cloudflare.com/d1/platform/limits/#limits
const RESPONSES_IN_QUERY_CHUNK_SIZE = 90;
const RESPONSES_INSERT_CHUNK_SIZE = 12;
const RESPONSES_REFRESH_CHUNK_SIZE = 24;

interface ResponsesItemDescriptor {
  id: string;
  payloadJson: string;
  createdAt: number;
}

interface ResponsesItemDescriptorRow {
  id: string;
  api_key_id: string;
  payload_json: string;
  created_at: number;
}

interface PreparedResponsesPayloadWriteBase {
  item: StoredResponsesItem;
  payload: string;
  generatedFileKey: string | null;
}

interface PreparedResponsesInsertWrite extends PreparedResponsesPayloadWriteBase {
  kind: 'insert';
}

interface PreparedResponsesRefreshWrite extends PreparedResponsesPayloadWriteBase {
  kind: 'refresh';
  previousPayloadJson: string;
  previousFileKey: string | null;
}

type PreparedResponsesPayloadWrite = PreparedResponsesInsertWrite | PreparedResponsesRefreshWrite;

const uniqueResponsesItems = (items: readonly StoredResponsesItem[]): StoredResponsesItem[] => {
  const unique = new Map<string, StoredResponsesItem>();
  for (const item of items) {
    const key = scopedResponsesKey(item.apiKeyId, item.id);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
};

const responsesErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

class SqlResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private db: SqlDatabase) {}

  async lookupMany(apiKeyId: string, ids: readonly string[]): Promise<StoredResponsesItem[]> {
    const rows = await this.lookupByColumn(apiKeyId, 'id', ids);
    const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async lookupManyByContentHash(apiKeyId: string, hashes: readonly string[]): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'content_hash', hashes);
  }

  // A single Responses request can echo back more stored items than one
  // IN-list can hold, so chunk the list and union the results.
  private async lookupByColumn(apiKeyId: string, column: 'id' | 'content_hash', values: readonly string[]): Promise<StoredResponsesItem[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += RESPONSES_IN_QUERY_CHUNK_SIZE) {
      chunks.push(unique.slice(i, i + RESPONSES_IN_QUERY_CHUNK_SIZE));
    }

    const perChunk = await Promise.all(chunks.map(async chunk => {
      const placeholders = chunk.map(() => '?').join(', ');
      const orderSql = column === 'id' ? '' : ' ORDER BY created_at DESC, id ASC';
      const { results } = await this.db
        .prepare(`SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items WHERE api_key_id = ? AND ${column} IN (${placeholders})${orderSql}`)
        .bind(apiKeyId, ...chunk)
        .all<ResponsesItemRow>();
      return results;
    }));
    // Payload codecs retain compressed bytes, expanded JSON, and the parsed
    // clone together. Keep D1 reads parallel, then hydrate serially so one
    // lookup cannot multiply that working set beyond Workers' memory limit.
    // https://developers.cloudflare.com/workers/platform/limits/#memory
    return await mapSequentially(perChunk.flat(), toStoredResponsesItem);
  }

  async insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    const unique = uniqueResponsesItems(items);
    const existing = await this.lookupDescriptors(unique);
    const pending = unique.filter(item => !existing.has(scopedResponsesKey(item.apiKeyId, item.id)));
    const writes: PreparedResponsesInsertWrite[] = [];
    try {
      for (const item of pending) {
        const payload = await serializeStoredResponsesPayload(item.id, item.apiKeyId, item.createdAt, item.payload);
        writes.push({
          kind: 'insert',
          item,
          payload,
          generatedFileKey: storedResponsesPayloadFileKey(item.id, payload),
        });
      }
    } catch (error) {
      await this.finishPayloadWrites(writes, error);
    }

    const statements: SqlPreparedStatement[] = [];
    for (let index = 0; index < writes.length; index += RESPONSES_INSERT_CHUNK_SIZE) {
      const chunk = writes.slice(index, index + RESPONSES_INSERT_CHUNK_SIZE);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(this.db
        .prepare(
          `INSERT INTO responses_items (${RESPONSES_ITEM_COLUMNS}) VALUES ${values}
           ON CONFLICT (id, api_key_id) DO NOTHING`,
        )
        .bind(...chunk.flatMap(({ item, payload }) => [
          item.id,
          item.apiKeyId,
          item.upstreamId,
          item.upstreamItemId,
          item.itemType,
          payload,
          item.contentHash,
          item.createdAt,
        ])));
    }
    try {
      await runStatements(this.db, statements);
    } catch (error) {
      await this.finishPayloadWrites(writes, error);
    }
    await this.finishPayloadWrites(writes, null);
  }

  async refreshMany(items: readonly StoredResponsesItem[], createdAt: number): Promise<void> {
    const unique = uniqueResponsesItems(items);
    const previous = await this.lookupDescriptors(unique);
    const missingBeforeWrite = unique.find(item => !previous.has(scopedResponsesKey(item.apiKeyId, item.id)));
    if (missingBeforeWrite !== undefined) {
      throw new Error(`Responses item disappeared before lifetime refresh: ${missingBeforeWrite.id}`);
    }

    const pending = unique.filter(item => previous.get(scopedResponsesKey(item.apiKeyId, item.id))!.createdAt < createdAt);
    if (pending.length === 0) return;
    const targetFilePrefix = responsesItemPayloadExpiryBucketPrefix(createdAt + RESPONSES_STATE_TTL_MS);
    const writes: PreparedResponsesRefreshWrite[] = [];
    try {
      for (const item of pending) {
        const descriptor = previous.get(scopedResponsesKey(item.apiKeyId, item.id))!;
        const previousFileKey = storedResponsesPayloadFileKey(item.id, descriptor.payloadJson);
        const moveFile = previousFileKey !== null && !previousFileKey.startsWith(targetFilePrefix);
        const payload = moveFile
          ? await serializeStoredResponsesPayload(item.id, item.apiKeyId, createdAt, item.payload)
          : descriptor.payloadJson;
        writes.push({
          kind: 'refresh',
          item,
          payload,
          generatedFileKey: moveFile ? storedResponsesPayloadFileKey(item.id, payload) : null,
          previousPayloadJson: descriptor.payloadJson,
          previousFileKey,
        });
      }
    } catch (error) {
      await this.finishPayloadWrites(writes, error);
    }

    const writesByApiKey = new Map<string, PreparedResponsesRefreshWrite[]>();
    for (const write of writes) {
      const group = writesByApiKey.get(write.item.apiKeyId) ?? [];
      group.push(write);
      writesByApiKey.set(write.item.apiKeyId, group);
    }
    const statements: SqlPreparedStatement[] = [];
    for (const [apiKeyId, group] of writesByApiKey) {
      for (let index = 0; index < group.length; index += RESPONSES_REFRESH_CHUNK_SIZE) {
        const chunk = group.slice(index, index + RESPONSES_REFRESH_CHUNK_SIZE);
        const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
        const conditions = chunk.map(() => '(id = ? AND payload_json = ?)').join(' OR ');
        statements.push(this.db
          .prepare(
            `UPDATE responses_items
             SET payload_json = CASE id ${cases} ELSE payload_json END,
                 created_at = MAX(created_at, ?)
             WHERE api_key_id = ? AND (${conditions})`,
          )
          .bind(
            ...chunk.flatMap(({ item, payload }) => [item.id, payload]),
            createdAt,
            apiKeyId,
            ...chunk.flatMap(({ item, previousPayloadJson }) => [item.id, previousPayloadJson]),
          ));
      }
    }
    try {
      await runStatements(this.db, statements);
    } catch (error) {
      await this.finishPayloadWrites(writes, error);
    }
    const persisted = await this.finishPayloadWrites(writes, null);
    const staleItems = writes.flatMap(write => {
      const descriptor = persisted.get(scopedResponsesKey(write.item.apiKeyId, write.item.id));
      return descriptor !== undefined && descriptor.createdAt < createdAt ? [write.item] : [];
    });
    if (staleItems.length > 0) await this.refreshMany(staleItems, createdAt);
  }

  private async lookupDescriptors(items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[]): Promise<Map<string, ResponsesItemDescriptor>> {
    const idsByApiKey = new Map<string, Set<string>>();
    for (const item of items) {
      const ids = idsByApiKey.get(item.apiKeyId) ?? new Set<string>();
      ids.add(item.id);
      idsByApiKey.set(item.apiKeyId, ids);
    }

    const queries: Promise<SqlResult<ResponsesItemDescriptorRow>>[] = [];
    for (const [apiKeyId, idSet] of idsByApiKey) {
      const ids = [...idSet];
      for (let index = 0; index < ids.length; index += RESPONSES_IN_QUERY_CHUNK_SIZE) {
        const chunk = ids.slice(index, index + RESPONSES_IN_QUERY_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        queries.push(this.db
          .prepare(`SELECT id, api_key_id, payload_json, created_at FROM responses_items WHERE api_key_id = ? AND id IN (${placeholders})`)
          .bind(apiKeyId, ...chunk)
          .all<ResponsesItemDescriptorRow>());
      }
    }
    const results = await Promise.all(queries);
    return new Map(results.flatMap(result => result.results.map(row => {
      const descriptor: ResponsesItemDescriptor = {
        id: row.id,
        payloadJson: row.payload_json,
        createdAt: row.created_at,
      };
      return [scopedResponsesKey(row.api_key_id, row.id), descriptor] as const;
    })));
  }

  private async finishPayloadWrites(
    writes: readonly PreparedResponsesPayloadWrite[],
    failure: unknown | null,
  ): Promise<Map<string, ResponsesItemDescriptor>> {
    let persisted: Map<string, ResponsesItemDescriptor>;
    try {
      persisted = await this.lookupDescriptors(writes.map(write => write.item));
    } catch (cleanupError) {
      if (failure === null) throw cleanupError;
      throw new AggregateError([failure, cleanupError], `${responsesErrorMessage(failure)}; Responses payload reconciliation failed`);
    }

    const retainedFileKeys = new Set<string>();
    const cleanupErrors: unknown[] = [];
    try {
      for (const descriptor of persisted.values()) {
        const fileKey = storedResponsesPayloadFileKey(descriptor.id, descriptor.payloadJson);
        if (fileKey !== null) retainedFileKeys.add(fileKey);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }

    if (cleanupErrors.length === 0) {
      const obsoleteFileKeys = new Set<string>();
      for (const write of writes) {
        const descriptor = persisted.get(scopedResponsesKey(write.item.apiKeyId, write.item.id));
        if (write.generatedFileKey !== null && !retainedFileKeys.has(write.generatedFileKey)) {
          obsoleteFileKeys.add(write.generatedFileKey);
        }
        if (
          write.kind === 'refresh'
          && descriptor !== undefined
          && write.previousFileKey !== null
          && !retainedFileKeys.has(write.previousFileKey)
        ) {
          obsoleteFileKeys.add(write.previousFileKey);
        }
      }
      const cleanupResults = await Promise.allSettled(
        [...obsoleteFileKeys].map(async key => await getFileProvider().deletePrefix(key)),
      );
      for (const result of cleanupResults) {
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
      }
    }

    const missing = writes.find(write => !persisted.has(scopedResponsesKey(write.item.apiKeyId, write.item.id)));
    const missingError = missing === undefined
      ? null
      : new Error(missing.kind === 'insert'
          ? `Responses item conflict disappeared before spill cleanup: ${missing.item.id}`
          : `Responses item disappeared before lifetime refresh: ${missing.item.id}`);
    const operationError = failure ?? missingError;
    if (cleanupErrors.length > 0) {
      if (operationError === null) throw new AggregateError(cleanupErrors, 'Responses payload cleanup failed');
      throw new AggregateError(
        [operationError, ...cleanupErrors],
        `${responsesErrorMessage(operationError)}; Responses payload cleanup failed`,
      );
    }
    if (operationError !== null) throw operationError;
    return persisted;
  }

  async deleteOlderThan(createdBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_items WHERE created_at < ?').bind(createdBefore).run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_items').run();
    await deleteAllResponsesItemPayloadFiles();
  }
}

interface ResponsesItemRow {
  id: string;
  api_key_id: string;
  upstream_id: string | null;
  upstream_item_id: string | null;
  item_type: string;
  payload_json: string;
  content_hash: string | null;
  created_at: number;
}

const toStoredResponsesItem = async (row: ResponsesItemRow): Promise<StoredResponsesItem> => ({
  id: row.id,
  apiKeyId: row.api_key_id,
  upstreamId: row.upstream_id,
  upstreamItemId: row.upstream_item_id,
  itemType: row.item_type,
  payload: await parseStoredResponsesPayload(row.id, row.payload_json),
  contentHash: row.content_hash,
  createdAt: row.created_at,
});

class SqlResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  constructor(private db: SqlDatabase) {}

  async lookup(apiKeyId: string, id: string): Promise<StoredResponsesSnapshot | null> {
    const row = await this.db
      .prepare('SELECT id, api_key_id, item_ids_json, created_at FROM responses_snapshots WHERE id = ? AND api_key_id = ?')
      .bind(id, apiKeyId)
      .first<ResponsesSnapshotRow>();
    return row ? toStoredResponsesSnapshot(row) : null;
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id, api_key_id) DO UPDATE SET
           item_ids_json = CASE
             WHEN excluded.created_at >= responses_snapshots.created_at THEN excluded.item_ids_json
             ELSE responses_snapshots.item_ids_json
           END,
           created_at = MAX(responses_snapshots.created_at, excluded.created_at)`,
      )
      .bind(snapshot.id, snapshot.apiKeyId, JSON.stringify(snapshot.itemIds), snapshot.createdAt)
      .run();
  }

  async deleteOlderThan(createdBefore: number): Promise<number> {
    const result = await this.db.prepare('DELETE FROM responses_snapshots WHERE created_at < ?').bind(createdBefore).run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_snapshots').run();
  }
}

interface ResponsesSnapshotRow {
  id: string;
  api_key_id: string;
  item_ids_json: string;
  created_at: number;
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
  };
};

class SqlSearchConfigRepo implements SearchConfigRepo {
  constructor(private db: SqlDatabase) {}

  async get(): Promise<unknown | null> {
    const row = await this.db
      .prepare('SELECT provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model FROM search_config WHERE id = 1')
      .first<{ provider: string; tavily_api_key: string; microsoft_grounding_api_key: string; jina_api_key: string; passthrough_openai_search: number; alpha_search_upstream_id: string; alpha_search_model: string }>();
    if (!row) throw new Error('search_config singleton row missing');
    return {
      provider: row.provider,
      tavily: { apiKey: row.tavily_api_key },
      microsoftGrounding: { apiKey: row.microsoft_grounding_api_key },
      jina: { apiKey: row.jina_api_key },
      passthroughOpenAiSearch: {
        enabled: row.passthrough_openai_search === 1,
        upstreamId: row.alpha_search_upstream_id,
        model: row.alpha_search_model,
      },
    };
  }

  async save(config: SearchConfig): Promise<void> {
    const { provider, tavily, microsoftGrounding, jina, passthroughOpenAiSearch } = config;
    await this.db
      .prepare(
        `INSERT INTO search_config (id, provider, tavily_api_key, microsoft_grounding_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           tavily_api_key = excluded.tavily_api_key,
           microsoft_grounding_api_key = excluded.microsoft_grounding_api_key,
           jina_api_key = excluded.jina_api_key,
           passthrough_openai_search = excluded.passthrough_openai_search,
           alpha_search_upstream_id = excluded.alpha_search_upstream_id,
           alpha_search_model = excluded.alpha_search_model,
           updated_at = excluded.updated_at`,
      )
      .bind(provider, tavily.apiKey, microsoftGrounding.apiKey, jina.apiKey, passthroughOpenAiSearch.enabled ? 1 : 0, passthroughOpenAiSearch.upstreamId, passthroughOpenAiSearch.model)
      .run();
  }
}

class SqlUpstreamRepo implements UpstreamRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<UpstreamRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, color FROM upstreams ORDER BY sort_order, created_at')
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, color FROM upstreams WHERE id = ?')
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    // created_at is deliberately not in the ON CONFLICT update list: the row's first INSERT
    // wins, and re-saves preserve that timestamp regardless of what the caller passes.
    await this.db
      .prepare(
        `INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           model_prefix_json = excluded.model_prefix_json,
           color = excluded.color`,
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
        upstream.color,
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
  color: string | null;
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
    kind: parseUpstreamKind(row.id, row.provider),
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
    color: parseUpstreamColor(row.id, row.color),
  };
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

interface ModelAliasRow {
  name: string;
  kind: string;
  selection: string;
  display_name: string | null;
  visible_in_models_list: number;
  targets: string;
  announced_metadata_json: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

const MODEL_ALIAS_COLUMNS = 'name, kind, selection, display_name, visible_in_models_list, targets, announced_metadata_json, sort_order, created_at, updated_at';

const parseAliasTargets = (raw: string, name: string): AliasTarget[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`model_aliases.targets JSON is malformed for ${name}`, { cause });
  }
  if (!Array.isArray(parsed)) throw new Error(`model_aliases.targets is not an array for ${name}`);
  return parsed as AliasTarget[];
};

const parseAnnouncedMetadata = (raw: string | null, name: string): AnnouncedMetadata | null => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as AnnouncedMetadata;
  } catch (cause) {
    throw new Error(`model_aliases.announced_metadata_json is malformed for ${name}`, { cause });
  }
};

const toModelAliasRecord = (row: ModelAliasRow): ModelAliasRecord => ({
  name: row.name,
  kind: row.kind as ModelKind,
  selection: row.selection as AliasSelection,
  displayName: row.display_name,
  visibleInModelsList: row.visible_in_models_list !== 0,
  targets: parseAliasTargets(row.targets, row.name),
  announcedMetadata: parseAnnouncedMetadata(row.announced_metadata_json, row.name),
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const announcedMetadataBind = (value: AnnouncedMetadata | null): string | null =>
  value === null ? null : JSON.stringify(value);

class SqlModelAliasesRepo implements ModelAliasesRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<ModelAliasRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${MODEL_ALIAS_COLUMNS} FROM model_aliases ORDER BY sort_order, created_at`)
      .all<ModelAliasRow>();
    return results.map(toModelAliasRecord);
  }

  async getByName(name: string): Promise<ModelAliasRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${MODEL_ALIAS_COLUMNS} FROM model_aliases WHERE name = ?`)
      .bind(name)
      .first<ModelAliasRow>();
    return row ? toModelAliasRecord(row) : null;
  }

  async insert(record: ModelAliasRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO model_aliases (${MODEL_ALIAS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.name,
        record.kind,
        record.selection,
        record.displayName,
        record.visibleInModelsList ? 1 : 0,
        JSON.stringify(record.targets),
        announcedMetadataBind(record.announcedMetadata),
        record.sortOrder,
        record.createdAt,
        record.updatedAt,
      )
      .run();
  }

  async update(oldName: string, record: ModelAliasRecord): Promise<void> {
    if (oldName === record.name) {
      const result = await this.db
        .prepare(
          `UPDATE model_aliases SET
             kind = ?,
             selection = ?,
             display_name = ?,
             visible_in_models_list = ?,
             targets = ?,
             announced_metadata_json = ?,
             sort_order = ?,
             created_at = ?,
             updated_at = ?
           WHERE name = ?`,
        )
        .bind(
          record.kind,
          record.selection,
          record.displayName,
          record.visibleInModelsList ? 1 : 0,
          JSON.stringify(record.targets),
          announcedMetadataBind(record.announcedMetadata),
          record.sortOrder,
          record.createdAt,
          record.updatedAt,
          oldName,
        )
        .run();
      if ((result.meta.changes ?? 0) === 0) throw new Error(`alias ${oldName} not found`);
      return;
    }

    // Rename. Verify the source row exists first, then INSERT(new) +
    // DELETE(old) atomically through the batch primitive — a PK collision
    // against `record.name` bubbles up from the INSERT, which the route
    // layer translates to 409.
    const existing = await this.getByName(oldName);
    if (!existing) throw new Error(`alias ${oldName} not found`);

    await runStatements(this.db, [
      this.db
        .prepare(`INSERT INTO model_aliases (${MODEL_ALIAS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          record.name,
          record.kind,
          record.selection,
          record.displayName,
          record.visibleInModelsList ? 1 : 0,
          JSON.stringify(record.targets),
          announcedMetadataBind(record.announcedMetadata),
          record.sortOrder,
          record.createdAt,
          record.updatedAt,
        ),
      this.db.prepare('DELETE FROM model_aliases WHERE name = ?').bind(oldName),
    ]);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM model_aliases WHERE name = ?')
      .bind(name)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM model_aliases').run();
  }
}

interface AgentSetupRow {
  token: string;
  user_id: number;
  configuration_json: string;
  configuration_revision: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

const AGENT_SETUP_COLUMNS = 'token, user_id, configuration_json, configuration_revision, expires_at, created_at, updated_at';
const AGENT_SETUP_LATEST_ORDER = 'updated_at DESC, created_at DESC, token DESC';

const toAgentSetupRecord = (row: AgentSetupRow): AgentSetupRecord => ({
  token: row.token,
  userId: row.user_id,
  configurationJson: row.configuration_json,
  configurationRevision: row.configuration_revision,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// The token PK's SQLite/D1 uniqueness message. Matching it lets the route retry
// with a fresh token; any unrelated failure propagates untouched.
const TOKEN_COLLISION_MESSAGE = /UNIQUE constraint failed: agent_setup\.token/i;

class SqlAgentSetupRepo implements AgentSetupRepository {
  constructor(private db: SqlDatabase) {}

  async findByToken(token: string): Promise<AgentSetupRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${AGENT_SETUP_COLUMNS} FROM agent_setup WHERE token = ?`)
      .bind(token)
      .first<AgentSetupRow>();
    return row ? toAgentSetupRecord(row) : null;
  }

  async latestByUserId(userId: number): Promise<AgentSetupRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${AGENT_SETUP_COLUMNS} FROM agent_setup WHERE user_id = ? ORDER BY ${AGENT_SETUP_LATEST_ORDER} LIMIT 1`)
      .bind(userId)
      .first<AgentSetupRow>();
    return row ? toAgentSetupRecord(row) : null;
  }

  async insertForUser(input: {
    userId: number;
    token: string;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupRecord> {
    // A token PK collision is surfaced as a typed error so acquisition can retry.
    try {
      const row = await this.db
        .prepare(
          `INSERT INTO agent_setup (${AGENT_SETUP_COLUMNS})
           VALUES (?, ?, ?, 1, ?, ?, ?)
           RETURNING ${AGENT_SETUP_COLUMNS}`,
        )
        .bind(input.token, input.userId, input.configurationJson, input.expiresAt, input.now, input.now)
        .first<AgentSetupRow>();
      if (!row) throw new Error('insertForUser: insert returned no rows');
      return toAgentSetupRecord(row);
    } catch (error) {
      if (error instanceof Error && TOKEN_COLLISION_MESSAGE.test(error.message)) throw new AgentSetupTokenCollisionError();
      throw error;
    }
  }

  async updateConfiguration(input: {
    userId: number;
    token: string;
    expectedRevision: number;
    configurationJson: string;
    now: number;
    expiresAt: number;
  }): Promise<AgentSetupMutation> {
    // Single-statement CAS on (user_id, token, revision). The token never
    // changes; a stale revision fails the WHERE so nothing is written.
    const row = await this.db
      .prepare(
        `UPDATE agent_setup SET
           configuration_json = ?,
           configuration_revision = configuration_revision + 1,
           expires_at = ?,
           updated_at = ?
         WHERE user_id = ? AND token = ? AND configuration_revision = ?
         RETURNING ${AGENT_SETUP_COLUMNS}`,
      )
      .bind(input.configurationJson, input.expiresAt, input.now, input.userId, input.token, input.expectedRevision)
      .first<AgentSetupRow>();
    if (row) return { status: 'ok', record: toAgentSetupRecord(row) };
    // The CAS matched nothing; read the live row to classify the rejection: a
    // missing (or foreign) token is terminal, otherwise the revision was stale.
    const current = await this.findByToken(input.token);
    if (!current || current.userId !== input.userId) return { status: 'missing' };
    return { status: 'revision-conflict', record: current };
  }

  async renewLease(input: {
    userId: number;
    token: string;
    expiresAt: number;
  }): Promise<AgentSetupRenewal> {
    // Expiry-only: updated_at and the revision are left untouched so a heartbeat
    // neither reorders the restore selection nor collides with an edit.
    const row = await this.db
      .prepare(
        `UPDATE agent_setup SET expires_at = ?
         WHERE user_id = ? AND token = ?
         RETURNING ${AGENT_SETUP_COLUMNS}`,
      )
      .bind(input.expiresAt, input.userId, input.token)
      .first<AgentSetupRow>();
    return row ? { status: 'ok', record: toAgentSetupRecord(row) } : { status: 'missing' };
  }
}

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
  modelAliases: ModelAliasesRepo;
  responsesItems: ResponsesItemsRepo;
  responsesSnapshots: ResponsesSnapshotsRepo;
  agentSetup: AgentSetupRepository;

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
    this.modelAliases = new SqlModelAliasesRepo(db);
    this.responsesItems = new SqlResponsesItemsRepo(db);
    this.responsesSnapshots = new SqlResponsesSnapshotsRepo(db);
    this.agentSetup = new SqlAgentSetupRepo(db);
  }
}
