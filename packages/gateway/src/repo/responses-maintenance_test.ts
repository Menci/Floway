import { expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { sweepResponsesState } from './responses-maintenance.ts';
import { responsesItemPayloadExpiryBucketPrefix } from './responses-payload.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

test('expiry janitor stops at its D1 mutation budget and advances only after an hour drains', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const expiryHour = Date.UTC(2026, 0, 1, 10);
  await repo.responsesMaintenance.setNextExpiryHour(expiryHour);
  for (let index = 0; index < 1_000; index += 1) {
    await repo.responsesSnapshots.insert({
      id: `resp_${index}`,
      apiKeyId: 'key-a',
      stateEpoch: '11'.repeat(16),
      itemIds: [`msg_${index}`],
      refreshedAt: expiryHour - 1,
      expiresAt: expiryHour + 1,
    });
  }
  const orphanKey = `${responsesItemPayloadExpiryBucketPrefix(expiryHour)}orphan.gz`;
  await files.put(orphanKey, new Uint8Array([1]));
  const deleteSnapshots = vi.spyOn(repo.responsesSnapshots, 'deleteExpiredHour');

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect(deleteSnapshots).toHaveBeenCalledTimes(10);
  expect(await repo.responsesMaintenance.getNextExpiryHour()).toBe(expiryHour);
  expect(await files.get(orphanKey)).not.toBeNull();

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect(await repo.responsesMaintenance.getNextExpiryHour()).toBe(expiryHour + 2 * 60 * 60 * 1000);
  expect(await files.get(orphanKey)).toBeNull();
});

test('legacy cursor drains prior tables and their versioned R2 expiry bucket', async () => {
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const expiryHour = Date.UTC(2026, 0, 1, 10);
  const legacyRefreshedAt = expiryHour - 30 * 24 * 60 * 60 * 1000 + 1;
  await base.prepare(
    'INSERT INTO responses_items (id, api_key_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind('msg_legacy', 'key-a', '{}', 'hash', legacyRefreshedAt).run();
  await base.prepare(
    'INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, created_at) VALUES (?, ?, ?, ?)',
  ).bind('resp_legacy', 'key-a', '["msg_legacy"]', legacyRefreshedAt).run();
  await repo.responsesMaintenance.setLegacyNextExpiryHour(expiryHour);
  const legacyFile = 'responses-items/v1/expires/2026/01/01/10/legacy.gz';
  await files.put(legacyFile, new Uint8Array([1]));

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect((await base.prepare('SELECT COUNT(*) AS count FROM responses_items').first<{ count: number }>())?.count).toBe(0);
  expect((await base.prepare('SELECT COUNT(*) AS count FROM responses_snapshots').first<{ count: number }>())?.count).toBe(0);
  expect(await files.get(legacyFile)).toBeNull();
  expect(await repo.responsesMaintenance.getLegacyNextExpiryHour()).toBeNull();
});
