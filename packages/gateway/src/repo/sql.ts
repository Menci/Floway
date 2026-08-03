import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { SqlExpirationSweepsRepo } from './expiration-sweeps-sql.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { SqlResponsesItemsRepo, SqlResponsesSnapshotsRepo } from './responses-state-sql.ts';
import { generateSessionToken } from './session-tokens.ts';
import { SqlSpilledFilesRepo } from './spilled-files-sql.ts';
import { runStatements } from './sql-batch.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  ApiKeyUpdate,
  ExpirationSweepsRepo,
  AgentSetupMutation,
  AgentSetupRecord,
  AgentSetupRenewal,
  AgentSetupRepository,
  BackoffRow,
  ModelAliasesRepo,
  ModelAliasRecord,
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
  SpilledFilesRepo,
  WebSearchConfigRepo,
  WebSearchUsageRecord,
  WebSearchUsageRepo,
  Session,
  SessionsRepo,
  UpstreamRepo,
  UsageRecord,
  UsageRepo,
  User,
  UsersRepo,
} from './types.ts';
import { serializeStoredConfig, serializeStoredState } from './upstream-json.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import { usageMetricRows } from './usage-metrics.ts';
import { bucketForTtftMs, bucketForTpotUs } from '../shared/performance-histogram.ts';
import { parseServerSecret } from '../shared/server-secret.ts';
import { assertWebSearchProviderName, type WebSearchConfig } from '../shared/web-search-providers.ts';
import { AgentSetupTokenCollisionError } from '@floway-dev/agent-setup';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import { addDecimalStrings, canonicalPricingSelectorKey, parseBillingMetric, parseModelKind, parseNonNegativeDecimalString, parsePricingSelectorKey, type AliasSelection, type AliasTarget, type AnnouncedMetadata } from '@floway-dev/protocols/common';
import type { ProxyFallbackEntry, ModelPrefixConfig, UpstreamModelsCache, UpstreamRecord } from '@floway-dev/provider';
import { normalizeModelPrefix, parsePerformanceOperation, UpstreamGoneError } from '@floway-dev/provider';

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
  responses_retention_seconds: number;
}

const API_KEY_COLUMNS = 'id, user_id, name, key, server_secret, created_at, last_used_at, upstream_ids, deleted_at, dump_retention_seconds, responses_retention_seconds';

const serializeUpstreamIds = (value: readonly string[] | null): string | null => (value === null ? null : JSON.stringify(value));

// D1 and node:sqlite bind SQLite scalars, not JavaScript booleans. SQLite's
// conditional expressions represent boolean flags as integer 0/1 values.
const sqliteBoolean = (value: boolean): 0 | 1 => value ? 1 : 0;

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
  responsesRetentionSeconds: row.responses_retention_seconds,
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
        `INSERT INTO api_keys (${API_KEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           user_id = excluded.user_id,
           name = excluded.name,
           key = excluded.key,
           server_secret = excluded.server_secret,
           last_used_at = excluded.last_used_at,
           upstream_ids = excluded.upstream_ids,
           deleted_at = excluded.deleted_at,
           dump_retention_seconds = excluded.dump_retention_seconds,
           responses_retention_seconds = excluded.responses_retention_seconds`,
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
        key.responsesRetentionSeconds,
      )
      .run();
  }

  async update(id: string, patch: ApiKeyUpdate): Promise<ApiKey | null> {
    const hasName = sqliteBoolean(patch.name !== undefined);
    const hasKey = sqliteBoolean(patch.key !== undefined);
    const hasLastUsedAt = sqliteBoolean(patch.lastUsedAt !== undefined);
    const hasUpstreamIds = sqliteBoolean(patch.upstreamIds !== undefined);
    const hasDumpRetention = sqliteBoolean(patch.dumpRetentionSeconds !== undefined);
    const hasResponsesRetention = sqliteBoolean(patch.responsesRetentionSeconds !== undefined);
    const row = await this.db
      .prepare(
        `UPDATE api_keys
         SET name = CASE WHEN ? THEN ? ELSE name END,
             key = CASE WHEN ? THEN ? ELSE key END,
             last_used_at = CASE WHEN ? THEN ? ELSE last_used_at END,
             upstream_ids = CASE WHEN ? THEN ? ELSE upstream_ids END,
             dump_retention_seconds = CASE WHEN ? THEN ? ELSE dump_retention_seconds END,
             responses_retention_seconds = CASE WHEN ? THEN ? ELSE responses_retention_seconds END
         WHERE id = ? AND deleted_at IS NULL
         RETURNING ${API_KEY_COLUMNS}`,
      )
      .bind(
        hasName ? 1 : 0, patch.name ?? null,
        hasKey ? 1 : 0, patch.key ?? null,
        hasLastUsedAt ? 1 : 0, patch.lastUsedAt ?? null,
        hasUpstreamIds ? 1 : 0, hasUpstreamIds ? serializeUpstreamIds(patch.upstreamIds!) : null,
        hasDumpRetention ? 1 : 0, patch.dumpRetentionSeconds ?? null,
        hasResponsesRetention ? 1 : 0, patch.responsesRetentionSeconds ?? null,
        id,
      )
      .first<ApiKeyRow>();
    return row === null ? null : toApiKey(row);
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE api_keys SET deleted_at = ?, responses_retention_seconds = 0 WHERE id = ? AND deleted_at IS NULL')
      .bind(new Date().toISOString(), id)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async softDeleteByUserId(userId: number): Promise<number> {
    const result = await this.db
      .prepare('UPDATE api_keys SET deleted_at = ?, responses_retention_seconds = 0 WHERE user_id = ? AND deleted_at IS NULL')
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
  created_at: string;
  deleted_at: string | null;
}

const USER_COLUMNS = 'id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at';

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  passwordHash: row.password_hash,
  isAdmin: row.is_admin === 1,
  upstreamIds: parseUpstreamIds(row.upstream_ids, `users.id=${row.id}`),
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
        `INSERT INTO users (id, username, password_hash, is_admin, upstream_ids, created_at, deleted_at)
         SELECT COALESCE(MAX(id), 0) + 1, ?, ?, ?, ?, ?, ? FROM users
         RETURNING id`,
      )
      .bind(
        template.username,
        template.passwordHash,
        template.isAdmin ? 1 : 0,
        serializeUpstreamIds(template.upstreamIds),
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
        `INSERT INTO users (${USER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           username = excluded.username,
           password_hash = excluded.password_hash,
           is_admin = excluded.is_admin,
           upstream_ids = excluded.upstream_ids,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        user.id,
        user.username,
        user.passwordHash,
        user.isAdmin ? 1 : 0,
        serializeUpstreamIds(user.upstreamIds),
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

class SqlWebSearchUsageRepo implements WebSearchUsageRepo {
  constructor(private db: SqlDatabase) {}

  async record(args: { provider: WebSearchUsageRecord['provider']; keyId: string; action: WebSearchUsageRecord['action']; hour: string; requests: number }): Promise<void> {
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

  async query(opts: { provider?: WebSearchUsageRecord['provider']; keyId?: string; action?: WebSearchUsageRecord['action']; start: string; end: string }): Promise<WebSearchUsageRecord[]> {
    const filters = ['hour >= ?', 'hour < ?'];
    const binds: SqlBindValue[] = [opts.start, opts.end];
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
    return results.map(toWebSearchUsageRecord);
  }

  async listAll(): Promise<WebSearchUsageRecord[]> {
    const { results } = await this.db.prepare('SELECT provider, key_id, action, hour, requests FROM search_usage ORDER BY hour').all<{
      provider: string;
      key_id: string;
      action: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toWebSearchUsageRecord);
  }

  async set(record: WebSearchUsageRecord): Promise<void> {
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
  operation: parsePerformanceOperation(row.operation),
  runtimeLocation: row.runtime_location,
});

const performanceRecordKey = (dims: PerformanceDimensions): string =>
  `${dims.hour}\0${dims.keyId}\0${dims.model}\0${dims.upstream}\0${dims.operation}\0${dims.runtimeLocation}`;

const performanceDimensionBinds = (dims: PerformanceDimensions): SqlBindValue[] =>
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
    const binds: SqlBindValue[] = [];
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

const toWebSearchUsageRecord = (row: { provider: string; key_id: string; action: string; hour: string; requests: number }): WebSearchUsageRecord => {
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

class SqlWebSearchConfigRepo implements WebSearchConfigRepo {
  constructor(private db: SqlDatabase) {}

  async get(): Promise<unknown | null> {
    const row = await this.db
      .prepare('SELECT provider, tavily_api_key, microsoft_web_iq_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model FROM search_config WHERE id = 1')
      .first<{ provider: string; tavily_api_key: string; microsoft_web_iq_api_key: string; jina_api_key: string; passthrough_openai_search: number; alpha_search_upstream_id: string; alpha_search_model: string }>();
    if (!row) throw new Error('search_config singleton row missing');
    return {
      provider: row.provider,
      tavily: { apiKey: row.tavily_api_key },
      microsoftWebIq: { apiKey: row.microsoft_web_iq_api_key },
      jina: { apiKey: row.jina_api_key },
      passthroughOpenAiSearch: {
        enabled: row.passthrough_openai_search === 1,
        upstreamId: row.alpha_search_upstream_id,
        model: row.alpha_search_model,
      },
    };
  }

  async save(config: WebSearchConfig): Promise<void> {
    const { provider, tavily, microsoftWebIq, jina, passthroughOpenAiSearch } = config;
    await this.db
      .prepare(
        `INSERT INTO search_config (id, provider, tavily_api_key, microsoft_web_iq_api_key, jina_api_key, passthrough_openai_search, alpha_search_upstream_id, alpha_search_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           tavily_api_key = excluded.tavily_api_key,
           microsoft_web_iq_api_key = excluded.microsoft_web_iq_api_key,
           jina_api_key = excluded.jina_api_key,
           passthrough_openai_search = excluded.passthrough_openai_search,
           alpha_search_upstream_id = excluded.alpha_search_upstream_id,
           alpha_search_model = excluded.alpha_search_model,
           updated_at = excluded.updated_at`,
      )
      .bind(provider, tavily.apiKey, microsoftWebIq.apiKey, jina.apiKey, passthroughOpenAiSearch.enabled ? 1 : 0, passthroughOpenAiSearch.upstreamId, passthroughOpenAiSearch.model)
      .run();
  }
}

// Losing once is ordinary on a row this contended, losing four times in a row
// is not — and the attempts run back-to-back with no delay, so they observe
// much the same contention rather than independent draws. The bound is a
// judgement call about how much immediate re-reading is worth doing before
// declaring the row unwritable, not a derived figure.
export const UPSTREAM_STATE_WRITE_ATTEMPTS = 4;

class SqlUpstreamRepo implements UpstreamRepo {
  constructor(private db: SqlDatabase) {}

  async list(): Promise<UpstreamRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, models_cache_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, hue FROM upstreams ORDER BY sort_order, created_at')
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, models_cache_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, hue FROM upstreams WHERE id = ?')
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    // created_at is deliberately not in the ON CONFLICT update list: the row's first INSERT
    // wins, and re-saves preserve that timestamp regardless of what the caller passes.
    await this.db
      .prepare(
        `INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json, model_prefix_json, hue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           hue = excluded.hue`,
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
        upstream.hue,
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

  // Written only here and never by save(): an operator edit carries whatever
  // catalog the request happened to read, and folding that back in would let a
  // rename race a refresh.
  async saveModelsCache(id: string, cache: Omit<UpstreamModelsCache, 'lastError'>): Promise<void> {
    await this.db
      .prepare('UPDATE upstreams SET models_cache_json = ? WHERE id = ?')
      .bind(JSON.stringify({ ...cache, lastError: null }, modelsReplacer), id)
      .run();
  }

  // Annotates a previously-successful entry, so an upstream that has never
  // cached a catalog has nothing to annotate. Patched in SQL rather than
  // read-modify-written: it touches one key of a document whose other keys a
  // concurrent refresh may be rewriting, and nothing compares this column's
  // text, so the encoding SQLite produces here is immaterial.
  async saveModelsCacheError(id: string, error: NonNullable<UpstreamModelsCache['lastError']>): Promise<void> {
    await this.db
      .prepare("UPDATE upstreams SET models_cache_json = json_set(models_cache_json, '$.lastError', json(?)) WHERE id = ? AND models_cache_json IS NOT NULL")
      .bind(JSON.stringify(error), id)
      .run();
  }

  // Read-modify-write under optimistic concurrency, retried against the winner
  // on a loss. `IS` (not `=`) so a row whose state_json is SQL NULL still
  // matches. The predicate binds the exact text this method read rather than a
  // re-serialized form, so the CAS holds against a row written by anything —
  // including a migration, which has no way to reproduce the canonical
  // encoder's output.
  //
  // Losing is expected, not exceptional: the same row carries values written on
  // every data-plane response, so a rotation's read-to-write window overlaps
  // them routinely. Retrying is what makes the loss harmless; exhausting the
  // retries is not, because the caller's change — a rotated refresh token the
  // vendor has already invalidated — cannot be reconstructed later, so it
  // throws rather than returning a flag a caller can drop.
  async saveState(id: string, mutate: (current: unknown) => unknown): Promise<void> {
    for (let attempt = 0; attempt < UPSTREAM_STATE_WRITE_ATTEMPTS; attempt++) {
      const row = await this.db
        .prepare('SELECT state_json FROM upstreams WHERE id = ?')
        .bind(id)
        .first<{ state_json: string | null }>();
      if (!row) throw new UpstreamGoneError(id);
      let current: unknown = null;
      if (row.state_json !== null) {
        try {
          current = JSON.parse(row.state_json) as unknown;
        } catch (cause) {
          throw new Error(`Malformed upstream state JSON for ${id}`, { cause });
        }
      }
      const next = serializeStoredState(mutate(current));
      // A mutator that decided there is nothing to do returns what it was
      // given, which serializes back to the stored text.
      if (next === row.state_json) return;
      const result = await this.db
        .prepare('UPDATE upstreams SET state_json = ? WHERE id = ? AND state_json IS ?')
        .bind(next, id, row.state_json)
        .run();
      if ((result.meta.changes ?? 0) > 0) return;
    }
    throw new Error(`Upstream ${id} state write lost ${UPSTREAM_STATE_WRITE_ATTEMPTS} consecutive races`);
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
  models_cache_json: string | null;
  flag_overrides: string;
  disabled_public_model_ids: string;
  proxy_fallback_list_json: string;
  model_prefix_json: string | null;
  hue: number;
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
    modelsCache: parseModelsCache(row),
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
    hue: parseUpstreamHue(row.id, row.hue),
  };
};

// The whole entry is one document, so a row either has a catalog or does not —
// there is no half-populated state to reject. `modelsReviver` restores the Sets
// that `modelsReplacer` flattened on the way in.
const parseModelsCache = (row: UpstreamRow): UpstreamModelsCache | null => {
  if (row.models_cache_json === null) return null;
  try {
    return JSON.parse(row.models_cache_json, modelsReviver) as UpstreamModelsCache;
  } catch (cause) {
    throw new Error(`Malformed upstream models cache JSON for ${row.id}`, { cause });
  }
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
  id: string;
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

const MODEL_ALIAS_COLUMNS = 'id, name, kind, selection, display_name, visible_in_models_list, targets, announced_metadata_json, sort_order, created_at, updated_at';

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
  id: row.id,
  name: row.name,
  kind: parseModelKind(row.kind, `model_aliases.kind for ${row.name}`),
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

  async getById(id: string): Promise<ModelAliasRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${MODEL_ALIAS_COLUMNS} FROM model_aliases WHERE id = ?`)
      .bind(id)
      .first<ModelAliasRow>();
    return row ? toModelAliasRecord(row) : null;
  }

  async insert(record: ModelAliasRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO model_aliases (${MODEL_ALIAS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
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

  async update(record: ModelAliasRecord): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE model_aliases SET
           name = ?,
           kind = ?,
           selection = ?,
           display_name = ?,
           visible_in_models_list = ?,
           targets = ?,
           announced_metadata_json = ?,
           sort_order = ?,
           created_at = ?,
           updated_at = ?
         WHERE id = ?`,
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
        record.id,
      )
      .run();
    if ((result.meta.changes ?? 0) === 0) throw new Error(`alias ${record.id} not found`);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM model_aliases WHERE id = ?')
      .bind(id)
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

  constructor(db: SqlDatabase) {
    this.users = new SqlUsersRepo(db);
    this.sessions = new SqlSessionsRepo(db);
    this.apiKeys = new SqlApiKeyRepo(db);
    this.usage = new SqlUsageRepo(db);
    this.webSearchUsage = new SqlWebSearchUsageRepo(db);
    this.performance = new SqlPerformanceRepo(db);
    this.webSearchConfig = new SqlWebSearchConfigRepo(db);
    this.upstreams = new SqlUpstreamRepo(db);
    this.proxies = new SqlProxyRepo(db);
    this.proxyBackoffs = new SqlProxyBackoffRepo(db);
    this.modelAliases = new SqlModelAliasesRepo(db);
    this.responsesItems = new SqlResponsesItemsRepo(db);
    this.responsesSnapshots = new SqlResponsesSnapshotsRepo(db);
    this.spilledFiles = new SqlSpilledFilesRepo(db);
    this.expirationSweeps = new SqlExpirationSweepsRepo(db);
    this.agentSetup = new SqlAgentSetupRepo(db);
  }
}
