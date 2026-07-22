import { describe, expect, test, vi } from 'vitest';

import { hashResponsesItemContent } from './identity.ts';
import { createNonResponsesSourceStore, createResponsesHttpStore, createResponsesWsSession } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { SqlRepo } from '../../../../repo/sql.ts';
import { createSqliteTestDb } from '../../../../repo/test-sqlite.ts';
import { testResponsesStateLifetime, testResponsesStatePolicy, TEST_RESPONSES_RETENTION_SECONDS, TEST_RESPONSES_STATE_EPOCH } from '../../../../test-helpers/responses-state.ts';
import type { SqlDatabase, SqlPreparedStatement } from '@floway-dev/platform';

const storedRow = async (id: string, item: unknown, refreshedAt: number) => {
  const payload = { item };
  return {
    id,
    apiKeyId: 'key-a',
    stateEpoch: TEST_RESPONSES_STATE_EPOCH,
    payload,
    contentHash: await hashResponsesItemContent(item),
    payloadHash: await hashResponsesItemContent(payload),
    payloadFileKey: null,
    ...testResponsesStateLifetime(refreshedAt),
  };
};

describe('StatefulResponsesStore', () => {
  test('retention off performs no durable lookup or persistence queries', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const itemLookup = vi.spyOn(repo.responsesItems, 'lookupActiveMany');
    const hashLookup = vi.spyOn(repo.responsesItems, 'lookupActiveManyByContentHash');
    const snapshotLookup = vi.spyOn(repo.responsesSnapshots, 'lookupActive');
    const insert = vi.spyOn(repo.responsesItems, 'insertMany');
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a', 0), true);

    const reference = { type: 'item_reference' as const, id: 'msg_missing' };
    await store.loadInputItems([reference], [reference]);
    expect(store.getItemById(reference.id)).toBeUndefined();
    expect(await store.loadSnapshot('resp_missing')).toBeNull();
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'not persisted' }]);

    expect(itemLookup).not.toHaveBeenCalled();
    expect(hashLookup).not.toHaveBeenCalled();
    expect(snapshotLookup).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('HTTP store=false performs no state writes', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), false);
    expect(store.writesState).toBe(false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.commitSnapshot('resp_none', 'append', []);
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_none')).toBeNull();
  });

  test('HTTP store=false skips snapshot staging for idless input', async () => {
    initRepo(new InMemoryRepo());
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);

    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  test('HTTP store=false still reads durably-stored items and snapshots', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const writer = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    const output = { type: 'message' as const, id: 'msg_public', role: 'assistant' as const, content: [] };
    await writer.persistOutputItem(output);
    await writer.commitSnapshot('resp_saved', 'append', [output.id]);

    // A store=false turn writes nothing but must still resolve a
    // previous_response_id and echoed item ids against durable state.
    const reader = createResponsesHttpStore(testResponsesStatePolicy('key-a'), false);
    expect(reader.writesState).toBe(false);
    expect((await reader.loadSnapshot('resp_saved'))?.itemIds).toEqual([output.id]);
    expect(reader.getItemById(output.id)).toMatchObject({ id: 'msg_public' });
  });

  test('HTTP default stores complete input and output snapshots', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), undefined);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    const output = { type: 'message' as const, id: 'msg_public', role: 'assistant' as const, content: [] };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_saved', 'append', [output.id]);

    const snapshot = await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_saved');
    expect(snapshot?.itemIds).toHaveLength(2);
    const [storedOutput] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [output.id]);
    expect(storedOutput.payload.item).toEqual(output);
    expect(storedOutput.refreshedAt).toBeGreaterThanOrEqual(snapshot!.refreshedAt);
  });

  test('replace snapshots persist only their output state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'discarded history' };
    await store.stageInputItems([input]);
    const output = { type: 'compaction' as const, id: 'cmp_public', encrypted_content: 'opaque' };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_compact', 'replace', [output.id]);

    expect(await repo.responsesItems.lookupManyByContentHash('key-a', TEST_RESPONSES_STATE_EPOCH, [await hashResponsesItemContent(input)])).toEqual([]);
    expect((await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_compact'))?.itemIds).toEqual([output.id]);
  });

  test('append snapshots refresh the lifetime of every referenced item', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const nearExpiry = Date.now() - TEST_RESPONSES_RETENTION_SECONDS * 1000 + 60_000;
    const item = await storedRow('msg_old', { type: 'message', id: 'msg_old', role: 'assistant', content: [] }, nearExpiry);
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesSnapshots.insert({
      id: 'resp_old',
      apiKeyId: 'key-a',
      stateEpoch: TEST_RESPONSES_STATE_EPOCH,
      itemIds: [item.id],
      ...testResponsesStateLifetime(nearExpiry),
    });
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    expect(await store.loadSnapshot('resp_old')).not.toBeNull();
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id])).toHaveLength(1);
    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_old')).not.toBeNull();
    await store.commitSnapshot('resp_new', 'append', []);

    const [refreshed] = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [item.id]);
    expect(refreshed.refreshedAt).toBeGreaterThan(nearExpiry);
    expect((await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_new'))?.itemIds).toEqual([item.id]);
  });

  test('append snapshots refresh direct-id and content-hash input reuse', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    const directInput = { type: 'message' as const, id: 'msg_direct', role: 'user' as const, content: 'direct' };
    const hashedInput = { type: 'message' as const, role: 'user' as const, content: 'hashed' };
    const nearExpiry = Date.now() - TEST_RESPONSES_RETENTION_SECONDS * 1000 + 60_000;
    const directRow = await storedRow(directInput.id, directInput, nearExpiry);
    const hashedRow = await storedRow('msg_hashed', hashedInput, nearExpiry);
    await repo.responsesItems.insertMany([directRow, hashedRow], 0);
    await store.loadInputItems([directInput, hashedInput], [directInput, hashedInput]);
    await store.stageInputItems([directInput, hashedInput]);
    await store.commitSnapshot('resp_reused', 'append', []);

    const refreshed = await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [directRow.id, hashedRow.id]);
    expect(refreshed.every(row => row.refreshedAt > nearExpiry)).toBe(true);
    const snapshot = await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_reused');
    expect(snapshot?.itemIds).toEqual([directRow.id, hashedRow.id]);
    expect(snapshot?.refreshedAt).toBe(Math.min(...refreshed.map(row => row.refreshedAt)));
  });

  test('snapshot lifetime follows a newer backing item timestamp', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'future lifetime' };
    const futureRefreshedAt = Date.now() + 60_000;
    const row = await storedRow('msg_future', input, futureRefreshedAt);
    await repo.responsesItems.insertMany([row], 0);
    await store.loadInputItems([input], [input]);
    await store.stageInputItems([input]);
    await store.commitSnapshot('resp_future', 'append', []);

    expect((await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, [row.id]))[0].refreshedAt).toBe(futureRefreshedAt);
    expect((await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_future'))?.refreshedAt).toBe(futureRefreshedAt);
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const session = createResponsesWsSession();
    const first = session.createStore(testResponsesStatePolicy('key-a'), false);
    expect(first.writesState).toBe(true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append', []);

    expect(await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_local')).toBeNull();
    expect(await session.createStore(testResponsesStatePolicy('key-a'), false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('WebSocket local state remains available with durable retention off', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const itemLookup = vi.spyOn(repo.responsesItems, 'lookupActiveMany');
    const snapshotLookup = vi.spyOn(repo.responsesSnapshots, 'lookupActive');
    const insert = vi.spyOn(repo.responsesItems, 'insertMany');
    const session = createResponsesWsSession();
    const policy = testResponsesStatePolicy('key-a', 0);
    const first = session.createStore(policy, true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await first.commitSnapshot('resp_local_off', 'append', []);

    expect(await session.createStore(policy, false).loadSnapshot('resp_local_off')).not.toBeNull();
    expect(itemLookup).not.toHaveBeenCalled();
    expect(snapshotLookup).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  test('WebSocket store=true promotes every item referenced by a prior local snapshot', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const session = createResponsesWsSession();
    const local = session.createStore(testResponsesStatePolicy('key-a'), false);
    await local.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await local.commitSnapshot('resp_local', 'append', []);

    const durable = session.createStore(testResponsesStatePolicy('key-a'), true);
    expect(await durable.loadSnapshot('resp_local')).not.toBeNull();
    await durable.stageInputItems([{ type: 'message', role: 'user', content: 'durable' }]);
    await durable.commitSnapshot('resp_durable', 'append', []);

    const snapshot = await repo.responsesSnapshots.lookup('key-a', TEST_RESPONSES_STATE_EPOCH, 'resp_durable');
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected durable snapshot');
    expect(await repo.responsesItems.lookupMany('key-a', TEST_RESPONSES_STATE_EPOCH, snapshot.itemIds)).toHaveLength(snapshot.itemIds.length);
  });

  test('a durable snapshot used on WebSocket remains local after durable retention is disabled', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const policy = testResponsesStatePolicy('key-a');
    const durableWriter = createResponsesHttpStore(policy, true);
    const output = { type: 'message' as const, id: 'msg_durable', role: 'assistant' as const, content: [] };
    await durableWriter.persistOutputItem(output);
    await durableWriter.commitSnapshot('resp_durable_source', 'append', [output.id]);

    const session = createResponsesWsSession();
    expect(await session.createStore(policy, true).loadSnapshot('resp_durable_source')).not.toBeNull();
    const disabledPolicy = { ...policy, stateEpoch: '22'.repeat(16), retentionSeconds: 0 };

    expect(await session.createStore(disabledPolicy, true).loadSnapshot('resp_durable_source')).not.toBeNull();
  });

  test('per-attempt private payloads reset on each beginAttempt', () => {
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    store.beginAttempt(new Map([['item', { first: true }]]));

    expect(store.getPrivatePayload('item')).toEqual({ first: true });

    store.registerPrivatePayload('ws_aabbccdd', { value: 2 });
    expect(store.getPrivatePayload('ws_aabbccdd')).toEqual({ value: 2 });

    store.beginAttempt(new Map());
    expect(store.getPrivatePayload('item')).toBeUndefined();
    expect(store.getPrivatePayload('ws_aabbccdd')).toBeUndefined();
  });

  test('non-Responses-source store holds request-private tool state but persists and reads nothing', async () => {
    // Translated sources (Messages/Gemini/Chat) still run the server-tool shim,
    // whose per-attempt private-payload scratchpad lives on the store; the
    // no-backing store keeps that working without any durable state.
    const store = createNonResponsesSourceStore('key-a');
    expect(store.writesState).toBe(false);
    store.beginAttempt(new Map());
    store.registerPrivatePayload('ws_aabbccdd', { ir: 'search result' });
    expect(store.getPrivatePayload('ws_aabbccdd')).toEqual({ ir: 'search result' });
    expect(store.getItemById('anything')).toBeUndefined();
    expect(await store.loadSnapshot('resp_x')).toBeNull();
  });

  test('large durable snapshot reads stay within the persistence query budget', async () => {
    const base = await createSqliteTestDb();
    const seedRepo = new SqlRepo(base);
    const refreshedAt = Date.now();
    const items = Array.from({ length: 1_413 }, (_, index) => {
      const item = { type: 'message', id: `msg_${index}`, role: 'assistant', content: [] };
      const payload = { item };
      return {
        id: item.id,
        apiKeyId: 'key-a',
        stateEpoch: TEST_RESPONSES_STATE_EPOCH,
        payload,
        contentHash: `content-${index}`,
        payloadHash: `payload-${index}`,
        payloadFileKey: null,
        ...testResponsesStateLifetime(refreshedAt),
      };
    });
    await seedRepo.responsesItems.insertMany(items, refreshedAt);
    await seedRepo.responsesSnapshots.insert({
      id: 'resp_large',
      apiKeyId: 'key-a',
      stateEpoch: TEST_RESPONSES_STATE_EPOCH,
      itemIds: items.map(item => item.id),
      ...testResponsesStateLifetime(refreshedAt),
    });

    let queries = 0;
    const countedStatement = (statement: SqlPreparedStatement): SqlPreparedStatement => ({
      bind: (...values) => countedStatement(statement.bind(...values)),
      first: async <T>() => {
        queries += 1;
        return await statement.first<T>();
      },
      all: async <T>() => {
        queries += 1;
        return await statement.all<T>();
      },
      run: async () => {
        queries += 1;
        return await statement.run();
      },
    });
    const countedDb: SqlDatabase = {
      prepare: query => countedStatement(base.prepare(query)),
      exec: sql => base.exec(sql),
    };
    initRepo(new SqlRepo(countedDb));

    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    expect(await store.loadSnapshot('resp_large')).not.toBeNull();
    expect(queries).toBeLessThanOrEqual(20);

    const nearExpiry = Date.now() - TEST_RESPONSES_RETENTION_SECONDS * 1000 + 60 * 60 * 1000;
    await base.prepare('UPDATE responses_state_items SET refreshed_at = ?, expires_at = ?')
      .bind(nearExpiry, nearExpiry + TEST_RESPONSES_RETENTION_SECONDS * 1000)
      .run();
    await base.prepare('UPDATE responses_state_snapshots SET refreshed_at = ?, expires_at = ?')
      .bind(nearExpiry, nearExpiry + TEST_RESPONSES_RETENTION_SECONDS * 1000)
      .run();
    queries = 0;
    expect(await createResponsesHttpStore(testResponsesStatePolicy('key-a'), true).loadSnapshot('resp_large')).not.toBeNull();
    expect(queries).toBeLessThanOrEqual(35);

    const newItems = items.map((item, index) => ({ ...item, id: `msg_new_${index}`, payloadHash: `new-payload-${index}` }));
    queries = 0;
    await new SqlRepo(countedDb).responsesItems.insertMany(newItems, Date.now());
    expect(queries).toBeLessThanOrEqual(25);
  });
});
