import { expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { sweepResponsesState } from './responses-maintenance.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

test('current-state janitor deletes one bounded key batch per tick', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  initFileProvider(new MemoryFileProvider());
  const now = Date.UTC(2026, 0, 1, 12);
  for (let index = 0; index < 1_000; index += 1) {
    await repo.responsesSnapshots.insert({
      id: `resp_${index}`,
      apiKeyId: 'key-a',
      stateEpoch: '11'.repeat(16),
      itemIds: [`msg_${index}`],
      refreshedAt: now - 2,
    });
  }
  const deleteSnapshots = vi.spyOn(repo.responsesSnapshots, 'deleteReclaimable');

  await sweepResponsesState(now);

  expect(deleteSnapshots).toHaveBeenCalledTimes(1);
  expect(await repo.responsesSnapshots.lookup('key-a', '11'.repeat(16), 'resp_999')).not.toBeNull();

  for (let index = 0; index < 9; index += 1) await sweepResponsesState(now + (index + 1) * 60 * 1000);
  expect(await repo.responsesSnapshots.lookup('key-a', '11'.repeat(16), 'resp_999')).toBeNull();
});

test('v1 cursor drains prior tables and removes the entire v1 object root after its grace horizon', async () => {
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const expiryHour = Date.UTC(2026, 6, 1, 10);
  const v1CreatedAt = expiryHour - 30 * 24 * 60 * 60 * 1000 + 1;
  await base.prepare(
    'INSERT INTO responses_items (id, api_key_id, payload_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?)',
  ).bind('msg_v1', 'key-a', '{}', 'hash', v1CreatedAt).run();
  await base.prepare(
    'INSERT INTO responses_snapshots (id, api_key_id, item_ids_json, created_at) VALUES (?, ?, ?, ?)',
  ).bind('resp_v1', 'key-a', '["msg_v1"]', v1CreatedAt).run();
  await repo.responsesMaintenance.setV1NextExpiryHour(expiryHour);
  await base.prepare('UPDATE responses_state_maintenance SET v1_cleanup_after = 0').run();
  const v1File = 'responses-items/v1/expires/2026/07/01/10/v1.gz';
  const orphanFile = 'responses-items/v1/expires/2026/06/01/00/orphan.gz';
  await files.put(v1File, new Uint8Array([1]));
  await files.put(orphanFile, new Uint8Array([2]));

  await sweepResponsesState(expiryHour + 2 * 60 * 60 * 1000);

  expect((await base.prepare('SELECT COUNT(*) AS count FROM responses_items').first<{ count: number }>())?.count).toBe(0);
  expect((await base.prepare('SELECT COUNT(*) AS count FROM responses_snapshots').first<{ count: number }>())?.count).toBe(0);
  expect(await files.listKeys('responses-items/v1/')).toEqual([]);
  expect(await repo.responsesMaintenance.getV1NextExpiryHour()).toBeNull();
});

test('v1 cleanup stays live until the old writer grace horizon', async () => {
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const now = Date.UTC(2026, 6, 1, 12);
  await repo.responsesMaintenance.setV1NextExpiryHour(now);
  await base.prepare('UPDATE responses_state_maintenance SET v1_cleanup_after = ?').bind(now + 1).run();
  const orphan = 'responses-items/v1/expires/2026/06/01/00/orphan.gz';
  await files.put(orphan, new Uint8Array([1]));

  await sweepResponsesState(now);
  expect(await repo.responsesMaintenance.getV1NextExpiryHour()).toBe(now);
  expect(await files.get(orphan)).not.toBeNull();

  await sweepResponsesState(now + 60 * 60 * 1000);
  expect(await repo.responsesMaintenance.getV1NextExpiryHour()).toBeNull();
  expect(await files.get(orphan)).toBeNull();
});
