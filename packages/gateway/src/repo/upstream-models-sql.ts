import { normalizeDisabledPublicModelIds } from './disabled-public-models.ts';
import { normalizeFlagOverrides } from './flag-overrides.ts';
import { AUTOMATIC_REFRESH_INTERVAL_MS, storedModelErrorMessage } from './models-cache-contract.ts';
import { MODELS_REFRESH_BACKOFF_DELAYS_MS } from './models-refresh-backoff.ts';
import { normalizeProxyFallbackList } from './proxy-fallback-list.ts';
import { runStatements } from './sql-batch.ts';
import type {
  CatalogUpstreamRow,
  DueModelsRefreshCandidate,
  ModelsRefreshFailureInput,
  ModelsRefreshSuccessInput,
  ResolvedUpstreamModelMatch,
  StoredUpstreamMeta,
  StoredUpstreamRecord,
  UpstreamCatalogFilter,
  UpstreamInsertInput,
  UpstreamModelEntry,
  UpstreamModelsCacheAction,
  UpstreamModelsCacheState,
  UpstreamModelsRepo,
  UpstreamModelsWritePayload,
  UpstreamRepo,
} from './types.ts';
import {
  decodeDisabledPublicModelIds,
  decodeProxyFallbackList,
  decodeUpstreamConfig,
  decodeUpstreamFlagOverrides,
  decodeUpstreamManualModel,
  decodeUpstreamModel,
  decodeUpstreamState,
  encodeUpstreamManualModel,
  encodeUpstreamModel,
} from './upstream-codecs.ts';
import { serializeStoredConfig, serializeStoredState } from './upstream-json.ts';
import { parseUpstreamHue, parseUpstreamKind } from './upstream-parse.ts';
import type { SqlBindValue, SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { AddressableForm, ModelPrefixConfig, UpstreamModel, UpstreamModelConfig, UpstreamModelSource, UpstreamRecord } from '@floway-dev/upstream';
import { MODEL_PREFIX_MAX_LENGTH, normalizeModelPrefix, publicModelId, UpstreamGoneError } from '@floway-dev/upstream';

// Losing once is ordinary on a row this contended, losing four times in a row
// is not — and the attempts run back-to-back with no delay, so they observe
// much the same contention rather than independent draws. The bound is a
// judgement call about how much immediate re-reading is worth doing before
// declaring the row unwritable, not a derived figure.
export const UPSTREAM_STATE_WRITE_ATTEMPTS = 4;

const JSON_INSERT_CHUNK_SIZE = 100;

const sqliteBoolean = (value: boolean): 0 | 1 => value ? 1 : 0;

const requireChanges = (result: { readonly meta: { readonly changes?: number } } | undefined, label: string): number => {
  if (result?.meta.changes === undefined) throw new Error(`SQLite driver omitted meta.changes for ${label}`);
  return result.meta.changes;
};

type StoredAddressableMode = 'unprefixed' | 'prefixed' | 'both';
type StoredListedMode = 'none' | 'unprefixed' | 'prefixed' | 'both';

const encodeModelPrefixColumns = (prefix: ModelPrefixConfig | null): {
  readonly prefix: string | null;
  readonly addressable: StoredAddressableMode | null;
  readonly listed: StoredListedMode | null;
} => {
  const normalized = normalizeModelPrefix(prefix);
  if (normalized === null) return { prefix: null, addressable: null, listed: null };
  const hasUnprefixedAddr = normalized.addressable.includes('unprefixed');
  const hasPrefixedAddr = normalized.addressable.includes('prefixed');
  const addressable: StoredAddressableMode = hasUnprefixedAddr && hasPrefixedAddr
    ? 'both'
    : hasPrefixedAddr ? 'prefixed' : 'unprefixed';
  const hasUnprefixedList = normalized.listed.includes('unprefixed');
  const hasPrefixedList = normalized.listed.includes('prefixed');
  const listed: StoredListedMode = hasUnprefixedList && hasPrefixedList
    ? 'both'
    : hasPrefixedList ? 'prefixed' : hasUnprefixedList ? 'unprefixed' : 'none';
  return { prefix: normalized.prefix, addressable, listed };
};

const formsFromStoredMode = (mode: string, field: string, id: string): AddressableForm[] => {
  if (mode === 'none') return [];
  if (mode === 'unprefixed') return ['unprefixed'];
  if (mode === 'prefixed') return ['prefixed'];
  if (mode === 'both') return ['unprefixed', 'prefixed'];
  throw new Error(`Invalid upstream ${field} for ${id}: ${mode}`);
};

const parseModelPrefixColumns = (
  id: string,
  prefix: string | null,
  addressable: string | null,
  listed: string | null,
): ModelPrefixConfig | null => {
  if (prefix === null && addressable === null && listed === null) return null;
  if (prefix === null || addressable === null || listed === null) {
    throw new Error(`Incomplete upstream model_prefix columns for ${id}`);
  }
  try {
    return normalizeModelPrefix({
      prefix,
      addressable: formsFromStoredMode(addressable, 'model_prefix_addressable', id),
      listed: formsFromStoredMode(listed, 'model_prefix_listed', id),
    });
  } catch (cause) {
    throw new Error(`Invalid upstream model_prefix columns for ${id}`, { cause });
  }
};

const listedMultiplier = (prefix: string | null, listed: string | null): number => {
  if (prefix === null) return 1;
  if (listed === 'both') return 2;
  if (listed === 'none') return 0;
  return 1;
};

const parseModelsCacheState = (row: {
  id: string;
  models_cache_revision: number | null;
  models_cache_fetched_at: number | null;
  models_cache_error_message: string | null;
  models_cache_error_at: number | null;
  models_cache_failure_count: number;
}): UpstreamModelsCacheState => {
  const hasError = row.models_cache_error_message !== null;
  if (hasError && (row.models_cache_error_at === null || row.models_cache_failure_count < 1)) {
    throw new Error(`Invalid upstream models cache error state for ${row.id}`);
  }
  return {
    revision: row.models_cache_revision,
    fetchedAt: row.models_cache_fetched_at,
    lastError: hasError
      ? {
          message: row.models_cache_error_message!,
          at: row.models_cache_error_at!,
          failureCount: row.models_cache_failure_count,
        }
      : null,
  };
};

interface UpstreamMetaRow {
  id: string;
  kind: string;
  name: string;
  enabled: number;
  sort_order: number;
  hue: number;
}

interface UpstreamRow extends UpstreamMetaRow {
  usage_refresh_interval_minutes: number;
  created_at: string;
  updated_at: string;
  version: number;
  config_json: string;
  state_json: string | null;
  flag_overrides: string;
  disabled_public_model_ids: string;
  proxy_fallback_list_json: string;
  model_prefix: string | null;
  model_prefix_addressable: string | null;
  model_prefix_listed: string | null;
  models_cache_revision: number | null;
  models_cache_fetched_at: number | null;
  models_cache_error_message: string | null;
  models_cache_error_at: number | null;
  models_cache_failure_count: number;
}

const UPSTREAM_META_COLUMNS = 'id, kind, name, enabled, sort_order, hue';
const UPSTREAM_COLUMNS = [
  'id',
  'kind',
  'name',
  'enabled',
  'usage_refresh_interval_minutes',
  'sort_order',
  'created_at',
  'updated_at',
  'version',
  'config_json',
  'state_json',
  'flag_overrides',
  'disabled_public_model_ids',
  'proxy_fallback_list_json',
  'model_prefix',
  'model_prefix_addressable',
  'model_prefix_listed',
  'models_cache_revision',
  'models_cache_fetched_at',
  'models_cache_error_message',
  'models_cache_error_at',
  'models_cache_failure_count',
  'hue',
].join(', ');

const UPSTREAM_COLUMNS_ALIASED = UPSTREAM_COLUMNS
  .split(', ')
  .map(column => `u.${column}`)
  .join(', ');

const toUpstreamMeta = (row: UpstreamMetaRow): StoredUpstreamMeta => ({
  id: row.id,
  kind: parseUpstreamKind(row.id, row.kind),
  name: row.name,
  enabled: row.enabled !== 0,
  sortOrder: row.sort_order,
  hue: parseUpstreamHue(row.id, row.hue),
});

const toUpstreamRecord = (row: UpstreamRow): StoredUpstreamRecord => {
  const config = decodeUpstreamConfig(row.config_json, row.id);
  const state = row.state_json === null ? null : decodeUpstreamState(row.state_json, row.id);
  if (!Number.isSafeInteger(row.version) || row.version < 1) {
    throw new Error(`Invalid upstream version for ${row.id}`);
  }

  return {
    id: row.id,
    kind: parseUpstreamKind(row.id, row.kind),
    name: row.name,
    enabled: row.enabled !== 0,
    usageRefreshIntervalMinutes: row.usage_refresh_interval_minutes,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    config,
    state,
    flagOverrides: normalizeFlagOverrides(decodeUpstreamFlagOverrides(row.flag_overrides, row.id)),
    disabledPublicModelIds: normalizeDisabledPublicModelIds(decodeDisabledPublicModelIds(row.disabled_public_model_ids, row.id)),
    proxyFallbackList: normalizeProxyFallbackList(decodeProxyFallbackList(row.proxy_fallback_list_json, row.id)),
    modelPrefix: parseModelPrefixColumns(row.id, row.model_prefix, row.model_prefix_addressable, row.model_prefix_listed),
    hue: parseUpstreamHue(row.id, row.hue),
    modelsCache: parseModelsCacheState(row),
  };
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

const dedupeModelsForStorage = (entries: readonly UpstreamModelEntry[]): UpstreamModelEntry[] => {
  const seen = new Set<string>();
  const out: UpstreamModelEntry[] = [];
  for (const entry of entries) {
    if (!entry.model.id) continue;
    const key = `${entry.model.id}\0${entry.model.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
};

const BACKOFF_DELAY_SQL = `CASE ${MODELS_REFRESH_BACKOFF_DELAYS_MS
  .slice(0, -1)
  .map((delay, index) => `WHEN models_cache_failure_count = ${index + 1} THEN ${delay}`)
  .join(' ')} ELSE ${MODELS_REFRESH_BACKOFF_DELAYS_MS[MODELS_REFRESH_BACKOFF_DELAYS_MS.length - 1]} END`;

const buildModelsReplacementStatements = (
  db: SqlDatabase,
  upstreamId: string,
  version: number,
  models: readonly UpstreamModelEntry[],
): SqlPreparedStatement[] => {
  const deduped = dedupeModelsForStorage(models);
  const stmts: SqlPreparedStatement[] = [];

  if (deduped.length === 0) {
    stmts.push(
      db.prepare(
        `DELETE FROM upstream_models
         WHERE upstream_id = ?
           AND EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)`,
      ).bind(upstreamId, upstreamId, version),
    );
    return stmts;
  }

  const incomingKeysJson = JSON.stringify(deduped.map(({ model }) => ({ m: model.id, k: model.kind })));
  stmts.push(
    db.prepare(
      `DELETE FROM upstream_models
       WHERE upstream_id = ?
         AND EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)
         AND (model_id, kind) NOT IN (
           SELECT
             CAST(json_extract(j.value, '$.m') AS TEXT),
             CAST(json_extract(j.value, '$.k') AS TEXT)
           FROM json_each(?) j
         )`,
    ).bind(upstreamId, upstreamId, version, incomingKeysJson),
  );

  for (const group of chunk(deduped, JSON_INSERT_CHUNK_SIZE)) {
    const payload = JSON.stringify(group.map(({ source, model }) => ({
      modelId: model.id,
      upstreamModelId: model.upstreamModelId,
      kind: model.kind,
      source,
      modelJson: encodeUpstreamModel(model),
    })));
    stmts.push(
      db.prepare(
        `INSERT INTO upstream_models (upstream_id, model_id, upstream_model_id, kind, source, disabled, model_json)
         SELECT
           u.id,
           CAST(json_extract(j.value, '$.modelId') AS TEXT),
           CAST(json_extract(j.value, '$.upstreamModelId') AS TEXT),
           CAST(json_extract(j.value, '$.kind') AS TEXT),
           CAST(json_extract(j.value, '$.source') AS TEXT),
           CASE
             WHEN EXISTS (
               SELECT 1 FROM json_each(u.disabled_public_model_ids) d
               WHERE d.value = CAST(json_extract(j.value, '$.modelId') AS TEXT)
             ) THEN 1
             ELSE 0
           END,
           CAST(json_extract(j.value, '$.modelJson') AS TEXT)
         FROM upstreams u
         JOIN json_each(?) j
         WHERE u.id = ? AND u.version = ?
         ON CONFLICT (upstream_id, model_id, kind) DO UPDATE SET
           upstream_model_id = excluded.upstream_model_id,
           source = excluded.source,
           disabled = excluded.disabled,
           model_json = excluded.model_json
         WHERE upstream_models.upstream_model_id != excluded.upstream_model_id
            OR upstream_models.source != excluded.source
            OR upstream_models.disabled != excluded.disabled
            OR upstream_models.model_json != excluded.model_json`,
      ).bind(payload, upstreamId, version),
    );
  }
  return stmts;
};

const buildManualModelsReplacementStatements = (
  db: SqlDatabase,
  upstreamId: string,
  version: number,
  manualModels: readonly UpstreamModelConfig[],
): SqlPreparedStatement[] => {
  const stmts: SqlPreparedStatement[] = [
    db.prepare(
      `DELETE FROM upstream_manual_models
       WHERE upstream_id = ?
         AND EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)`,
    ).bind(upstreamId, upstreamId, version),
  ];
  for (const [groupIndex, group] of chunk(manualModels, JSON_INSERT_CHUNK_SIZE).entries()) {
    const offset = groupIndex * JSON_INSERT_CHUNK_SIZE;
    const payload = JSON.stringify(group.map((model, index) => ({
      position: offset + index,
      upstreamModelId: model.upstreamModelId,
      publicModelId: publicModelId(model),
      kind: model.kind,
      configJson: encodeUpstreamManualModel(model),
    })));
    stmts.push(
      db.prepare(
        `INSERT INTO upstream_manual_models (upstream_id, position, upstream_model_id, public_model_id, kind, config_json)
         SELECT
           ?,
           CAST(json_extract(value, '$.position') AS INTEGER),
           CAST(json_extract(value, '$.upstreamModelId') AS TEXT),
           CAST(json_extract(value, '$.publicModelId') AS TEXT),
           CAST(json_extract(value, '$.kind') AS TEXT),
           CAST(json_extract(value, '$.configJson') AS TEXT)
         FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)`,
      ).bind(upstreamId, payload, upstreamId, version),
    );
  }
  return stmts;
};

const buildSyncDisabledStatement = (
  db: SqlDatabase,
  upstreamId: string,
  version: number,
  disabledPublicModelIdsJson: string,
): SqlPreparedStatement =>
  db.prepare(
    `UPDATE upstream_models
     SET disabled = CASE
       WHEN model_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) THEN 1
       ELSE 0
     END
     WHERE upstream_id = ?
       AND EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)
       AND disabled != (
         CASE
           WHEN model_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) THEN 1
           ELSE 0
         END
       )`,
  ).bind(disabledPublicModelIdsJson, upstreamId, upstreamId, version, disabledPublicModelIdsJson);

const cacheSetClause = (action: UpstreamModelsCacheAction): { sql: string; binds: SqlBindValue[] } => {
  switch (action.kind) {
  case 'preserve':
    return { sql: '', binds: [] };
  case 'mark-stale':
    return {
      sql: ', models_cache_revision = NULL, models_cache_error_message = NULL, models_cache_error_at = NULL, models_cache_failure_count = 0',
      binds: [],
    };
  case 'clear-cache':
    return {
      sql: ', models_cache_revision = NULL, models_cache_fetched_at = NULL, models_cache_error_message = NULL, models_cache_error_at = NULL, models_cache_failure_count = 0',
      binds: [],
    };
  case 'set-fresh':
    return {
      sql: ', models_cache_revision = ?, models_cache_fetched_at = ?, models_cache_error_message = NULL, models_cache_error_at = NULL, models_cache_failure_count = 0',
      binds: [action.revision, action.fetchedAt],
    };
  }
};

const appendChildWriteStatements = (
  db: SqlDatabase,
  upstreamId: string,
  version: number,
  manualModels: readonly UpstreamModelConfig[] | undefined,
  modelsWrite: UpstreamModelsWritePayload | undefined,
  syncDisabledJson?: string,
): SqlPreparedStatement[] => {
  const stmts: SqlPreparedStatement[] = [];
  if (manualModels !== undefined) {
    stmts.push(...buildManualModelsReplacementStatements(db, upstreamId, version, manualModels));
  }
  if (modelsWrite?.models !== undefined) {
    stmts.push(...buildModelsReplacementStatements(db, upstreamId, version, modelsWrite.models));
  } else if (syncDisabledJson !== undefined) {
    stmts.push(buildSyncDisabledStatement(db, upstreamId, version, syncDisabledJson));
  }
  return stmts;
};

// Random 48-bit positive integer (well within JS Number.MAX_SAFE_INTEGER and
// SQLite signed 64-bit INTEGER). Non-sequential versions guarantee that two
// concurrent writers starting from the same `version` never choose the same
// target version, so a losing writer's child statements in a D1 `batch()`
// (`WHERE EXISTS (SELECT 1 FROM upstreams WHERE id = ? AND version = ?)`)
// match 0 rows and leave the winning writer's child rows intact.
const nextRowVersion = (previous?: number): number => {
  const bytes = new Uint32Array(2);
  let candidate: number;
  do {
    crypto.getRandomValues(bytes);
    candidate = (bytes[0]! & 0xFFFF) * 0x1_0000_0000 + bytes[1]!;
  } while (candidate === 0 || candidate === previous);
  return candidate;
};

export class SqlUpstreamRepo implements UpstreamRepo {
  constructor(private readonly db: SqlDatabase) {}

  async list(): Promise<StoredUpstreamRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT ${UPSTREAM_COLUMNS} FROM upstreams ORDER BY sort_order, created_at, id`)
      .all<UpstreamRow>();
    return results.map(toUpstreamRecord);
  }

  async listIds(): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT id FROM upstreams ORDER BY sort_order, created_at, id')
      .all<{ id: string }>();
    return results.map(row => row.id);
  }

  async listMeta(): Promise<StoredUpstreamMeta[]> {
    const { results } = await this.db
      .prepare(`SELECT ${UPSTREAM_META_COLUMNS} FROM upstreams ORDER BY sort_order, created_at, id`)
      .all<UpstreamMetaRow>();
    return results.map(toUpstreamMeta);
  }

  async getMetaByIds(ids: readonly string[]): Promise<StoredUpstreamMeta[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const { results } = await this.db
      .prepare(
        `SELECT ${UPSTREAM_META_COLUMNS}
         FROM upstreams
         WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         ORDER BY sort_order, created_at, id`,
      )
      .bind(JSON.stringify(uniqueIds))
      .all<UpstreamMetaRow>();
    return results.map(toUpstreamMeta);
  }

  async getById(id: string): Promise<StoredUpstreamRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${UPSTREAM_COLUMNS} FROM upstreams WHERE id = ?`)
      .bind(id)
      .first<UpstreamRow>();
    return row ? toUpstreamRecord(row) : null;
  }

  async listDueModelsRefresh(revision: number, nowMs: number): Promise<DueModelsRefreshCandidate[]> {
    const staleBefore = nowMs - AUTOMATIC_REFRESH_INTERVAL_MS;
    const { results } = await this.db
      .prepare(
        `SELECT
           id,
           version,
           proxy_fallback_list_json,
           CASE
             WHEN kind = 'azure' THEN 0
             WHEN kind = 'custom' AND coalesce(json_extract(config_json, '$.modelsFetch.enabled'), 1) = 0 THEN 0
             ELSE 1
           END AS requires_network
         FROM upstreams
         WHERE enabled = 1
           AND (
             models_cache_revision IS NOT ?
             OR models_cache_fetched_at IS NULL
             OR (
               kind != 'azure'
               AND NOT (kind = 'custom' AND coalesce(json_extract(config_json, '$.modelsFetch.enabled'), 1) = 0)
               AND models_cache_fetched_at <= ?
             )
           )
           AND (
             models_cache_failure_count = 0
             OR models_cache_error_at + ${BACKOFF_DELAY_SQL} <= ?
           )
         ORDER BY sort_order, created_at, id`,
      )
      .bind(revision, staleBefore, nowMs)
      .all<{
      id: string;
      version: number;
      proxy_fallback_list_json: string;
      requires_network: number;
    }>();
    return results.map(row => ({
      id: row.id,
      version: row.version,
      proxyFallbackList: normalizeProxyFallbackList(decodeProxyFallbackList(row.proxy_fallback_list_json, row.id)),
      requiresNetwork: row.requires_network !== 0,
    }));
  }

  async reorder(
    expectedIds: readonly string[],
    assignments: readonly { id: string; sortOrder: number }[],
  ): Promise<StoredUpstreamMeta[] | null> {
    const assignmentIds = assignments.map(assignment => assignment.id);
    if (new Set(assignmentIds).size !== assignmentIds.length || assignmentIds.some(id => !expectedIds.includes(id))) return null;
    const { results } = await this.db.prepare(
      `WITH current_ids AS MATERIALIZED (
         SELECT id FROM upstreams ORDER BY sort_order, created_at, id
       ), valid_order AS MATERIALIZED (
         SELECT json_group_array(id) = ? AS valid FROM current_ids
       ), assignments AS MATERIALIZED (
         SELECT
           CAST(json_extract(value, '$.id') AS TEXT) AS id,
           CAST(json_extract(value, '$.sortOrder') AS INTEGER) AS sort_order
         FROM json_each(?)
       )
       UPDATE upstreams SET
         sort_order = (SELECT sort_order FROM assignments WHERE assignments.id = upstreams.id),
         updated_at = ?,
         version = ?
       WHERE id IN (SELECT id FROM assignments) AND (SELECT valid FROM valid_order)
       RETURNING ${UPSTREAM_META_COLUMNS}`,
    ).bind(JSON.stringify(expectedIds), JSON.stringify(assignments), new Date().toISOString(), nextRowVersion()).all<UpstreamMetaRow>();
    if (results.length !== assignments.length) return null;
    const byId = new Map(results.map(row => [row.id, toUpstreamMeta(row)]));
    return assignments.map(({ id }) => byId.get(id)!);
  }

  private async insertInternal(
    mode: 'explicit' | 'end',
    input: UpstreamInsertInput,
  ): Promise<StoredUpstreamRecord | null> {
    const { upstream, manualModels, modelsWrite } = input;
    const version = nextRowVersion();
    const prefix = encodeModelPrefixColumns(upstream.modelPrefix);
    const cacheAction = modelsWrite?.cacheAction ?? { kind: 'preserve' as const };
    const revision = cacheAction.kind === 'set-fresh' ? cacheAction.revision : null;
    const fetchedAt = cacheAction.kind === 'set-fresh' ? cacheAction.fetchedAt : null;

    const sortOrderSql = mode === 'end'
      ? '(SELECT coalesce(max(sort_order), -1) + 1 FROM upstreams)'
      : '?';
    const baseBinds: SqlBindValue[] = [
      upstream.id,
      upstream.kind,
      upstream.name,
      sqliteBoolean(upstream.enabled),
      upstream.usageRefreshIntervalMinutes,
      ...(mode === 'explicit' ? [upstream.sortOrder] : []),
      upstream.createdAt,
      upstream.updatedAt,
      version,
      serializeStoredConfig(upstream.config),
      serializeStoredState(upstream.state),
      JSON.stringify(normalizeFlagOverrides(upstream.flagOverrides)),
      JSON.stringify(normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds)),
      JSON.stringify(normalizeProxyFallbackList(upstream.proxyFallbackList)),
      prefix.prefix,
      prefix.addressable,
      prefix.listed,
      revision,
      fetchedAt,
      upstream.hue,
    ];

    const insertStmt = this.db
      .prepare(
        `INSERT INTO upstreams (
           id, kind, name, enabled, usage_refresh_interval_minutes, sort_order,
           created_at, updated_at, version,
           config_json, state_json, flag_overrides, disabled_public_model_ids, proxy_fallback_list_json,
           model_prefix, model_prefix_addressable, model_prefix_listed,
           models_cache_revision, models_cache_fetched_at,
           models_cache_error_message, models_cache_error_at, models_cache_failure_count,
           hue
         ) VALUES (
           ?, ?, ?, ?, ?, ${sortOrderSql},
           ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?,
           NULL, NULL, 0,
           ?
         ) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(...baseBinds);

    const stmts = [
      insertStmt,
      ...appendChildWriteStatements(this.db, upstream.id, version, manualModels, modelsWrite),
    ];
    const results = await runStatements(this.db, stmts);
    if (requireChanges(results[0], `upstreams.insert(${upstream.id})`) === 0) return null;
    return await this.getById(upstream.id);
  }

  async insertAtEnd(input: UpstreamInsertInput): Promise<StoredUpstreamRecord | null> {
    return await this.insertInternal('end', input);
  }

  async insert(input: UpstreamInsertInput): Promise<StoredUpstreamRecord | null> {
    return await this.insertInternal('explicit', input);
  }

  async replace(input: {
    readonly previous: StoredUpstreamRecord;
    readonly upstream: UpstreamRecord;
    readonly replaceState?: boolean;
    readonly manualModels?: readonly UpstreamModelConfig[];
    readonly modelsWrite?: UpstreamModelsWritePayload;
  }): Promise<StoredUpstreamRecord | null> {
    const { previous, upstream, manualModels, modelsWrite } = input;
    const replaceState = input.replaceState ?? serializeStoredState(previous.state) !== serializeStoredState(upstream.state);
    const nextVersion = nextRowVersion(previous.version);
    const prefix = encodeModelPrefixColumns(upstream.modelPrefix);
    const cachePatch = cacheSetClause(modelsWrite?.cacheAction ?? { kind: 'preserve' });
    const prevDisabledJson = JSON.stringify(normalizeDisabledPublicModelIds(previous.disabledPublicModelIds));
    const nextDisabledJson = JSON.stringify(normalizeDisabledPublicModelIds(upstream.disabledPublicModelIds));
    const syncDisabledJson = prevDisabledJson !== nextDisabledJson ? nextDisabledJson : undefined;

    const updateStmt = this.db
      .prepare(
        `UPDATE upstreams SET
           kind = ?,
           name = ?,
           enabled = ?,
           usage_refresh_interval_minutes = ?,
           sort_order = ?,
           updated_at = ?,
           version = ?,
           config_json = ?,
           state_json = CASE WHEN ? THEN ? ELSE state_json END,
           flag_overrides = ?,
           disabled_public_model_ids = ?,
           proxy_fallback_list_json = ?,
           model_prefix = ?,
           model_prefix_addressable = ?,
           model_prefix_listed = ?,
           hue = ?${cachePatch.sql}
         WHERE id = ?
           AND version = ?`,
      )
      .bind(
        upstream.kind,
        upstream.name,
        sqliteBoolean(upstream.enabled),
        upstream.usageRefreshIntervalMinutes,
        upstream.sortOrder,
        upstream.updatedAt,
        nextVersion,
        serializeStoredConfig(upstream.config),
        sqliteBoolean(replaceState),
        serializeStoredState(upstream.state),
        JSON.stringify(normalizeFlagOverrides(upstream.flagOverrides)),
        nextDisabledJson,
        JSON.stringify(normalizeProxyFallbackList(upstream.proxyFallbackList)),
        prefix.prefix,
        prefix.addressable,
        prefix.listed,
        upstream.hue,
        ...cachePatch.binds,
        upstream.id,
        previous.version,
      );

    const stmts = [
      updateStmt,
      ...appendChildWriteStatements(this.db, upstream.id, nextVersion, manualModels, modelsWrite, syncDisabledJson),
    ];
    const results = await runStatements(this.db, stmts);
    if (requireChanges(results[0], `upstreams.replace(${upstream.id})`) === 0) return null;
    return await this.getById(upstream.id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.prepare('DELETE FROM upstreams WHERE id = ?').bind(id).run();
    return requireChanges(result, `upstreams.delete(${id})`) > 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM upstreams').run();
  }

  async publishModelsRefresh(input: ModelsRefreshSuccessInput): Promise<number | null> {
    const { id, version, revision, fetchedAt, models } = input;
    const nextVersion = nextRowVersion(version);
    const stmts: SqlPreparedStatement[] = [
      this.db
        .prepare(
          `UPDATE upstreams
           SET models_cache_revision = ?,
               models_cache_fetched_at = ?,
               models_cache_error_message = NULL,
               models_cache_error_at = NULL,
               models_cache_failure_count = 0,
               version = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(revision, fetchedAt, nextVersion, id, version),
      ...buildModelsReplacementStatements(this.db, id, nextVersion, models),
    ];
    const results = await runStatements(this.db, stmts);
    return requireChanges(results[0], `upstreams.publishModelsRefresh(${id})`) > 0 ? nextVersion : null;
  }

  async recordModelsRefreshFailure(input: ModelsRefreshFailureInput): Promise<boolean> {
    const { id, version, error } = input;
    const result = await this.db
      .prepare(
        `UPDATE upstreams
         SET models_cache_error_message = ?,
             models_cache_error_at = ?,
             models_cache_failure_count = models_cache_failure_count + 1
         WHERE id = ? AND version = ?`,
      )
      .bind(storedModelErrorMessage(error.message), error.at, id, version)
      .run();
    return requireChanges(result, `upstreams.recordModelsRefreshFailure(${id})`) > 0;
  }

  // Read-modify-write under optimistic concurrency, retried against the winner
  // on a loss. `IS` (not `=`) so a row whose state_json is SQL NULL still
  // matches. The predicate binds the exact text this method read rather than a
  // re-serialized form, so the CAS holds against a row written by anything —
  // including a migration, which has no way to reproduce the canonical
  // encoder's output.
  async saveState(id: string, mutate: (current: unknown, version: number) => unknown): Promise<void> {
    for (let attempt = 0; attempt < UPSTREAM_STATE_WRITE_ATTEMPTS; attempt++) {
      const row = await this.db
        .prepare('SELECT state_json, version FROM upstreams WHERE id = ?')
        .bind(id)
        .first<{ state_json: string | null; version: number }>();
      if (!row) throw new UpstreamGoneError(id);
      const current = row.state_json === null ? null : decodeUpstreamState(row.state_json, id);
      const next = serializeStoredState(mutate(current, row.version));
      if (next === row.state_json) return;
      const result = await this.db
        .prepare('UPDATE upstreams SET state_json = ? WHERE id = ? AND state_json IS ? AND version = ?')
        .bind(next, id, row.state_json, row.version)
        .run();
      if (requireChanges(result, `upstreams.saveState(${id})`) > 0) return;
    }
    throw new Error(`Upstream ${id} state write lost ${UPSTREAM_STATE_WRITE_ATTEMPTS} consecutive races`);
  }
}

interface PrefixLookupPair {
  readonly inputId: string;
  readonly prefix: string;
  readonly rest: string;
}

const extractPrefixPairs = (modelIds: readonly string[]): PrefixLookupPair[] => {
  const pairs: PrefixLookupPair[] = [];
  for (const inputId of modelIds) {
    for (let idx = inputId.indexOf('/'); idx !== -1 && idx + 1 <= MODEL_PREFIX_MAX_LENGTH; idx = inputId.indexOf('/', idx + 1)) {
      const prefix = inputId.slice(0, idx + 1);
      const rest = inputId.slice(idx + 1);
      if (rest.length > 0) pairs.push({ inputId, prefix, rest });
    }
  }
  return pairs;
};

interface ResolvedRow extends UpstreamRow {
  form_order: number;
  matched_input_id: string;
  matched_model_json: string;
}

export class SqlUpstreamModelsRepo implements UpstreamModelsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async resolve(input: {
    readonly modelIds: readonly string[];
    readonly upstreamIds: readonly string[] | null;
  }): Promise<ResolvedUpstreamModelMatch[]> {
    const modelIds = [...new Set(input.modelIds.filter(id => id.length > 0))];
    if (modelIds.length === 0) return [];
    if (input.upstreamIds !== null && input.upstreamIds.length === 0) return [];

    const prefixPairs = extractPrefixPairs(modelIds);
    const hasUpstreamFilter = input.upstreamIds !== null;
    const upstreamFilterJson = hasUpstreamFilter ? JSON.stringify(input.upstreamIds) : null;

    const binds: SqlBindValue[] = [];
    const unprefixedPredicate = modelIds.length === 1
      ? 'm.model_id = ?'
      : 'm.model_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))';
    binds.push(modelIds.length === 1 ? modelIds[0]! : JSON.stringify(modelIds));

    const upstreamFilterSql = hasUpstreamFilter
      ? ' AND u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))'
      : '';
    if (hasUpstreamFilter) binds.push(upstreamFilterJson!);

    const unprefixedArm = `
      SELECT
        0 AS form_order,
        m.kind AS matched_kind,
        m.model_id AS matched_input_id,
        m.model_json AS matched_model_json,
        ${UPSTREAM_COLUMNS_ALIASED}
      FROM upstream_models m
      JOIN upstreams u ON u.id = m.upstream_id
      WHERE ${unprefixedPredicate}
        AND m.disabled = 0
        AND u.enabled = 1
        AND (u.model_prefix IS NULL OR u.model_prefix_addressable IN ('unprefixed', 'both'))${upstreamFilterSql}`;

    let query: string;
    if (prefixPairs.length === 0) {
      query = `${unprefixedArm} ORDER BY u.sort_order, u.created_at, u.id, m.kind`;
    } else {
      binds.push(JSON.stringify(prefixPairs));
      if (hasUpstreamFilter) binds.push(upstreamFilterJson!);
      const prefixedArm = `
        SELECT
          1 AS form_order,
          m.kind AS matched_kind,
          p.input_id AS matched_input_id,
          m.model_json AS matched_model_json,
          ${UPSTREAM_COLUMNS_ALIASED}
        FROM (
          SELECT
            CAST(json_extract(value, '$.inputId') AS TEXT) AS input_id,
            CAST(json_extract(value, '$.prefix') AS TEXT) AS prefix,
            CAST(json_extract(value, '$.rest') AS TEXT) AS rest
          FROM json_each(?)
        ) p
        JOIN upstreams u
          ON u.model_prefix IS NOT NULL
         AND u.model_prefix = p.prefix
         AND u.enabled = 1
         AND u.model_prefix_addressable IN ('prefixed', 'both')
        JOIN upstream_models m
          ON m.upstream_id = u.id
         AND m.model_id = p.rest
         AND m.disabled = 0
        WHERE 1 = 1${upstreamFilterSql}`;

      query = `
        SELECT * FROM (
          ${unprefixedArm}
          UNION ALL
          ${prefixedArm}
        )
        ORDER BY sort_order, created_at, id, matched_kind, form_order`;
    }

    const { results } = await this.db.prepare(query).bind(...binds).all<ResolvedRow>();

    const upstreamsById = new Map<string, StoredUpstreamRecord>();
    const matches: ResolvedUpstreamModelMatch[] = results.map(row => {
      let upstream = upstreamsById.get(row.id);
      if (upstream === undefined) {
        upstream = toUpstreamRecord(row);
        upstreamsById.set(row.id, upstream);
      }
      return {
        matchedInputId: row.matched_input_id,
        matchedForm: row.form_order === 0 ? 'unprefixed' : 'prefixed',
        upstream,
        model: decodeUpstreamModel(row.matched_model_json, row.id),
      };
    });

    if (input.upstreamIds !== null) {
      const rank = new Map(input.upstreamIds.map((id, index) => [id, index] as const));
      matches.sort((a, b) =>
        (rank.get(a.upstream.id)! - rank.get(b.upstream.id)!)
        || ((a.matchedForm === 'unprefixed' ? 0 : 1) - (b.matchedForm === 'unprefixed' ? 0 : 1)));
    }
    return matches;
  }

  async listCatalog(filter: UpstreamCatalogFilter | null): Promise<{
    readonly upstreams: CatalogUpstreamRow[];
    readonly modelsByUpstream: Map<string, UpstreamModel[]>;
  }> {
    const include = filter?.include;
    const exclude = filter?.exclude;
    if (include?.length === 0) {
      return { upstreams: [], modelsByUpstream: new Map() };
    }
    const filterClauses: string[] = [];
    const filterBinds: SqlBindValue[] = [];
    if (include !== undefined) {
      filterClauses.push(' AND u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))');
      filterBinds.push(JSON.stringify(include));
    }
    if (exclude !== undefined && exclude.length > 0) {
      filterClauses.push(' AND u.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))');
      filterBinds.push(JSON.stringify(exclude));
    }
    const filterSql = filterClauses.join('');

    const [upstreamsRes, modelsRes] = await Promise.all([
      this.db
        .prepare(
          `SELECT
             u.id, u.kind, u.name, u.hue,
             u.model_prefix, u.model_prefix_addressable, u.model_prefix_listed
           FROM upstreams u
           WHERE u.enabled = 1${filterSql}
           ORDER BY u.sort_order, u.created_at, u.id`,
        )
        .bind(...filterBinds)
        .all<{
        id: string;
        kind: string;
        name: string;
        hue: number;
        model_prefix: string | null;
        model_prefix_addressable: string | null;
        model_prefix_listed: string | null;
      }>(),
      this.db
        .prepare(
          `SELECT m.upstream_id, m.model_json
           FROM upstream_models m
           JOIN upstreams u ON u.id = m.upstream_id
           WHERE u.enabled = 1
             AND m.disabled = 0${filterSql}`,
        )
        .bind(...filterBinds)
        .all<{ upstream_id: string; model_json: string }>(),
    ]);

    const upstreams: CatalogUpstreamRow[] = upstreamsRes.results.map(row => ({
      id: row.id,
      kind: parseUpstreamKind(row.id, row.kind),
      name: row.name,
      hue: parseUpstreamHue(row.id, row.hue),
      modelPrefix: parseModelPrefixColumns(row.id, row.model_prefix, row.model_prefix_addressable, row.model_prefix_listed),
    }));

    if (include !== undefined && filter?.preserveIncludeOrder === true) {
      const rank = new Map(include.map((id, index) => [id, index] as const));
      upstreams.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    }

    // Keep the SQL query free of an ORDER BY temp B-tree; only sort an
    // upstream's slice by `kind` in the rare case it has duplicate `model.id`s.
    const modelsByUpstream = new Map<string, UpstreamModel[]>();
    const seenIdsByUpstream = new Map<string, Set<string>>();
    const upstreamsToSort = new Set<string>();
    for (const row of modelsRes.results) {
      const model = decodeUpstreamModel(row.model_json, row.upstream_id);
      let list = modelsByUpstream.get(row.upstream_id);
      let seen = seenIdsByUpstream.get(row.upstream_id);
      if (list === undefined) {
        list = [];
        seen = new Set();
        modelsByUpstream.set(row.upstream_id, list);
        seenIdsByUpstream.set(row.upstream_id, seen);
      }
      if (seen!.has(model.id)) upstreamsToSort.add(row.upstream_id);
      else seen!.add(model.id);
      list.push(model);
    }
    for (const upstreamId of upstreamsToSort) {
      modelsByUpstream.get(upstreamId)!.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    }

    return { upstreams, modelsByUpstream };
  }

  async listAddressableIdsForUpstreams(upstreamIds: readonly string[]): Promise<{
    readonly upstreamId: string;
    readonly addressableId: string;
  }[]> {
    const uniqueIds = [...new Set(upstreamIds)];
    if (uniqueIds.length === 0) return [];
    const { results } = await this.db
      .prepare(
        `SELECT DISTINCT
           m.upstream_id,
           m.model_id,
           u.model_prefix,
           u.model_prefix_addressable
         FROM upstream_models m
         JOIN upstreams u ON u.id = m.upstream_id
         WHERE u.enabled = 1
           AND m.disabled = 0
           AND u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      )
      .bind(JSON.stringify(uniqueIds))
      .all<{
      upstream_id: string;
      model_id: string;
      model_prefix: string | null;
      model_prefix_addressable: string | null;
    }>();

    const out: { readonly upstreamId: string; readonly addressableId: string }[] = [];
    for (const row of results) {
      if (row.model_prefix === null) {
        out.push({ upstreamId: row.upstream_id, addressableId: row.model_id });
        continue;
      }
      if (row.model_prefix_addressable === 'unprefixed' || row.model_prefix_addressable === 'both') {
        out.push({ upstreamId: row.upstream_id, addressableId: row.model_id });
      }
      if (row.model_prefix_addressable === 'prefixed' || row.model_prefix_addressable === 'both') {
        out.push({ upstreamId: row.upstream_id, addressableId: `${row.model_prefix}${row.model_id}` });
      }
    }
    return out;
  }

  async countListedByUpstream(upstreamIds?: readonly string[]): Promise<Map<string, number | null>> {
    if (upstreamIds?.length === 0) return new Map();
    const whereSql = upstreamIds !== undefined
      ? ' WHERE u.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))'
      : '';
    const binds: SqlBindValue[] = upstreamIds !== undefined ? [JSON.stringify([...new Set(upstreamIds)])] : [];
    const { results } = await this.db
      .prepare(
        `SELECT
           u.id,
           u.models_cache_fetched_at,
           u.model_prefix,
           u.model_prefix_listed,
           (
             SELECT COUNT(DISTINCT m.model_id)
             FROM upstream_models m
             WHERE m.upstream_id = u.id
               AND m.disabled = 0
           ) AS active_model_count
         FROM upstreams u${whereSql}`,
      )
      .bind(...binds)
      .all<{
      id: string;
      models_cache_fetched_at: number | null;
      model_prefix: string | null;
      model_prefix_listed: string | null;
      active_model_count: number;
    }>();

    const counts = new Map<string, number | null>();
    for (const row of results) {
      counts.set(
        row.id,
        row.models_cache_fetched_at === null
          ? null
          : row.active_model_count * listedMultiplier(row.model_prefix, row.model_prefix_listed),
      );
    }
    return counts;
  }

  async listByUpstream(
    upstreamId: string,
    options?: { readonly source?: UpstreamModelSource },
  ): Promise<UpstreamModelEntry[]> {
    const sourceFilter = options?.source !== undefined ? ' AND source = ?' : '';
    const binds: SqlBindValue[] = options?.source !== undefined ? [upstreamId, options.source] : [upstreamId];
    const { results } = await this.db
      .prepare(
        `SELECT source, model_json
         FROM upstream_models
         WHERE upstream_id = ?${sourceFilter}
         ORDER BY kind, model_id`,
      )
      .bind(...binds)
      .all<{ source: UpstreamModelSource; model_json: string }>();
    return results.map(row => ({
      source: row.source,
      model: decodeUpstreamModel(row.model_json, upstreamId),
    }));
  }

  async getByKey(upstreamId: string, modelId: string, kind: ModelKind): Promise<UpstreamModel | null> {
    const row = await this.db
      .prepare('SELECT model_json FROM upstream_models WHERE upstream_id = ? AND model_id = ? AND kind = ?')
      .bind(upstreamId, modelId, kind)
      .first<{ model_json: string }>();
    return row ? decodeUpstreamModel(row.model_json, upstreamId) : null;
  }

  async listManualModels(upstreamId: string): Promise<UpstreamModelConfig[]> {
    const { results } = await this.db
      .prepare('SELECT config_json FROM upstream_manual_models WHERE upstream_id = ? ORDER BY position')
      .bind(upstreamId)
      .all<{ config_json: string }>();
    return results.map(row => decodeUpstreamManualModel(row.config_json, upstreamId));
  }

  async listManualModelsByUpstreams(upstreamIds: readonly string[]): Promise<Map<string, UpstreamModelConfig[]>> {
    const uniqueIds = [...new Set(upstreamIds)];
    const map = new Map<string, UpstreamModelConfig[]>(uniqueIds.map(id => [id, []]));
    if (uniqueIds.length === 0) return map;
    const { results } = await this.db
      .prepare(
        `SELECT upstream_id, config_json
         FROM upstream_manual_models
         WHERE upstream_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         ORDER BY upstream_id, position`,
      )
      .bind(JSON.stringify(uniqueIds))
      .all<{ upstream_id: string; config_json: string }>();
    for (const row of results) {
      map.get(row.upstream_id)!.push(decodeUpstreamManualModel(row.config_json, row.upstream_id));
    }
    return map;
  }
}
