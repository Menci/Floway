import { assertSameStoredResponsesItem, scopedResponsesKey } from './responses-clone.ts';
import {
  prepareStoredResponsesPayload,
  writePreparedStoredResponsesPayload,
  parseStoredResponsesPayload,
  type PreparedStoredResponsesPayload,
} from './responses-payload.ts';
import type {
  ResponsesItemsRepo,
  ResponsesSnapshotsRepo,
  SpilledFilesRepo,
  StoredResponsesItem,
  StoredResponsesSnapshot,
} from './types.ts';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

const RESPONSES_ITEM_COLUMNS = 'id, api_key_id, payload_json, content_hash, payload_file_key, refreshed_at';
const RESPONSES_IN_QUERY_CHUNK_SIZE = 80;
const RESPONSES_INSERT_CHUNK_SIZE = 16;
const RESPONSES_REFRESH_CHUNK_SIZE = 80;
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
  for (const item of items) {
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
  content_hash: string;
  payload_file_key: string | null;
  refreshed_at: number;
}

const toStoredResponsesItem = async (row: ResponsesItemRow): Promise<StoredResponsesItem> => ({
  id: row.id,
  apiKeyId: row.api_key_id,
  payload: await parseStoredResponsesPayload(row.id, row.payload_json, row.payload_file_key),
  contentHash: row.content_hash,
  refreshedAt: row.refreshed_at,
});

interface PreparedResponsesItem {
  item: StoredResponsesItem;
  payload: PreparedStoredResponsesPayload;
}

export class SqlResponsesItemsRepo implements ResponsesItemsRepo {
  constructor(private readonly db: SqlDatabase) {}

  async lookupMany(apiKeyId: string, ids: readonly string[], activeAfter: number): Promise<StoredResponsesItem[]> {
    const rows = await this.lookupByColumn(apiKeyId, 'id', ids, activeAfter);
    const order = new Map([...new Set(ids)].map((id, index) => [id, index]));
    return rows.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  async lookupManyByContentHash(apiKeyId: string, hashes: readonly string[], activeAfter: number): Promise<StoredResponsesItem[]> {
    return await this.lookupByColumn(apiKeyId, 'content_hash', hashes, activeAfter);
  }

  private async lookupByColumn(
    apiKeyId: string,
    column: 'id' | 'content_hash',
    values: readonly string[],
    activeAfter: number,
  ): Promise<StoredResponsesItem[]> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return [];
    const queries: Promise<SqlResult<ResponsesItemRow>>[] = [];
    for (let index = 0; index < unique.length; index += RESPONSES_IN_QUERY_CHUNK_SIZE) {
      const chunk = unique.slice(index, index + RESPONSES_IN_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const orderSql = column === 'content_hash' ? ' ORDER BY refreshed_at DESC, id ASC' : '';
      queries.push(this.db
        .prepare(
          `SELECT ${RESPONSES_ITEM_COLUMNS} FROM responses_items
           WHERE api_key_id = ? AND refreshed_at >= ? AND ${column} IN (${placeholders})${orderSql}`,
        )
        .bind(apiKeyId, activeAfter, ...chunk)
        .all<ResponsesItemRow>());
    }
    const rows = (await Promise.all(queries)).flatMap(result => result.results);
    const hydrated = await mapSequentially(rows, async row => await this.hydrateCurrentItem(row, activeAfter));
    const wanted = new Set(unique);
    return hydrated.flatMap(item =>
      item !== null && (column === 'id' ? wanted.has(item.id) : wanted.has(item.contentHash))
        ? [item]
        : []);
  }

  private async hydrateCurrentItem(initialRow: ResponsesItemRow, activeAfter: number): Promise<StoredResponsesItem | null> {
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
          .bind(row.id, row.api_key_id, activeAfter)
          .first<ResponsesItemRow>();
        if (current === null) return null;
        if (current.payload_json === row.payload_json && current.payload_file_key === row.payload_file_key) throw error;
        row = current;
      }
    }
  }

  async insertMany(items: readonly StoredResponsesItem[], activeAfter: number): Promise<void> {
    const unique = uniqueResponsesItems(items);
    const existing = await this.lookupExistingItems(unique, activeAfter);
    for (const item of unique) {
      const actual = existing.get(scopedResponsesKey(item.apiKeyId, item.id));
      if (actual !== undefined) assertSameStoredResponsesItem(item, actual);
    }

    const pending = unique.filter(item => !existing.has(scopedResponsesKey(item.apiKeyId, item.id)));
    const prepared = await mapSequentially(pending, async item => ({
      item,
      payload: await prepareStoredResponsesPayload(item.id, item.apiKeyId, item.payload),
    }));
    await this.stageFiles(prepared);
    for (const entry of prepared) await writePreparedStoredResponsesPayload(entry.payload);

    const statements: SqlPreparedStatement[] = [];
    for (let index = 0; index < prepared.length; index += RESPONSES_INSERT_CHUNK_SIZE) {
      const chunk = prepared.slice(index, index + RESPONSES_INSERT_CHUNK_SIZE);
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
      statements.push(this.db
        .prepare(
          `INSERT INTO responses_items (${RESPONSES_ITEM_COLUMNS}) VALUES ${values}
           ON CONFLICT (id, api_key_id) DO UPDATE SET
             payload_json = excluded.payload_json,
             content_hash = excluded.content_hash,
             payload_file_key = excluded.payload_file_key,
             refreshed_at = excluded.refreshed_at
           WHERE responses_items.refreshed_at < ?`,
        )
        .bind(
          ...chunk.flatMap(({ item, payload }) => [
            item.id,
            item.apiKeyId,
            payload.payloadJson,
            item.contentHash,
            payload.file?.key ?? null,
            item.refreshedAt,
          ]),
          activeAfter,
        ));
    }
    await runStatements(this.db, statements);

    const persisted = await this.lookupExistingItems(unique, activeAfter);
    for (const item of unique) {
      const actual = persisted.get(scopedResponsesKey(item.apiKeyId, item.id));
      if (actual === undefined) throw new Error(`Responses item disappeared after insert: ${item.id}`);
      assertSameStoredResponsesItem(item, actual);
    }
    const refreshGroups = Map.groupBy(unique, item => item.refreshedAt);
    for (const [refreshedAt, group] of refreshGroups) {
      await this.refreshMany(group, refreshedAt, activeAfter);
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
    activeAfter: number,
  ): Promise<Map<string, StoredResponsesItem>> {
    const idsByApiKey = Map.groupBy(items, item => item.apiKeyId);
    const rows = (await Promise.all([...idsByApiKey].map(async ([apiKeyId, scoped]) =>
      await this.lookupMany(apiKeyId, scoped.map(item => item.id), activeAfter)))).flat();
    return new Map(rows.map(item => [scopedResponsesKey(item.apiKeyId, item.id), item]));
  }

  async refreshMany(
    items: readonly Pick<StoredResponsesItem, 'id' | 'apiKeyId'>[],
    refreshedAt: number,
    activeAfter: number,
  ): Promise<void> {
    const idsByApiKey = Map.groupBy(
      [...new Map(items.map(item => [scopedResponsesKey(item.apiKeyId, item.id), item])).values()],
      item => item.apiKeyId,
    );
    const statements: SqlPreparedStatement[] = [];
    for (const [apiKeyId, scoped] of idsByApiKey) {
      for (let index = 0; index < scoped.length; index += RESPONSES_REFRESH_CHUNK_SIZE) {
        const chunk = scoped.slice(index, index + RESPONSES_REFRESH_CHUNK_SIZE);
        statements.push(this.db
          .prepare(
            `UPDATE responses_items SET refreshed_at = MAX(refreshed_at, ?)
             WHERE api_key_id = ? AND refreshed_at >= ? AND id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .bind(refreshedAt, apiKeyId, activeAfter, ...chunk.map(item => item.id)));
      }
    }
    await runStatements(this.db, statements);
    const persisted = await this.lookupExistingItems(items, activeAfter);
    const missing = items.find(item => !persisted.has(scopedResponsesKey(item.apiKeyId, item.id)));
    if (missing !== undefined) throw new Error(`Responses item disappeared before lifetime refresh: ${missing.id}`);
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
      .bind(now)
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

  async lookup(apiKeyId: string, id: string, activeAfter: number): Promise<StoredResponsesSnapshot | null> {
    const row = await this.db
      .prepare(
        `SELECT id, api_key_id, item_ids_json, refreshed_at FROM responses_snapshots
         WHERE id = ? AND api_key_id = ? AND refreshed_at >= ?`,
      )
      .bind(id, apiKeyId, activeAfter)
      .first<ResponsesSnapshotRow>();
    return row === null ? null : toStoredResponsesSnapshot(row);
  }

  async insert(snapshot: StoredResponsesSnapshot): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, refreshed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id, api_key_id) DO UPDATE SET
           item_ids_json = CASE
             WHEN excluded.refreshed_at >= responses_snapshots.refreshed_at THEN excluded.item_ids_json
             ELSE responses_snapshots.item_ids_json
           END,
           refreshed_at = MAX(responses_snapshots.refreshed_at, excluded.refreshed_at)`,
      )
      .bind(snapshot.id, snapshot.apiKeyId, JSON.stringify(snapshot.itemIds), snapshot.refreshedAt)
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
      .bind(now)
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
