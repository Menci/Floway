import { normalizeFlagOverrides } from './flag-overrides.ts';
import type {
  ApiKey,
  ApiKeyRepo,
  CacheRepo,
  PerformanceDimensions,
  PerformanceErrorSample,
  PerformanceLatencySample,
  PerformanceMetricScope,
  PerformanceRepo,
  PerformanceTelemetryRecord,
  Repo,
  SearchConfigRepo,
  SearchUsageRecord,
  SearchUsageRepo,
  UpstreamProviderKind,
  UpstreamRecord,
  UpstreamRepo,
  UsageRecord,
  UsageRepo,
} from './types.ts';
import { latencyBucketForMs } from '../shared/performance-histogram.ts';
import { assertWebSearchProviderName } from '../shared/web-search-providers.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';

// Minimal D1 type definitions (subset of @cloudflare/workers-types)
interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch?(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

const SEARCH_CONFIG_KEY = 'search_config';

const serializeStoredConfig = (value: unknown): string => JSON.stringify(value === undefined ? null : value);

class D1ApiKeyRepo implements ApiKeyRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<ApiKey[]> {
    const { results } = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys ORDER BY created_at').all<ApiKeyRow>();
    return results.map(toApiKey);
  }

  async findByRawKey(rawKey: string): Promise<ApiKey | null> {
    const row = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys WHERE key = ?').bind(rawKey).first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async getById(id: string): Promise<ApiKey | null> {
    const row = await this.db.prepare('SELECT id, name, key, created_at, last_used_at, upstream_ids FROM api_keys WHERE id = ?').bind(id).first<ApiKeyRow>();
    return row ? toApiKey(row) : null;
  }

  async save(key: ApiKey): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key, created_at, last_used_at, upstream_ids) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, key = excluded.key, last_used_at = excluded.last_used_at, upstream_ids = excluded.upstream_ids`,
      )
      .bind(key.id, key.name, key.key, key.createdAt, key.lastUsedAt ?? null, serializeUpstreamIds(key.upstreamIds))
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
    return ((result.meta.changes as number) ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM api_keys').run();
  }
}

interface ApiKeyRow {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string | null;
}

const serializeUpstreamIds = (value: readonly string[] | null): string | null => (value === null ? null : JSON.stringify(value));

// Throws rather than returning null on bad data: a silent downgrade to Default
// would grant the key broader provider access than the admin intended.
const parseUpstreamIds = (raw: string | null, keyId: string): string[] | null => {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`api_keys.upstream_ids JSON is malformed for id=${keyId}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`api_keys.upstream_ids is not an array for id=${keyId}`);
  if (!parsed.every(item => typeof item === 'string')) throw new Error(`api_keys.upstream_ids contains non-string entries for id=${keyId}`);
  return parsed as string[];
};

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    upstreamIds: parseUpstreamIds(row.upstream_ids, row.id),
  };
}

const USAGE_COLUMNS = 'key_id, model, upstream, model_key, hour, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_json';

const usageCostJson = (cost: UsageRecord['cost']): string | null => (cost ? JSON.stringify(cost) : null);

class D1UsageRepo implements UsageRepo {
  constructor(private db: D1Database) {}

  async record(record: UsageRecord): Promise<void> {
    const normalized = normalizeUsageRecord(record);
    await this.db
      .prepare(
        `INSERT INTO usage (${USAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = requests + excluded.requests,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
           cost_json = COALESCE(cost_json, excluded.cost_json)`,
      )
      .bind(
        normalized.keyId,
        normalized.model,
        normalized.upstream,
        normalized.modelKey,
        normalized.hour,
        normalized.requests,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cacheReadTokens ?? 0,
        normalized.cacheCreationTokens ?? 0,
        usageCostJson(normalized.cost),
      )
      .run();
  }

  async query(opts: { keyId?: string; start: string; end: string }): Promise<UsageRecord[]> {
    const sql = opts.keyId
      ? `SELECT ${USAGE_COLUMNS} FROM usage WHERE key_id = ? AND hour >= ? AND hour < ? ORDER BY hour`
      : `SELECT ${USAGE_COLUMNS} FROM usage WHERE hour >= ? AND hour < ? ORDER BY hour`;
    const binds = opts.keyId ? [opts.keyId, opts.start, opts.end] : [opts.start, opts.end];
    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<UsageRow>();
    return results.map(toUsageRecord);
  }

  async listAll(): Promise<UsageRecord[]> {
    const { results } = await this.db.prepare(`SELECT ${USAGE_COLUMNS} FROM usage ORDER BY hour`).all<UsageRow>();
    return results.map(toUsageRecord);
  }

  async set(record: UsageRecord): Promise<void> {
    const normalized = normalizeUsageRecord(record);
    await this.db
      .prepare(
        `INSERT INTO usage (${USAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens,
           cache_creation_tokens = excluded.cache_creation_tokens,
           cost_json = excluded.cost_json`,
      )
      .bind(
        normalized.keyId,
        normalized.model,
        normalized.upstream,
        normalized.modelKey,
        normalized.hour,
        normalized.requests,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cacheReadTokens ?? 0,
        normalized.cacheCreationTokens ?? 0,
        usageCostJson(normalized.cost),
      )
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM usage').run();
  }
}

type UsageRow = {
  key_id: string;
  model: string;
  upstream: string | null;
  model_key: string;
  hour: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_json: string | null;
};

const normalizeUsageRecord = (record: UsageRecord): UsageRecord => ({
  ...record,
  upstream: record.upstream ?? null,
  cacheReadTokens: record.cacheReadTokens ?? 0,
  cacheCreationTokens: record.cacheCreationTokens ?? 0,
});

const parseUsageCost = (raw: string | null): UsageRecord['cost'] => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ModelPricing>;
    if (typeof parsed.input !== 'number' || typeof parsed.output !== 'number') return null;
    return parsed as ModelPricing;
  } catch {
    return null;
  }
};

const toUsageRecord = (row: UsageRow): UsageRecord => ({
  keyId: row.key_id,
  model: row.model,
  upstream: row.upstream ?? null,
  modelKey: row.model_key,
  hour: row.hour,
  requests: row.requests,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  cacheReadTokens: row.cache_read_tokens ?? 0,
  cacheCreationTokens: row.cache_creation_tokens ?? 0,
  cost: parseUsageCost(row.cost_json),
});

class D1SearchUsageRepo implements SearchUsageRepo {
  constructor(private db: D1Database) {}

  async record(provider: SearchUsageRecord['provider'], keyId: string, hour: string, requests: number): Promise<void> {
    const validProvider = assertWebSearchProviderName(provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, hour, requests) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, key_id, hour) DO UPDATE SET
           requests = requests + excluded.requests`,
      )
      .bind(validProvider, keyId, hour, requests)
      .run();
  }

  async query(opts: { provider?: SearchUsageRecord['provider']; keyId?: string; start: string; end: string }): Promise<SearchUsageRecord[]> {
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

    const { results } = await this.db
      .prepare(`SELECT provider, key_id, hour, requests FROM search_usage WHERE ${filters.join(' AND ')} ORDER BY hour`)
      .bind(...binds)
      .all<{
      provider: string;
      key_id: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async listAll(): Promise<SearchUsageRecord[]> {
    const { results } = await this.db.prepare('SELECT provider, key_id, hour, requests FROM search_usage ORDER BY hour').all<{
      provider: string;
      key_id: string;
      hour: string;
      requests: number;
    }>();
    return results.map(toSearchUsageRecord);
  }

  async set(record: SearchUsageRecord): Promise<void> {
    const provider = assertWebSearchProviderName(record.provider);
    await this.db
      .prepare(
        `INSERT INTO search_usage (provider, key_id, hour, requests) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, key_id, hour) DO UPDATE SET
           requests = excluded.requests`,
      )
      .bind(provider, record.keyId, record.hour, record.requests)
      .run();
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM search_usage').run();
  }
}

class D1PerformanceRepo implements PerformanceRepo {
  constructor(private db: D1Database) {}

  async recordLatency(sample: PerformanceLatencySample): Promise<void> {
    const durationMs = Math.max(0, Math.round(sample.durationMs));
    const bucket = latencyBucketForMs(durationMs);
    await this.runStatements([this.addSummaryStatement(sample, 1, 0, durationMs), this.addBucketStatement(sample, bucket.lowerMs, bucket.upperMs, 1)]);
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
    await this.runStatements([
      this.setSummaryStatement(record),
      this.deleteBucketsStatement(record),
      ...record.buckets.map(bucket => this.setBucketStatement(record, bucket.lowerMs, bucket.upperMs, bucket.count)),
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
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum
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
        `SELECT hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count
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

  private async runStatements(statements: D1PreparedStatement[]): Promise<void> {
    if (this.db.batch) {
      await this.db.batch(statements);
      return;
    }
    for (const statement of statements) await statement.run();
  }

  private addSummaryStatement(sample: PerformanceDimensions, requests: number, errors: number, totalMsSum: number): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        sample.sourceApi,
        sample.targetApi,
        sample.stream ? 1 : 0,
        sample.runtimeLocation,
        requests,
        errors,
        totalMsSum,
      );
  }

  private setSummaryStatement(record: PerformanceTelemetryRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_summary (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, requests, errors, total_ms_sum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        record.sourceApi,
        record.targetApi,
        record.stream ? 1 : 0,
        record.runtimeLocation,
        record.requests,
        record.errors,
        record.totalMsSum,
      );
  }

  private deleteBucketsStatement(record: PerformanceDimensions): D1PreparedStatement {
    return this.db
      .prepare(
        `DELETE FROM performance_latency_buckets
         WHERE hour = ? AND metric_scope = ? AND key_id = ? AND model = ? AND upstream IS ? AND model_key = ? AND source_api = ? AND target_api = ? AND stream = ? AND runtime_location = ?`,
      )
      .bind(...performanceDimensionBinds(record));
  }

  private addBucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number): D1PreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, 'add');
  }

  private setBucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number): D1PreparedStatement {
    return this.bucketStatement(sample, lowerMs, upperMs, count, 'set');
  }

  private bucketStatement(sample: PerformanceDimensions, lowerMs: number, upperMs: number, count: number, mode: 'add' | 'set'): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO performance_latency_buckets (hour, metric_scope, key_id, model, upstream, model_key, source_api, target_api, stream, runtime_location, lower_ms, upper_ms, count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        sample.sourceApi,
        sample.targetApi,
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
  source_api: string;
  target_api: string;
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

function performanceDimensionsFromRow(row: PerformanceDimensionRow): PerformanceDimensions {
  return {
    hour: row.hour,
    metricScope: row.metric_scope as PerformanceMetricScope,
    keyId: row.key_id,
    model: row.model,
    upstream: row.upstream ?? null,
    modelKey: row.model_key,
    sourceApi: row.source_api as PerformanceTelemetryRecord['sourceApi'],
    targetApi: row.target_api as PerformanceTelemetryRecord['targetApi'],
    stream: row.stream === 1,
    runtimeLocation: row.runtime_location,
  };
}

function performanceRecordKey(record: PerformanceDimensions): string {
  return [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.sourceApi, record.targetApi, record.stream ? '1' : '0', record.runtimeLocation].join(
    '\0',
  );
}

function performanceDimensionBinds(record: PerformanceDimensions): unknown[] {
  return [record.hour, record.metricScope, record.keyId, record.model, record.upstream, record.modelKey, record.sourceApi, record.targetApi, record.stream ? 1 : 0, record.runtimeLocation];
}

function comparePerformanceTelemetryRecords(a: PerformanceTelemetryRecord, b: PerformanceTelemetryRecord): number {
  return (
    a.hour.localeCompare(b.hour) ||
    a.metricScope.localeCompare(b.metricScope) ||
    a.keyId.localeCompare(b.keyId) ||
    a.model.localeCompare(b.model) ||
    (a.upstream ?? '').localeCompare(b.upstream ?? '') ||
    a.modelKey.localeCompare(b.modelKey) ||
    a.sourceApi.localeCompare(b.sourceApi) ||
    a.targetApi.localeCompare(b.targetApi) ||
    Number(a.stream) - Number(b.stream) ||
    a.runtimeLocation.localeCompare(b.runtimeLocation)
  );
}

function toSearchUsageRecord(row: { provider: string; key_id: string; hour: string; requests: number }): SearchUsageRecord {
  return {
    provider: assertWebSearchProviderName(row.provider),
    keyId: row.key_id,
    hour: row.hour,
    requests: row.requests,
  };
}

class D1CacheRepo implements CacheRepo {
  constructor(private db: D1Database) {}

  async get(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').bind(key, value).run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare('DELETE FROM config WHERE key = ?').bind(key).run();
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.db.prepare('DELETE FROM config WHERE key >= ? AND key < ?').bind(prefix, `${prefix}\uffff`).run();
  }
}

class D1SearchConfigRepo implements SearchConfigRepo {
  constructor(private db: D1Database) {}

  async get(): Promise<unknown | null> {
    const row = await this.db.prepare('SELECT value FROM config WHERE key = ?').bind(SEARCH_CONFIG_KEY).first<{ value: string }>();

    if (!row?.value) {
      return null;
    }

    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  async save(config: unknown): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO config (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .bind(SEARCH_CONFIG_KEY, serializeStoredConfig(config))
      .run();
  }
}

class D1UpstreamRepo implements UpstreamRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<UpstreamRecord[]> {
    const { results } = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides FROM upstreams ORDER BY sort_order, created_at')
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async getById(id: string): Promise<UpstreamRecord | null> {
    const row = await this.db
      .prepare('SELECT id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides FROM upstreams WHERE id = ?')
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async save(upstream: UpstreamRecord): Promise<void> {
    // created_at is deliberately not in the ON CONFLICT update list: the row's first INSERT
    // wins, and re-saves preserve that timestamp regardless of what the caller passes.
    await this.db
      .prepare(
        `INSERT INTO upstreams (id, provider, name, enabled, sort_order, created_at, updated_at, config_json, flag_overrides) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           provider = excluded.provider,
           name = excluded.name,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at,
           config_json = excluded.config_json,
           flag_overrides = excluded.flag_overrides`,
      )
      .bind(
        upstream.id,
        upstream.provider,
        upstream.name,
        upstream.enabled ? 1 : 0,
        upstream.sortOrder,
        upstream.createdAt,
        upstream.updatedAt,
        serializeStoredConfig(upstream.config),
        JSON.stringify(normalizeFlagOverrides(upstream.flagOverrides)),
      )
      .run();
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM upstreams WHERE id = ?').bind(id).run();
    return ((result.meta.changes as number) ?? 0) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstreams').run();
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
  flag_overrides: string;
}

function toUpstreamRecord(row: UpstreamRow): UpstreamRecord {
  let config: unknown;
  try {
    config = JSON.parse(row.config_json) as unknown;
  } catch {
    throw new Error(`Malformed upstream config JSON for ${row.id}`);
  }

  return {
    id: row.id,
    provider: assertUpstreamProviderKind(row.provider),
    name: row.name,
    enabled: row.enabled !== 0,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config,
    flagOverrides: parseFlagOverrides(row.id, row.flag_overrides),
  };
}

const assertUpstreamProviderKind = (provider: string): UpstreamProviderKind => {
  if (provider === 'copilot' || provider === 'custom' || provider === 'azure') return provider;
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

export class D1Repo implements Repo {
  apiKeys: ApiKeyRepo;
  usage: UsageRepo;
  searchUsage: SearchUsageRepo;
  performance: PerformanceRepo;
  cache: CacheRepo;
  searchConfig: SearchConfigRepo;
  upstreams: UpstreamRepo;

  constructor(db: D1Database) {
    this.apiKeys = new D1ApiKeyRepo(db);
    this.usage = new D1UsageRepo(db);
    this.searchUsage = new D1SearchUsageRepo(db);
    this.performance = new D1PerformanceRepo(db);
    this.cache = new D1CacheRepo(db);
    this.searchConfig = new D1SearchConfigRepo(db);
    this.upstreams = new D1UpstreamRepo(db);
  }
}
