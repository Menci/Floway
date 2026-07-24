import { assertSameStoredResponsesItem, scopedResponsesKey } from './responses-clone.ts';
import { hashResponsesJson } from './responses-hash.ts';
import {
  prepareStoredResponsesPayload,
  writePreparedStoredResponsesPayload,
  parseStoredResponsesPayload,
  type PreparedStoredResponsesPayload,
} from './responses-payload.ts';
import { quantizeResponsesRefreshedAt, RESPONSES_REFRESH_GRANULARITY_MS } from './responses-retention.ts';
import type {
  ResponsesItemsRepo,
  ResponsesSnapshotsRepo,
  SpilledFilesRepo,
  StoredResponsesItem,
  StoredResponsesSnapshot,
} from './types.ts';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

const RESPONSES_ITEM_COLUMNS = 'id, api_key_id, payload_json, item_hash, payload_hash, payload_file_key, refreshed_at';
const RESPONSES_IN_QUERY_CHUNK_SIZE = 80;
const RESPONSES_INSERT_CHUNK_SIZE = 14;
const RESPONSES_REFRESH_CHUNK_SIZE = 45;
const FILE_STAGE_GRACE_MS = 60 * 60 * 1000;

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

const uniqueResponsesItems = (items: readonly StoredResponsesItem[]): StoredResponsesItem[] => {
  const unique = new Map<string, StoredResponsesItem>();
  for (const source of items) {
    const item = { ...source, refreshedAt: quantizeResponsesRefreshedAt(source.refreshedAt) };
    const key = scopedResponsesKey(item.apiKeyId, item.id);
    const existing = unique.get(key);
    if (existing === undefined) unique.set(key, item);
    else assertSameStoredResponsesItem(item, existing);
  }
  return [...unique.values()];
};

interface ResponsesItemRow {
  id: string;
  api_key_id: string;
  payload_json: string;
  item_hash: string;
  payload_hash: string;
  payload_file_key: string | null;
  refreshed_at: number;
}

const toStoredResponsesItem = async (row: ResponsesItemRow): Promise<StoredResponsesItem> => ({
  id: row.id,
  apiKeyId: row.api_key_id,
  payload: await parseStoredResponsesPayload(row.id, row.payload_json, row.payload_file_key),
  itemHash: row.item_hash,
  refreshedAt: row.refreshed_at,
});

interface PreparedResponsesItem {
  item: StoredResponsesItem;
  payload: PreparedStoredResponsesPayload;
  payloadHash: string;
}

export class SqlResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async lookupMany(apiKeyId: string, ids: readonly string[], minimumRefreshedAt: number): Promise<StoredResponsesItem[]> {
    const rows = await this.lookupByColumn(apiKeyId, 'id', ids, minimumRefreshedAt);
    const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async lookupManyByItemHash(apiKeyId: string, hashes: readonly string[], minimumRefreshedAt: number): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'item_hash', hashes, minimumRefreshedAt);
  }

  private async lookupByColumn(
    apiKeyId: string,
    column: 'id' | 'item_hash',
    values: readonly string[],
    minimumRefreshedAt: number,
  ): Promise<StoredResponsesItem[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];
    const queries: Promise<SqlResult<ResponsesItemRow>>[] = [];
    for (let index = 0; index < unique.length; index += RESPONSES_IN_QUERY_CHUNK_SIZE) {
      const chunk = unique.slice(index, index + RESPONSES_IN_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const orderSql = column === 'item_hash' ? ' ORDER BY refreshed_at DESC, id ASC' : '';
      queries.push(this.db
        .prepare(
          `SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items
           WHERE api_key_id = ? AND refreshed_at >= ? AND ${column} IN (${placeholders})${orderSql}`,
        )
        .bind(apiKeyId, minimumRefreshedAt, ...chunk)
        .all<ResponsesItemRow>());
    }
    const rows = (await Promise.all(queries)).flatMap(result => result.results);
    const hydrated = await mapSequentially(rows, async row => await this.hydrateCurrentItem(row, minimumRefreshedAt));
    const wanted = new Set(unique);
    return hydrated.flatMap(item =>
      item !== null && (column === 'id' ? wanted.has(item.id) : wanted.has(item.itemHash))
        ? [item]
        : []);
  }

  private async hydrateCurrentItem(initialRow: ResponsesItemRow, minimumRefreshedAt: number): Promise<StoredResponsesItem | null> {
    let row = initialRow;
    for (;;) {
      try {
        return await toStoredResponsesItem(row);
      } catch (error) {
        const current = await this.db
          .prepare(
            `SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items
             WHERE id = ? AND api_key_id = ? AND refreshed_at >= ?`,
          )
          .bind(row.id, row.api_key_id, minimumRefreshedAt)
          .first<ResponsesItemRow>();
        if (current === null) return null;
        if (current.payload_json === row.payload_json && current.payload_file_key === row.payload_file_key) throw error;
        row = current;
      }
    }
  }

  async insertMany(items: readonly StoredResponsesItem[], minimumRefreshedAt: number, policyAt: number): Promise<void> {
    const unique = uniqueResponsesItems(items);
    const existing = await this.lookupExistingItems(unique, minimumRefreshedAt);
    for (const item of unique) {
      const actual = existing.get(scopedResponsesKey(item.apiKeyId, item.id));
      if (actual !== undefined) assertSameStoredResponsesItem(item, actual);
    }

    const pending = unique.filter(item => !existing.has(scopedResponsesKey(item.apiKeyId, item.id)));
    const prepared = await mapSequentially(pending, async item => ({
      item,
      payload: await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.payload),
      payloadHash: await hashResponsesJson(item.payload),
    }));
    await this.stageFiles(prepared);
    for (const entry of prepared) await writePreparedStoredResponsesPayload(entry.payload);

    const statements: SqlPreparedStatement[] = [];
    for (let index = 0; index < prepared.length; index += RESPONSES_INSERT_CHUNK_SIZE) {
      const chunk = prepared.slice(index, index + RESPONSES_INSERT_CHUNK_SIZE);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(this.db
        .prepare(
          `WITH incoming (${RESPONSES_ITEM_COLUMNS}) AS (VALUES ${values})
           INSERT INTO responses_items (${RESPONSES_ITEM_COLUMNS})
           SELECT incoming.* FROM incoming
           JOIN api_keys ON api_keys.id = incoming.api_key_id
             AND api_keys.deleted_at IS NULL
             AND api_keys.responses_retention_seconds > 0
           WHERE true
           ON CONFLICT (id, api_key_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             item_hash = excluded.item_hash,
             payload_hash = excluded.payload_hash,
             payload_file_key = excluded.payload_file_key,
             refreshed_at = excluded.refreshed_at
           WHERE responses_items.refreshed_at < ?
             AND NOT EXISTS (
               SELECT 1 FROM api_keys
               WHERE api_keys.id = excluded.api_key_id
                 AND api_keys.deleted_at IS NULL
                 AND api_keys.responses_retention_seconds > 0
                 AND responses_items.refreshed_at >= ? - api_keys.responses_retention_seconds * 1000
             )`,
        )
        .bind(
          ...chunk.flatMap(({ item, payload, payloadHash }) => [
            item.id,
            item.apiKeyId,
            payload.payloadJson,
            item.itemHash,
            payloadHash,
            payload.file?.key ?? null,
            item.refreshedAt,
          ]),
          minimumRefreshedAt,
          policyAt - RESPONSES_REFRESH_GRANULARITY_MS,
        ));
    }
    await runStatements(this.db, statements);

    const persisted = await this.lookupCurrentPolicyItems(unique, 0, policyAt);
    for (const item of unique) {
      const actual = persisted.get(scopedResponsesKey(item.apiKeyId, item.id));
      if (actual === undefined) throw new Error(`Responses item disappeared after insert: ${item.id}`);
      assertSameStoredResponsesItem(item, actual);
    }
    const refreshGroups = Map.groupBy(unique.filter(item => {
      const actual = persisted.get(scopedResponsesKey(item.apiKeyId, item.id))!;
      return actual.refreshedAt < item.refreshedAt;
    }), item => item.refreshedAt);
    for (const [refreshedAt, group] of refreshGroups) {
      await this.refreshMany(group, refreshedAt, 0, policyAt);
    }
  }

  private async stageFiles(prepared: readonly PreparedResponsesItem[]): Promise<void> {
    const files = prepared.flatMap(({ item, payload }) => payload.file === null
      ? []
      : [{ fileKey: payload.file.key, apiKeyId: item.apiKeyId, itemId: item.id }]);
    if (files.length === 0) return;
    await this.db
      .prepare(
        `INSERT INTO spilled_files (file_key, owner_kind, owner_key, state, collect_after)
         SELECT
           json_extract(value, '$.fileKey'),
           'responses-item',
           json_array(json_extract(value, '$.apiKeyId'), json_extract(value, '$.itemId')),
           'staged',
           ?
         FROM json_each(?)`,
      )
      .bind(Date.now() + FILE_STAGE_GRACE_MS, JSON.stringify(files))
      .run();
  }

  private async lookupExistingItems(
    items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[],
    minimumRefreshedAt: number,
  ): Promise<Map<string, StoredResponsesItem>> {
    const idsByApiKey = Map.groupBy(items, item => item.apiKeyId);
    const rows = (await Promise.all([...idsByApiKey].map(async ([apiKeyId, scoped]) =>
      await this.lookupMany(apiKeyId, scoped.map(item => item.id), minimumRefreshedAt)))).flat();
    return new Map(rows.map(item => [scopedResponsesKey(item.apiKeyId, item.id), item]));
  }

  async refreshMany(
    items: readonly StoredResponsesItem[],
    refreshedAt: number,
    minimumRefreshedAt: number,
    policyAt: number,
  ): Promise<void> {
    const quantizedRefreshedAt = quantizeResponsesRefreshedAt(refreshedAt);
    const idsByApiKey = Map.groupBy(
      [...new Map(items.map(item => [scopedResponsesKey(item.apiKeyId, item.id), item])).values()],
      item => item.apiKeyId,
    );
    const statements: SqlPreparedStatement[] = [];
    for (const [apiKeyId, scoped] of idsByApiKey) {
      const expected = await mapSequentially(scoped, async item => ({
        item,
        payloadHash: await hashResponsesJson(item.payload),
      }));
      for (let index = 0; index < expected.length; index += RESPONSES_REFRESH_CHUNK_SIZE) {
        const chunk = expected.slice(index, index + RESPONSES_REFRESH_CHUNK_SIZE);
        const values = chunk.map(() => '(?, ?)').join(', ');
        statements.push(this.db
          .prepare(
            `WITH expected (id, payload_hash) AS (VALUES ${values})
             UPDATE responses_items SET refreshed_at = ?
             WHERE api_key_id = ?
               AND refreshed_at >= ?
               AND refreshed_at < ?
               AND EXISTS (
                 SELECT 1 FROM api_keys
                 WHERE api_keys.id = responses_items.api_key_id
                   AND api_keys.deleted_at IS NULL
                   AND api_keys.responses_retention_seconds > 0
                   AND responses_items.refreshed_at >= ? - api_keys.responses_retention_seconds * 1000
               )
               AND EXISTS (
                 SELECT 1 FROM expected
                 WHERE expected.id = responses_items.id
                   AND expected.payload_hash = responses_items.payload_hash
               )`,
          )
          .bind(
            ...chunk.flatMap(({ item, payloadHash }) => [item.id, payloadHash]),
            quantizedRefreshedAt,
            apiKeyId,
            minimumRefreshedAt,
            quantizedRefreshedAt,
            policyAt - RESPONSES_REFRESH_GRANULARITY_MS,
          ));
      }
    }
    await runStatements(this.db, statements);
    const persisted = await this.lookupCurrentPolicyItems(items, minimumRefreshedAt, policyAt);
    const missing = items.find(item => !persisted.has(scopedResponsesKey(item.apiKeyId, item.id)));
    if (missing !== undefined) throw new Error(`Responses item disappeared before lifetime refresh: ${missing.id}`);
    for (const item of items) {
      assertSameStoredResponsesItem(item, persisted.get(scopedResponsesKey(item.apiKeyId, item.id))!);
    }
  }

  private async lookupCurrentPolicyItems(
    items: readonly StoredResponsesItem[],
    minimumRefreshedAt: number,
    policyAt: number,
  ): Promise<Map<string, StoredResponsesItem>> {
    const idsByApiKey = Map.groupBy(items, item => item.apiKeyId);
    const rows: StoredResponsesItem[] = [];
    for (const [apiKeyId, scoped] of idsByApiKey) {
      const ids = [...new Set(scoped.map(item => item.id))];
      for (let index = 0; index < ids.length; index += RESPONSES_IN_QUERY_CHUNK_SIZE) {
        const chunk = ids.slice(index, index + RESPONSES_IN_QUERY_CHUNK_SIZE);
        const { results } = await this.db
          .prepare(
            `SELECT
               responses_items.id,
               responses_items.api_key_id,
               responses_items.payload_json,
               responses_items.item_hash,
               responses_items.payload_hash,
               responses_items.payload_file_key,
               responses_items.refreshed_at
             FROM responses_items
             JOIN api_keys ON api_keys.id = responses_items.api_key_id
             WHERE responses_items.api_key_id = ?
               AND api_keys.deleted_at IS NULL
               AND api_keys.responses_retention_seconds > 0
               AND responses_items.refreshed_at >= ?
               AND responses_items.refreshed_at >= ? - api_keys.responses_retention_seconds * 1000
               AND responses_items.id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .bind(apiKeyId, minimumRefreshedAt, policyAt - RESPONSES_REFRESH_GRANULARITY_MS, ...chunk)
          .all<ResponsesItemRow>();
        rows.push(...await mapSequentially(results, async row => await toStoredResponsesItem(row)));
      }
    }
    return new Map(rows.map(item => [scopedResponsesKey(item.apiKeyId, item.id), item]));
  }

  async deleteExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM responses_items
         WHERE NOT EXISTS (
           SELECT 1 FROM api_keys
           WHERE api_keys.id = responses_items.api_key_id
             AND api_keys.deleted_at IS NULL
             AND api_keys.responses_retention_seconds > 0
             AND responses_items.refreshed_at >= ? - api_keys.responses_retention_seconds * 1000
         )`,
      )
      .bind(now - RESPONSES_REFRESH_GRANULARITY_MS)
      .run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_items').run();
  }
}

interface ResponsesSnapshotRow {
  id: string;
  api_key_id: string;
  item_ids_json: string;
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
    refreshedAt: row.refreshed_at,
  };
};

export class SqlResponsesSnapshotsRepo implements ResponsesSnapshotsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async lookup(apiKeyId: string, id: string, minimumRefreshedAt: number): Promise<StoredResponsesSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT id, api_key_id, item_ids_json, refreshed_at FROM responses_snapshots
         WHERE id = ? AND api_key_id = ? AND refreshed_at >= ?`,
      )
      .bind(id, apiKeyId, minimumRefreshedAt)
      .first<ResponsesSnapshotRow>();
    return row === null ? null : toStoredResponsesSnapshot(row);
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    const quantized = {
      ...snapshot,
      refreshedAt: quantizeResponsesRefreshedAt(snapshot.refreshedAt),
    };
    await this.db
      .prepare(
        `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, refreshed_at)
         SELECT ?, ?, ?, ? FROM api_keys
         WHERE api_keys.id = ?
           AND api_keys.deleted_at IS NULL
           AND api_keys.responses_retention_seconds > 0
           AND ? >= ? - api_keys.responses_retention_seconds * 1000
         ON CONFLICT (id, api_key_id) DO UPDATE SET
           item_ids_json = excluded.item_ids_json,
           refreshed_at = excluded.refreshed_at
         WHERE responses_snapshots.refreshed_at < excluded.refreshed_at`,
      )
      .bind(
        quantized.id,
        quantized.apiKeyId,
        JSON.stringify(quantized.itemIds),
        quantized.refreshedAt,
        quantized.apiKeyId,
        quantized.refreshedAt,
        Date.now() - RESPONSES_REFRESH_GRANULARITY_MS,
      )
      .run();
  }

  async deleteExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM responses_snapshots
         WHERE NOT EXISTS (
           SELECT 1 FROM api_keys
           WHERE api_keys.id = responses_snapshots.api_key_id
             AND api_keys.deleted_at IS NULL
             AND api_keys.responses_retention_seconds > 0
             AND responses_snapshots.refreshed_at >= ? - api_keys.responses_retention_seconds * 1000
         )`,
      )
      .bind(now - RESPONSES_REFRESH_GRANULARITY_MS)
      .run();
    return result.meta.changes ?? 0;
  }

  async deleteAll(): Promise<void> {
    await this.db.prepare('DELETE FROM responses_snapshots').run();
  }
}

export class SqlSpilledFilesRepo implements SpilledFilesRepo {
  constructor(private readonly db: SqlDatabase) {}

  async claimCollectible(token: string, now: number, staleClaimedBefore: number, limit: number): Promise<string[]> {
    await this.db
      .prepare(
        `UPDATE spilled_files
         SET claim_token = ?, claimed_at = ?
         WHERE file_key IN (
           SELECT file_key FROM spilled_files
           WHERE state != 'owned'
             AND collect_after <= ?
             AND (claim_token IS NULL OR claimed_at < ?)
           ORDER BY collect_after, file_key
           LIMIT ?
         )`,
      )
      .bind(token, now, now, staleClaimedBefore, limit)
      .run();
    const { results } = await this.db
      .prepare('SELECT file_key FROM spilled_files WHERE claim_token = ? ORDER BY file_key')
      .bind(token)
      .all<{ file_key: string }>();
    return results.map(row => row.file_key);
  }

  async acknowledge(token: string): Promise<number> {
    const result = await this.db.prepare('DELETE FROM spilled_files WHERE claim_token = ?').bind(token).run();
    return result.meta.changes ?? 0;
  }
}
