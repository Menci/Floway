import { afterEach, describe, expect, test, vi } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { initRepo } from '../../src/repo/index.ts';
import { hashOpenAIResponsesJson } from '../../src/repo/openai-responses-hash.ts';
import { prepareStoredOpenAIResponsesPayload } from '../../src/repo/openai-responses-payload.ts';
import { quantizeOpenAIResponsesRefreshedAt, openaiResponsesStateCutoff } from '../../src/repo/openai-responses-retention.ts';
import { SqlRepo } from '../../src/repo/sql.ts';
import type { ApiKey, Repo, StoredOpenAIResponsesItem } from '../../src/repo/types.ts';
import { collectSpilledFiles } from '../../src/scheduled/spilled-files.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

const RETENTION_SECONDS = 24 * 60 * 60;
const DAY_MS = RETENTION_SECONDS * 1000;
const DAY_ZERO = Date.UTC(2026, 0, 1);
const atDay = (day: number, milliseconds = 0): number => DAY_ZERO + day * DAY_MS + milliseconds;

afterEach(() => vi.useRealTimers());

const apiKey = (openaiResponsesRetentionSeconds = RETENTION_SECONDS): ApiKey => ({
  id: 'key-a',
  userId: 1,
  name: 'State key',
  key: 'raw-state-key',
  serverSecret: '11'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds,
});

const storedItem = (
  id: string,
  refreshedAt: number,
  content = id,
  apiKeyId = 'key-a',
): StoredOpenAIResponsesItem => ({
  id,
  apiKeyId,
  payload: { item: { type: 'message', id, role: 'assistant', content } },
  itemHash: `hash-${content}`,
  refreshedAt,
});

const largeContent = (): string => Array.from({ length: 4_096 }, () => crypto.randomUUID()).join('');

const backends: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

describe.each(backends)('%s OpenAI Responses state repository', (_backend, makeRepo) => {
  test('scopes exact and content-hash reads by key and rolling cutoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(4));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey(7 * RETENTION_SECONDS));
    await repo.apiKeys.save({ ...apiKey(7 * RETENTION_SECONDS), id: 'key-b', key: 'raw-key-b', serverSecret: '22'.repeat(32) });
    const old = storedItem('msg-old', atDay(1), 'same');
    const current = storedItem('msg-current', atDay(2), 'same');
    const foreign = storedItem('msg-foreign', atDay(2), 'same', 'key-b');
    await repo.openaiResponsesItems.insertMany([old, current, foreign], 0);

    expect(await repo.openaiResponsesItems.lookupMany('key-a', [old.id, current.id], atDay(1, 1))).toEqual([current]);
    expect(await repo.openaiResponsesItems.lookupMany('key-b', [current.id], 0)).toEqual([]);
    expect(await repo.openaiResponsesItems.lookupManyByItemHash('key-a', [current.itemHash], 0)).toEqual([current, old]);
  });

  test('rejects a live producer-ID collision but replaces an expired row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(11, DAY_MS / 2));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const original = storedItem('msg-collision', atDay(10), 'original');
    const replacement = storedItem('msg-collision', atDay(12), 'replacement');
    await repo.openaiResponsesItems.insertMany([original], 0);

    await expect(repo.openaiResponsesItems.insertMany([replacement], atDay(9))).rejects.toThrow('id collision');
    vi.setSystemTime(atDay(12, 1));
    await expect(repo.openaiResponsesItems.insertMany([replacement], atDay(10, 1))).resolves.toBeUndefined();
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [original.id], atDay(10, 1))).toEqual([replacement]);
  });

  test('refreshes only active rows and never lowers their timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(atDay(11, DAY_MS / 2));
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    await repo.apiKeys.save(apiKey());
    const item = storedItem('msg-refresh', atDay(10));
    await repo.openaiResponsesItems.insertMany([item], 0);

    await repo.openaiResponsesItems.refreshMany([item], atDay(11, 1_000), atDay(9));
    await repo.openaiResponsesItems.refreshMany([item], atDay(11, DAY_MS - 1), atDay(9));
    expect((await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt).toBe(atDay(11));
    await expect(repo.openaiResponsesItems.refreshMany([item], atDay(12), atDay(11, 1))).rejects.toThrow('disappeared');
  });

  test('deletes rows outside each key current rolling policy', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(10);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
    const expired = storedItem('msg-expired', openaiResponsesStateCutoff(now, RETENTION_SECONDS) - 1);
    const current = storedItem('msg-current', openaiResponsesStateCutoff(now, RETENTION_SECONDS));
    await repo.openaiResponsesItems.insertMany([expired, current], 0);
    await repo.openaiResponsesSnapshots.insert({ id: 'resp-expired', apiKeyId: 'key-a', itemIds: [expired.id], refreshedAt: expired.refreshedAt });
    await repo.openaiResponsesSnapshots.insert({ id: 'resp-current', apiKeyId: 'key-a', itemIds: [current.id], refreshedAt: current.refreshedAt });
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: RETENTION_SECONDS });

    expect(await repo.openaiResponsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.openaiResponsesSnapshots.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [expired.id, current.id], 0)).toEqual([current]);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp-expired', 0)).toBeNull();
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp-current', 0)).not.toBeNull();

    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: 0 });
    expect(await repo.openaiResponsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
    expect(await repo.openaiResponsesSnapshots.deleteExpiredBatch('key-a', now, 100)).toBe(1);
  });

  test('an old request cannot refresh a replacement payload under a reused ID', async () => {
    initFileStore(new MemoryFileStore());
    const repo = await makeRepo();
    const now = atDay(10, DAY_MS / 2);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
    const original = storedItem('msg-reused', now - 2.5 * DAY_MS, 'original');
    await repo.openaiResponsesItems.insertMany([original], openaiResponsesStateCutoff(now, 2 * RETENTION_SECONDS));
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: RETENTION_SECONDS });
    const replacement = storedItem(original.id, now, 'replacement');
    await repo.openaiResponsesItems.insertMany([replacement], openaiResponsesStateCutoff(now, RETENTION_SECONDS));

    await expect(repo.openaiResponsesItems.refreshMany([original], now + 1, openaiResponsesStateCutoff(now, 2 * RETENTION_SECONDS)))
      .rejects.toThrow('id collision');
    expect((await repo.openaiResponsesItems.lookupMany('key-a', [original.id], 0))[0]).toEqual({
      ...replacement,
      refreshedAt: quantizeOpenAIResponsesRefreshedAt(replacement.refreshedAt),
    });
  });
});

test('SQL spill ownership is first-class and the shared collector reclaims retired files', async () => {
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  const now = atDay(10, DAY_MS / 2);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  await repo.apiKeys.save(apiKey(2 * RETENTION_SECONDS));
  const item = storedItem('msg-spilled', now - 2.5 * DAY_MS, largeContent());
  await repo.openaiResponsesItems.insertMany([item], 0);
  await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: RETENTION_SECONDS });

  const owned = await db.prepare(
    "SELECT file_key, owner_kind, owner_key, state FROM spilled_files WHERE state = 'owned'",
  ).first<{ file_key: string; owner_kind: string; owner_key: string; state: string }>();
  if (owned === null) throw new Error('spill was not adopted');
  expect(owned.owner_kind).toBe('responses-item');
  expect(owned.owner_key).toBe(JSON.stringify([item.apiKeyId, item.id]));
  expect(await files.get(owned.file_key)).not.toBeNull();
  expect((await db.prepare('SELECT payload_json FROM responses_items WHERE id = ?').bind(item.id).first<{ payload_json: string }>())?.payload_json)
    .not.toContain(owned.file_key);

  expect(await repo.openaiResponsesItems.deleteExpiredBatch('key-a', now, 100)).toBe(1);
  expect((await db.prepare('SELECT state FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first<{ state: string }>())?.state)
    .toBe('retired');
  await collectSpilledFiles(now);
  expect(await files.get(owned.file_key)).toBeNull();
  expect(await db.prepare('SELECT file_key FROM spilled_files WHERE file_key = ?').bind(owned.file_key).first()).toBeNull();
});

test('SQL hydration retries with every current item identity column after a replacement race', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(atDay(11));
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  const files = new MemoryFileStore();
  initFileStore(files);
  await repo.apiKeys.save(apiKey());
  const original = storedItem('msg-hydration-race', atDay(10), largeContent());
  const replacement = storedItem(original.id, atDay(11), 'replacement');
  await repo.openaiResponsesItems.insertMany([original], 0);
  const prepared = await prepareStoredOpenAIResponsesPayload(replacement.id, replacement.apiKeyId, replacement.payload);
  if (prepared.file !== null) throw new Error('replacement payload unexpectedly spilled');
  const payloadHash = await hashOpenAIResponsesJson(replacement.payload);
  vi.spyOn(files, 'get').mockImplementationOnce(async () => {
    await db.prepare(
      `UPDATE responses_items
       SET payload_json = ?, item_hash = ?, payload_hash = ?, payload_file_key = NULL, refreshed_at = ?
       WHERE id = ? AND api_key_id = ?`,
    ).bind(
      prepared.payloadJson,
      replacement.itemHash,
      payloadHash,
      replacement.refreshedAt,
      replacement.id,
      replacement.apiKeyId,
    ).run();
    return null;
  });

  expect(await repo.openaiResponsesItems.lookupMany(replacement.apiKeyId, [replacement.id], 0)).toEqual([replacement]);
});
