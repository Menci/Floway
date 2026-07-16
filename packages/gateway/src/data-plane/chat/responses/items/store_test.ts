import { describe, expect, test } from 'vitest';

import { hashResponsesItemContent } from './format.ts';
import { createResponsesHttpStore, createResponsesWsSession } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';

describe('StatefulResponsesStore', () => {
  test('HTTP store=false performs no state writes', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', false);
    expect(store.writesState).toBe(false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.commitSnapshot('resp_none', 'append');
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_none')).toBeNull();
  });

  test('HTTP default stores complete input and output snapshots', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', undefined);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      contentHash: 'output-hash',
      createdAt: 1_000,
    };
    store.stageOutputItem(output, 0);
    await store.commitSnapshot('resp_saved', 'append');

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_saved');
    expect(snapshot?.itemIds).toHaveLength(2);
    const [storedOutput] = await repo.responsesItems.lookupMany('key-a', [output.id]);
    expect(storedOutput).toMatchObject({ ...output, createdAt: snapshot?.createdAt });
  });

  test('replace snapshots persist only their output state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'discarded history' };
    await store.stageInputItems([input]);
    const output = {
      id: 'cmp_public',
      apiKeyId: 'key-a',
      itemType: 'compaction',
      payload: { item: { type: 'compaction', id: 'cmp_public', encrypted_content: 'opaque' } },
      contentHash: 'output-hash',
      createdAt: 1_000,
    };
    store.stageOutputItem(output, 0);
    await store.commitSnapshot('resp_compact', 'replace');

    expect(await repo.responsesItems.lookupManyByContentHash('key-a', [await hashResponsesItemContent(input)])).toEqual([]);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_compact'))?.itemIds).toEqual([output.id]);
  });

  test('stages compaction_summary metadata under its canonical item type', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', true);
    const item = { type: 'compaction_summary', id: 'cmp_client', encrypted_content: 'opaque' } as unknown as Parameters<typeof store.stageInputItems>[0][number];
    await store.stageInputItems([item]);
    await store.commitSnapshot('resp_summary', 'append');

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_summary');
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected Responses snapshot');
    const rows = await repo.responsesItems.lookupMany('key-a', snapshot.itemIds);
    expect(rows[0].itemType).toBe('compaction');
  });

  test('append snapshots refresh the lifetime of every referenced item', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const item = {
      id: 'msg_old',
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: { type: 'message', id: 'msg_old', role: 'assistant', content: [] } },
      contentHash: 'old-hash',
      createdAt: 1,
    };
    await repo.responsesItems.insertMany([item]);
    await repo.responsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [item.id], createdAt: 1 });
    const store = createResponsesHttpStore('key-a', true);
    expect(await store.loadSnapshot('resp_old')).not.toBeNull();
    await repo.responsesItems.deleteOlderThan(2);
    await repo.responsesSnapshots.deleteOlderThan(2);
    expect(await repo.responsesItems.lookupMany('key-a', [item.id])).toHaveLength(1);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_old')).not.toBeNull();
    await store.commitSnapshot('resp_new', 'append');

    const [refreshed] = await repo.responsesItems.lookupMany('key-a', [item.id]);
    expect(refreshed.createdAt).toBeGreaterThan(1);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_new'))?.itemIds).toEqual([item.id]);
    await repo.responsesItems.deleteOlderThan(2);
    expect(await repo.responsesItems.lookupMany('key-a', [item.id])).toHaveLength(1);
  });

  test('append snapshots refresh direct-id and content-hash input reuse', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', true);
    const directInput = { type: 'message' as const, id: 'msg_direct', role: 'user' as const, content: 'direct' };
    const hashedInput = { type: 'message' as const, role: 'user' as const, content: 'hashed' };
    const directRow = {
      id: directInput.id,
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: directInput },
      contentHash: await hashResponsesItemContent(directInput),
      createdAt: 1,
    };
    const hashedRow = {
      id: 'msg_hashed',
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: hashedInput },
      contentHash: await hashResponsesItemContent(hashedInput),
      createdAt: 1,
    };
    await repo.responsesItems.insertMany([directRow, hashedRow]);
    await store.loadInputItems([directInput, hashedInput], [directInput, hashedInput]);
    await store.stageInputItems([directInput, hashedInput]);
    await store.commitSnapshot('resp_reused', 'append');

    const refreshed = await repo.responsesItems.lookupMany('key-a', [directRow.id, hashedRow.id]);
    expect(refreshed.every(row => row.createdAt > 1)).toBe(true);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_reused'))?.itemIds).toEqual([directRow.id, hashedRow.id]);
  });

  test('snapshot lifetime follows a newer backing item timestamp', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'future lifetime' };
    const futureCreatedAt = Date.now() + 60_000;
    const row = {
      id: 'msg_future',
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: input },
      contentHash: await hashResponsesItemContent(input),
      createdAt: futureCreatedAt,
    };
    await repo.responsesItems.insertMany([row]);
    await store.loadInputItems([input], [input]);
    await store.stageInputItems([input]);
    await store.commitSnapshot('resp_future', 'append');

    expect((await repo.responsesItems.lookupMany('key-a', [row.id]))[0].createdAt).toBe(futureCreatedAt);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_future'))?.createdAt).toBe(futureCreatedAt);
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const session = createResponsesWsSession();
    const first = session.createStore('key-a', false);
    expect(first.writesState).toBe(true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append');

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_local')).toBeNull();
    expect(await session.createStore('key-a', false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('WebSocket store=true promotes every item referenced by a prior local snapshot', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const session = createResponsesWsSession();
    const local = session.createStore('key-a', false);
    await local.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await local.commitSnapshot('resp_local', 'append');

    const durable = session.createStore('key-a', true);
    expect(await durable.loadSnapshot('resp_local')).not.toBeNull();
    await durable.stageInputItems([{ type: 'message', role: 'user', content: 'durable' }]);
    await durable.commitSnapshot('resp_durable', 'append');

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_durable');
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected durable snapshot');
    expect(await repo.responsesItems.lookupMany('key-a', snapshot.itemIds)).toHaveLength(snapshot.itemIds.length);
  });
});
