import { afterEach, expect, test, vi } from 'vitest';

import { initDumpStore } from '../src/dump/registry.ts';
import type { DumpWriteRecord } from '../src/dump/types.ts';
import { FileDumpStore } from '../src/repo/dump-store.ts';
import { initRepo } from '../src/repo/index.ts';
import { SqlRepo } from '../src/repo/sql.ts';
import type { ApiKey } from '../src/repo/types.ts';
import { runScheduledMaintenance } from '../src/scheduled.ts';
import { createSqliteTestDb } from './repo/test-sqlite.ts';
import { setupAppTest } from './test-utils/app.ts';
import { initFileStore, initImageCacheStore, MemoryFileStore } from '@floway-dev/platform';

afterEach(() => vi.useRealTimers());

const apiKey = (id: string, now: number, secretDigit: number): ApiKey => ({
  id,
  userId: 1,
  name: `Sweep ${id}`,
  key: `raw-${id}`,
  serverSecret: String(secretDigit).repeat(64),
  createdAt: new Date(now).toISOString(),
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  responsesRetentionSeconds: 0,
});

const fileBackedDumpRecord = (id: string, completedAt: number): DumpWriteRecord => ({
  meta: {
    id,
    startedAt: completedAt - 1,
    completedAt,
    method: 'POST',
    path: '/v1/responses',
    status: 200,
    upstream: null,
    model: 'gpt-test',
    inputTokens: null,
    outputTokens: null,
    requestBytes: 1,
    responseBytes: 1,
    durationMs: 1,
    error: null,
  },
  request: {
    method: 'POST',
    path: '/v1/responses',
    headers: [],
    body: { encoding: 'identity', bytes: new Uint8Array([1]), decodedByteLength: 1 },
  },
  response: { status: 200, headers: [], body: { type: 'bytes', body: new Uint8Array([2]) } },
});

test('scheduled maintenance isolates the shared expiration driver from later collectors', async () => {
  const { repo } = await setupAppTest();
  initFileStore(new MemoryFileStore());
  let imageSwept = false;
  initImageCacheStore({
    async get() { return null; },
    async put() {},
    async sweepExpired() { imageSwept = true; },
  });
  vi.spyOn(repo.expirationSweeps, 'claim').mockRejectedValue(new Error('expiration queue failed'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await runScheduledMaintenance();
  } finally {
    error.mockRestore();
  }

  expect(imageSwept).toBe(true);
});

test('scheduled maintenance collects exact spilled files after expiration work', async () => {
  const { repo } = await setupAppTest();
  const files = new MemoryFileStore();
  initFileStore(files);
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  vi.spyOn(repo.expirationSweeps, 'claim').mockResolvedValue(null);
  const key = 'spilled/retired.gz';
  await files.put(key, new Uint8Array([1]));
  vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([key]);
  vi.spyOn(repo.spilledFiles, 'acknowledge').mockResolvedValue(1);

  await runScheduledMaintenance();

  expect(await files.get(key)).toBeNull();
});

test('one maintenance tick collects every file retired by its four dump units', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const db = await createSqliteTestDb();
  const repo = new SqlRepo(db);
  initRepo(repo);
  const files = new MemoryFileStore();
  initFileStore(files);
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  const dumps = new FileDumpStore(db, files);
  initDumpStore(dumps);

  for (let keyIndex = 0; keyIndex < 4; keyIndex += 1) {
    const keyId = `key-${keyIndex}`;
    await repo.apiKeys.save(apiKey(keyId, now, keyIndex + 1));
    for (let rowIndex = 0; rowIndex < 50; rowIndex += 1) {
      await dumps.put(keyId, fileBackedDumpRecord(`dump-${keyIndex}-${rowIndex}`, now - 3600_001));
    }
  }
  const { results: ownedFiles } = await db.prepare('SELECT file_key FROM spilled_files ORDER BY file_key')
    .all<{ file_key: string }>();
  expect(ownedFiles).toHaveLength(400);

  await runScheduledMaintenance();

  expect(await db.prepare('SELECT COUNT(*) AS count FROM dump_records').first<{ count: number }>()).toEqual({ count: 0 });
  expect(await db.prepare('SELECT COUNT(*) AS count FROM spilled_files').first<{ count: number }>()).toEqual({ count: 0 });
  expect(await Promise.all(ownedFiles.map(row => files.get(row.file_key))))
    .toEqual(Array.from({ length: 400 }, () => null));
});

test('scheduled maintenance lease keeps overlapping ticks within one budget', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const { repo } = await setupAppTest();
  initFileStore(new MemoryFileStore());
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  let enterClaim!: () => void;
  let finishClaim!: () => void;
  const claimEntered = new Promise<void>(resolve => { enterClaim = resolve; });
  const claimFinished = new Promise<void>(resolve => { finishClaim = resolve; });
  const claim = vi.spyOn(repo.expirationSweeps, 'claim').mockImplementation(async () => {
    enterClaim();
    await claimFinished;
    return null;
  });
  const collect = vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([]);

  const first = runScheduledMaintenance();
  await claimEntered;
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await runScheduledMaintenance();
  finishClaim();
  await first;

  expect(claim).toHaveBeenCalledTimes(1);
  expect(collect).toHaveBeenCalledTimes(1);
});

test('a failed maintenance heartbeat stops later phases and releases the tick', async () => {
  const now = Date.UTC(2026, 6, 23, 12);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const { repo } = await setupAppTest();
  initFileStore(new MemoryFileStore());
  initImageCacheStore({ async get() { return null; }, async put() {}, async sweepExpired() {} });
  let enterClaim!: () => void;
  let finishClaim!: () => void;
  const claimEntered = new Promise<void>(resolve => { enterClaim = resolve; });
  const claimFinished = new Promise<void>(resolve => { finishClaim = resolve; });
  vi.spyOn(repo.expirationSweeps, 'claim')
    .mockImplementationOnce(async () => {
      enterClaim();
      await claimFinished;
      return null;
    })
    .mockResolvedValue(null);
  vi.spyOn(repo.scheduledMaintenance, 'renew')
    .mockRejectedValueOnce(new Error('lease renewal failed'))
    .mockResolvedValue();
  const collect = vi.spyOn(repo.spilledFiles, 'claimCollectible').mockResolvedValue([]);

  const first = runScheduledMaintenance();
  await claimEntered;
  await vi.advanceTimersByTimeAsync(60_000);
  finishClaim();
  await expect(first).rejects.toThrow('lease renewal failed');
  expect(collect).not.toHaveBeenCalled();

  await runScheduledMaintenance();
  expect(collect).toHaveBeenCalledOnce();
});
