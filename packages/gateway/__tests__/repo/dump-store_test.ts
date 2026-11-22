import { expect, test } from 'vitest';

import { createSqliteTestDb } from './test-sqlite.ts';
import type { DumpMetadata } from '../../src/dump/types.ts';
import { FileDumpStore } from '../../src/repo/dump-store.ts';
import { initRepo } from '../../src/repo/index.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';
import type { SqlDatabase } from '@floway-dev/platform';
import { assertExists } from '@floway-dev/test-utils';

const openDb = async (): Promise<SqlDatabase> => {
  const db = await createSqliteTestDb();
  await new SqlRepo(db).apiKeys.save({
    id: 'key_x', userId: 1, name: 'Dump key', key: 'raw-dump-key', serverSecret: '44'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
    dumpRetentionSeconds: 10 * 365 * 24 * 60 * 60, openaiResponsesRetentionSeconds: 0,
  });
  return db;
};

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);
const streamOf = (text: string): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({
  start(controller) {
    const bytes = utf8(text);
    controller.enqueue(bytes.subarray(0, 1));
    if (bytes.byteLength > 1) controller.enqueue(bytes.subarray(1));
    controller.close();
  },
});

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
};

const meta = (id: string, completedAt: number): DumpMetadata => ({
  id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
  upstream: null, model: 'm', inputTokens: 1, outputTokens: 2, requestBytes: 3, responseBytes: 4,
  durationMs: 1, error: null,
});

const stageRecord = async (
  store: FileDumpStore,
  keyId: string,
  record: DumpMetadata,
  text = `${JSON.stringify({ k: 'run' })}\n`,
): Promise<string> => {
  const artifactKey = store.createArtifactKey(keyId, record.startedAt, record.id);
  await store.stageAndPutArtifact(keyId, record.id, artifactKey, streamOf(text));
  await store.commitRecord(keyId, { meta: record, artifactKey });
  return artifactKey;
};

test('FileDumpStore stages one v2 artifact and streams it back after gzip round-trip', async () => {
  const db = await openDb();
  const files = new MemoryFileStore();
  const store = new FileDumpStore(db, files);
  const record = meta('rec-1', Date.UTC(2026, 5, 1, 12));
  const text = `${JSON.stringify({ k: 'run', runId: 'r' })}\n`;
  const artifactKey = await stageRecord(store, 'key_x', record, text);

  expect(artifactKey.startsWith('dumps/v2/key_x/2026060111/')).toBe(true);
  expect(await db.prepare(
    'SELECT state, owner_kind, owner_key, collect_after FROM spilled_files WHERE file_key = ?',
  ).bind(artifactKey).first()).toEqual({
    state: 'owned', owner_kind: 'dump-artifact', owner_key: JSON.stringify(['key_x', 'rec-1']), collect_after: null,
  });
  const stream = await store.getArtifactStream('key_x', 'rec-1');
  assertExists(stream);
  expect(await readAll(stream)).toBe(text);
  expect(await store.getMeta('key_x', 'rec-1')).toEqual(record);
});

test('FileDumpStore validates v2 staging and adopts the artifact', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const record = meta('rec-trigger', Date.now());
  await expect(store.commitRecord('key_x', { meta: record, artifactKey: 'dumps/v1/key_x/x.ndjson.gz' }))
    .rejects.toThrow('v2 prefix');
  await expect(store.commitRecord('key_x', { meta: record, artifactKey: 'dumps/v2/key_x/missing.ndjson.gz' }))
    .rejects.toThrow('was not staged');
  const artifactKey = store.createArtifactKey('key_x', record.startedAt, record.id);
  await store.stageAndPutArtifact('key_x', record.id, artifactKey, streamOf('{}\n'));
  await store.commitRecord('key_x', { meta: record, artifactKey });
  expect((await db.prepare('SELECT state FROM spilled_files WHERE file_key = ?').bind(artifactKey).first<{ state: string }>())?.state).toBe('owned');
});

test('FileDumpStore applies retention before reads and retires the artifact on physical delete', async () => {
  const db = await openDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12);
  const oldKey = await stageRecord(store, 'key_x', meta('old', now - 3 * 60 * 60 * 1000));
  await stageRecord(store, 'key_x', meta('current', now));
  await repo.apiKeys.update('key_x', { dumpRetentionSeconds: 2 * 3600 });
  const originalNow = Date.now;
  Date.now = () => now + 1;
  try {
    expect((await store.list('key_x', { limit: 10 })).map(item => item.id)).toEqual(['current']);
    expect(await store.getMeta('key_x', 'old')).toBeNull();
    expect(await store.getArtifactStream('key_x', 'old')).toBeNull();
    expect(await store.deleteExpiredBatch('key_x', now + 1, 100)).toBe(1);
    expect(await db.prepare('SELECT state, collect_after FROM spilled_files WHERE file_key = ?').bind(oldKey).first())
      .toEqual({ state: 'retired', collect_after: 0 });
    await collectSpilledFiles(now + 1);
  } finally {
    Date.now = originalNow;
  }
  expect(await files.get(oldKey)).toBeNull();
});

test('FileDumpStore filters retained history and paginates by compound timestamp/id cursor', async () => {
  const db = await openDb();
  const store = new FileDumpStore(db, new MemoryFileStore());
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    const record = meta(`filter-${index}`, now - index);
    record.model = index === 4 ? 'needle-model' : 'other';
    record.error = index === 4 ? { kind: 'failed', reason: 'socket reset' } : null;
    await stageRecord(store, 'key_x', record);
  }
  expect((await store.list('key_x', { q: 'needle', limit: 1 })).map(item => item.id)).toEqual(['filter-4']);
  expect((await store.list('key_x', { q: 'SOCKET', failures: true, limit: 1 })).map(item => item.id)).toEqual(['filter-4']);
  expect(await store.list('key_x', { q: "' OR 1=1 --", limit: 1 })).toEqual([]);
  expect((await store.list('key_x', { limit: 1, before: 'filter-0' })).map(item => item.id)).toEqual(['filter-1']);
});
