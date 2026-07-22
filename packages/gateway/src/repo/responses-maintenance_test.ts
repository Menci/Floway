import { expect, test, vi } from 'vitest';

import { initRepo } from './index.ts';
import { InMemoryRepo } from './memory.ts';
import { sweepResponsesState } from './responses-maintenance.ts';
import { SqlRepo } from './sql.ts';
import { createSqliteTestDb } from './test-sqlite.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';

test('current-state janitor stops at its bounded global key budget', async () => {
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

  expect(deleteSnapshots).toHaveBeenCalledTimes(3);
  expect(await repo.responsesSnapshots.lookup('key-a', '11'.repeat(16), 'resp_999')).not.toBeNull();

  for (let index = 0; index < 9; index += 1) await sweepResponsesState(now + (index + 1) * 60 * 1000);
  expect(await repo.responsesSnapshots.lookup('key-a', '11'.repeat(16), 'resp_999')).toBeNull();
});

test('partial cleanup advances a concurrently-touched hot key so another due key runs', async () => {
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  initFileProvider(new MemoryFileProvider());
  const now = Date.UTC(2026, 6, 22, 12);
  const key = (id: string, secret: string) => ({
    id,
    userId: 1,
    name: id,
    key: `raw-${id}`,
    serverSecret: secret,
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    responsesRetentionSeconds: 0,
    responsesStateEpoch: '11'.repeat(16),
    responsesStateVisibleAfter: 0,
  });
  await repo.apiKeys.save(key('a-hot', '33'.repeat(32)));
  await repo.apiKeys.save(key('b-small', '44'.repeat(32)));
  const item = (apiKeyId: string, id: string) => ({
    id,
    apiKeyId,
    stateEpoch: '22'.repeat(16),
    payload: { item: { type: 'message', id, content: [] } },
    contentHash: `content-${id}`,
    payloadHash: `payload-${id}`,
    payloadFileKey: null,
    refreshedAt: now,
  });
  await repo.responsesItems.insertMany(Array.from({ length: 150 }, (_, index) => item('a-hot', `msg_hot_${index}`)), 0);
  await repo.responsesItems.insertMany([item('b-small', 'msg_small')], 0);
  const deleteReclaimable = repo.responsesItems.deleteReclaimable.bind(repo.responsesItems);
  vi.spyOn(repo.responsesItems, 'deleteReclaimable').mockImplementationOnce(async (...args) => {
    const deleted = await deleteReclaimable(...args);
    await repo.responsesItems.insertMany([item('a-hot', 'msg_concurrent')], 0);
    return deleted;
  });

  await sweepResponsesState(now);

  expect(await repo.responsesItems.lookupMany('b-small', '22'.repeat(16), ['msg_small'])).toEqual([]);
  expect(await repo.responsesItems.lookupMany('a-hot', '22'.repeat(16), ['msg_hot_149'])).toHaveLength(1);
  const hotSweep = await base.prepare('SELECT due_at FROM responses_state_sweeps WHERE api_key_id = ?')
    .bind('a-hot')
    .first<{ due_at: number }>();
  expect(hotSweep?.due_at).toBeGreaterThan(now);
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

test('v1 root cleanup deletes at most one file-provider page per tick', async () => {
  const base = await createSqliteTestDb();
  const repo = new SqlRepo(base);
  initRepo(repo);
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const now = Date.UTC(2026, 6, 1, 12);
  await repo.responsesMaintenance.setV1NextExpiryHour(now);
  await base.prepare('UPDATE responses_state_maintenance SET v1_cleanup_after = 0').run();
  for (let index = 0; index < 1_001; index += 1) {
    await files.put(`responses-items/v1/expires/orphans/${index}.gz`, new Uint8Array([1]));
  }

  await sweepResponsesState(now + 60 * 60 * 1000);
  expect(await repo.responsesMaintenance.getV1NextExpiryHour()).not.toBeNull();
  expect(await files.listKeys('responses-items/v1/')).toHaveLength(1);

  await sweepResponsesState(now + 60 * 60 * 1000);
  expect(await repo.responsesMaintenance.getV1NextExpiryHour()).toBeNull();
  expect(await files.listKeys('responses-items/v1/')).toEqual([]);
});
