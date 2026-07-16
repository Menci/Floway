import initSqlJs from 'sql.js';
import { describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb, migrationSqlByFilename } from './test-sqlite.ts';
import type { Repo, StoredResponsesItem } from './types.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

const factories: Array<[string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const storedItem = (id: string, apiKeyId: string, contentHash: string | null, createdAt: number): StoredResponsesItem => ({
  id,
  apiKeyId,
  itemType: 'message',
  payload: { item: { type: 'message', id, role: 'assistant', content: [] } },
  contentHash,
  createdAt,
});

describe.each(factories)('%s Responses state repo', (_name, createRepo) => {
  test('stores complete key-scoped items and looks them up by id and content hash', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const first = storedItem('msg_first', 'key-a', 'hash-a', 1_000);
    const second = storedItem('msg_second', 'key-a', 'hash-b', 2_000);
    const other = storedItem('msg_other', 'key-b', 'hash-a', 3_000);
    const legacy = storedItem('msg_legacy', 'key-a', null, 4_000);

    await repo.responsesItems.insertMany([first, second, other, legacy]);

    expect(await repo.responsesItems.lookupMany('key-a', [second.id, legacy.id, first.id])).toEqual([second, legacy, first]);
    expect(await repo.responsesItems.lookupMany('key-b', [first.id])).toEqual([]);
    expect(await repo.responsesItems.lookupManyByContentHash('key-a', ['hash-a'])).toEqual([first]);
  });

  test('deletes complete items and snapshots by their refreshable retention timestamp', async () => {
    initFileProvider(new MemoryFileProvider());
    const repo = await createRepo();
    const old = storedItem('msg_old', 'key-a', 'old', 1_000);
    const fresh = storedItem('msg_fresh', 'key-a', 'fresh', 3_000);
    await repo.responsesItems.insertMany([old, fresh]);
    await repo.responsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [old.id], createdAt: 1_000 });
    await repo.responsesSnapshots.insert({ id: 'resp_fresh', apiKeyId: 'key-a', itemIds: [fresh.id], createdAt: 3_000 });

    expect(await repo.responsesItems.deleteOlderThan(2_000)).toBe(1);
    expect(await repo.responsesSnapshots.deleteOlderThan(2_000)).toBe(1);
    expect(await repo.responsesItems.lookupMany('key-a', [old.id, fresh.id])).toEqual([fresh]);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_old')).toBeNull();
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_fresh')).toEqual({
      id: 'resp_fresh', apiKeyId: 'key-a', itemIds: [fresh.id], createdAt: 3_000,
    });
  });

  test('refreshes spilled payload expiry without retaining the previous file', async () => {
    const files = new MemoryFileProvider();
    initFileProvider(files);
    const repo = await createRepo();
    const bytes = new Uint8Array(128 * 1024);
    crypto.getRandomValues(bytes.subarray(0, 64 * 1024));
    crypto.getRandomValues(bytes.subarray(64 * 1024));
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const item = {
      ...storedItem('msg_large', 'key-a', 'large', 1_000),
      payload: { item: { type: 'message', id: 'msg_large', role: 'assistant', content: btoa(binary) } },
    };
    await repo.responsesItems.insertMany([item]);
    const before = await files.listKeys('responses-items/');
    const put = vi.spyOn(files, 'put');
    await repo.responsesItems.refreshMany([item], 1_000 + 10 * 60 * 1000);
    if (_name === 'sql') expect(put).not.toHaveBeenCalled();
    await repo.responsesItems.refreshMany([item], 1_000 + 2 * 60 * 60 * 1000);
    const after = await files.listKeys('responses-items/');

    if (_name === 'sql') {
      expect(before).toHaveLength(1);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(before[0]);
    } else {
      expect(before).toEqual([]);
      expect(after).toEqual([]);
    }
    expect((await repo.responsesItems.lookupMany('key-a', [item.id]))[0].createdAt).toBe(1_000 + 2 * 60 * 60 * 1000);
  });
});

test('migration 0057 preserves usable payloads and snapshots but drops legacy affinity columns', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    for (const [filename, sql] of migrationSqlByFilename) {
      if (filename === '0057_responses_full_state.sql') break;
      db.run(sql);
    }

    const gzipDescriptor = JSON.stringify({ version: 1, storage: 'inline', encoding: 'gzip', payload: 'H4sIAAAAAAAA' });
    const fileDescriptor = JSON.stringify({ version: 1, storage: 'file', key: 'responses-items/v1/expires/x', sha256: 'abc', byteLength: 3 });
    const legacyInline = JSON.stringify({ version: 1, storage: 'inline', payload: { item: { type: 'reasoning', id: 'rs_legacy' } } });
    const insertItem = `INSERT INTO responses_items
      (id, api_key_id, upstream_id, upstream_item_id, item_type, payload_json, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(insertItem, ['msg_gzip', 'key-a', 'upstream-a', 'msg_upstream', 'message', gzipDescriptor, 'hash-a', 1_000]);
    db.run(insertItem, ['rs_file', 'key-a', 'upstream-a', 'rs_upstream', 'reasoning', fileDescriptor, null, 2_000]);
    db.run(insertItem, ['rs_legacy', 'key-a', 'upstream-a', 'rs_legacy_upstream', 'reasoning', legacyInline, null, 3_000]);
    db.run(insertItem, ['msg_unscoped', null, null, null, 'message', gzipDescriptor, 'hash-u', 4_000]);
    db.run(insertItem, ['msg_metadata', 'key-a', 'upstream-a', 'msg_metadata_upstream', 'message', null, 'hash-m', 5_000]);

    const insertSnapshot = `INSERT INTO responses_snapshots
      (id, api_key_id, item_ids_json, created_at, refreshed_at)
      VALUES (?, ?, ?, ?, ?)`;
    db.run(insertSnapshot, ['resp_valid', 'key-a', '["msg_gzip","rs_file","rs_legacy"]', 6_000, 6_000]);
    db.run(insertSnapshot, ['resp_dangling', 'key-a', '["msg_gzip","msg_metadata"]', 7_000, 7_000]);
    db.run(insertSnapshot, ['resp_malformed', 'key-a', '{', 8_000, 8_000]);
    db.run(insertSnapshot, ['resp_unscoped', null, '["msg_unscoped"]', 9_000, 9_000]);

    const migration = migrationSqlByFilename.find(([filename]) => filename === '0057_responses_full_state.sql');
    if (migration === undefined) throw new Error('missing migration 0057_responses_full_state.sql');
    db.run(migration[1]);

    const itemResult = db.exec('SELECT id, payload_json, content_hash, created_at FROM responses_items ORDER BY created_at')[0];
    expect(itemResult?.values).toEqual([
      ['msg_gzip', gzipDescriptor, 'hash-a', 1_000],
      ['rs_file', fileDescriptor, null, 2_000],
      ['rs_legacy', legacyInline, null, 3_000],
    ]);
    const snapshotResult = db.exec('SELECT id, api_key_id, item_ids_json, created_at FROM responses_snapshots')[0];
    expect(snapshotResult?.values).toEqual([
      ['resp_valid', 'key-a', '["msg_gzip","rs_file","rs_legacy"]', 6_000],
    ]);
    const columns = db.exec('PRAGMA table_info(responses_items)')[0]?.values.map(row => row[1]);
    expect(columns).not.toContain('upstream_id');
    expect(columns).not.toContain('upstream_item_id');
  } finally {
    db.close();
  }
});
