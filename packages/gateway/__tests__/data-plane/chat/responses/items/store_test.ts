import { afterEach, describe, expect, test, vi } from 'vitest';

import { hashResponsesItem } from '../../../../../src/data-plane/chat/responses/items/identity.ts';
import { createNonResponsesSourceStore, createResponsesHttpStore, createResponsesWsSession } from '../../../../../src/data-plane/chat/responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { quantizeResponsesRefreshedAt } from '../../../../../src/repo/responses-retention.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_RESPONSES_RETENTION_SECONDS, testResponsesStatePolicy } from '../test-policy.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DAY = Date.UTC(2026, 0, 10);

afterEach(() => vi.useRealTimers());

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    responsesRetentionSeconds: TEST_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

describe('StatefulResponsesStore', () => {
  test('HTTP store=false performs no state writes', async () => {
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), false);
    expect(store.writesState).toBe(false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.commitSnapshot('resp_none', 'append', []);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_none', 0)).toBeNull();
  });

  test('HTTP store=false skips snapshot staging for idless input', async () => {
    initRepo(new InMemoryRepo());
    const digest = vi.spyOn(crypto.subtle, 'digest');
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);

    expect(digest).not.toHaveBeenCalled();
    digest.mockRestore();
  });

  test('HTTP store=false still reads durably-stored items and snapshots', async () => {
    installRepo();
    const writer = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await writer.persistOutputItem(output);
    await writer.commitSnapshot('resp_saved', 'append', [output.id]);

    // A store=false turn writes nothing but must still resolve a
    // previous_response_id and echoed item ids against durable state.
    const reader = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), false);
    expect(reader.writesState).toBe(false);
    expect((await reader.loadSnapshot('resp_saved'))?.itemIds).toEqual([output.id]);
    expect(reader.getItemById(output.id)).toMatchObject({ id: 'msg_public' });
  });

  test('HTTP default stores complete input and output snapshots', async () => {
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), undefined);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_saved', 'append', [output.id]);

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_saved', 0);
    expect(snapshot?.itemIds).toHaveLength(2);
    const [storedOutput] = await repo.responsesItems.lookupMany('key-a', [output.id], 0);
    expect(storedOutput).toMatchObject({ ...output, refreshedAt: snapshot?.refreshedAt });
  });

  test('replace snapshots persist only their output state', async () => {
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'discarded history' };
    await store.stageInputItems([input]);
    const output = {
      id: 'cmp_public',
      apiKeyId: 'key-a',
      payload: { item: { type: 'compaction', id: 'cmp_public', encrypted_content: 'opaque' } },
      itemHash: 'output-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await store.commitSnapshot('resp_compact', 'replace', [output.id]);

    expect(await repo.responsesItems.lookupManyByItemHash('key-a', [await hashResponsesItem(input)], 0)).toEqual([]);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_compact', 0))?.itemIds).toEqual([output.id]);
  });

  test('append snapshots refresh the lifetime of every referenced item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const initialRefreshedAt = TEST_DAY - DAY_MS / 2;
    const item = {
      id: 'msg_old',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_old', role: 'assistant', content: [] } },
      itemHash: 'old-hash',
      refreshedAt: initialRefreshedAt,
    };
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: initialRefreshedAt });
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    expect(await store.loadSnapshot('resp_old')).not.toBeNull();
    expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_old', 0)).not.toBeNull();
    await store.commitSnapshot('resp_new', 'append', []);

    const [refreshed] = await repo.responsesItems.lookupMany('key-a', [item.id], 0);
    expect(refreshed.refreshedAt).toBe(TEST_DAY);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_new', 0))?.itemIds).toEqual([item.id]);
    expect(await repo.responsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
  });

  test('same-day snapshot reuse does not call the durable item refresher', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const item = {
      id: 'msg_current_day',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_current_day', role: 'assistant', content: [] } },
      itemHash: 'current-day-hash',
      refreshedAt: TEST_DAY + 1_000,
    };
    await repo.responsesItems.insertMany([item], 0);
    await repo.responsesSnapshots.insert({ id: 'resp_current_day', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: item.refreshedAt });
    const refreshItems = vi.spyOn(repo.responsesItems, 'refreshMany');

    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    expect(await store.loadSnapshot('resp_current_day')).not.toBeNull();
    await store.commitSnapshot('resp_current_day_next', 'append', []);

    expect(refreshItems).not.toHaveBeenCalled();
  });

  test('a store crossing UTC midnight refreshes items into the new day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS - 1_000);
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg_before_midnight',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_before_midnight', role: 'assistant', content: [] } },
      itemHash: 'before-midnight-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);

    vi.setSystemTime(TEST_DAY + DAY_MS + 1_000);
    await store.commitSnapshot('resp_after_midnight', 'append', [output.id]);

    expect((await repo.responsesItems.lookupMany('key-a', [output.id], 0))[0].refreshedAt).toBe(TEST_DAY + DAY_MS);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_after_midnight', 0))?.refreshedAt).toBe(TEST_DAY + DAY_MS);
  });

  test('a request keeps its retention snapshot when the visibility window ends mid-request', async () => {
    vi.useFakeTimers();
    const retentionSeconds = 24 * 60 * 60;
    const requestStartedAt = TEST_DAY + 2 * DAY_MS - 1_000;
    vi.setSystemTime(requestStartedAt);
    const repo = installRepo();
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: retentionSeconds });
    const item = {
      id: 'msg_cutoff_edge',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_cutoff_edge', role: 'assistant', content: [] } },
      itemHash: 'cutoff-edge-hash',
      refreshedAt: TEST_DAY + DAY_MS,
    };
    await repo.responsesItems.insertMany([item], 0);
    const store = createResponsesHttpStore({ id: 'key-a', responsesRetentionSeconds: retentionSeconds }, requestStartedAt, true);

    vi.setSystemTime(TEST_DAY + 3 * DAY_MS + 1_000);
    const reference = { type: 'item_reference' as const, id: item.id };
    await store.loadInputItems([reference], []);
    await store.stageInputItems([reference]);
    await store.commitSnapshot('resp_after_cutoff', 'append', []);

    expect((await repo.responsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt)
      .toBe(TEST_DAY + 3 * DAY_MS);
  });

  test('append snapshots refresh direct-id and content-hash input reuse', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const directInput = { type: 'message' as const, id: 'msg_direct', role: 'user' as const, content: 'direct' };
    const hashedInput = { type: 'message' as const, role: 'user' as const, content: 'hashed' };
    const initialRefreshedAt = TEST_DAY - DAY_MS / 2;
    const directRow = {
      id: directInput.id,
      apiKeyId: 'key-a',
      payload: { item: directInput },
      itemHash: await hashResponsesItem(directInput),
      refreshedAt: initialRefreshedAt,
    };
    const hashedRow = {
      id: 'msg_hashed',
      apiKeyId: 'key-a',
      payload: { item: hashedInput },
      itemHash: await hashResponsesItem(hashedInput),
      refreshedAt: initialRefreshedAt,
    };
    await repo.responsesItems.insertMany([directRow, hashedRow], 0);
    await store.loadInputItems([directInput, hashedInput], [directInput, hashedInput]);
    await store.stageInputItems([directInput, hashedInput]);
    await store.commitSnapshot('resp_reused', 'append', []);

    const refreshed = await repo.responsesItems.lookupMany('key-a', [directRow.id, hashedRow.id], 0);
    expect(refreshed.every(row => row.refreshedAt === TEST_DAY)).toBe(true);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_reused', 0))?.itemIds).toEqual([directRow.id, hashedRow.id]);
  });

  test('snapshot lifetime follows a newer backing item timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS / 2);
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const input = { type: 'message' as const, role: 'user' as const, content: 'future lifetime' };
    const futureRefreshedAt = TEST_DAY + DAY_MS + 60_000;
    const quantizedFutureRefreshedAt = quantizeResponsesRefreshedAt(futureRefreshedAt);
    const row = {
      id: 'msg_future',
      apiKeyId: 'key-a',
      payload: { item: input },
      itemHash: await hashResponsesItem(input),
      refreshedAt: futureRefreshedAt,
    };
    await repo.responsesItems.insertMany([row], 0);
    await store.loadInputItems([input], [input]);
    await store.stageInputItems([input]);
    await store.commitSnapshot('resp_future', 'append', []);

    expect((await repo.responsesItems.lookupMany('key-a', [row.id], 0))[0].refreshedAt).toBe(quantizedFutureRefreshedAt);
    expect((await repo.responsesSnapshots.lookup('key-a', 'resp_future', 0))?.refreshedAt).toBe(quantizedFutureRefreshedAt);
  });

  test('disable between output-item done and terminal preserves the in-flight request snapshot', async () => {
    const repo = installRepo();
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg-before-disable',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg-before-disable', role: 'assistant', content: [] } },
      itemHash: 'before-disable-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await repo.apiKeys.update('key-a', { responsesRetentionSeconds: 0 });
    await store.commitSnapshot('resp-after-disable', 'append', [output.id]);

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp-after-disable', 0)).not.toBeNull();
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = installRepo();
    const session = createResponsesWsSession();
    const first = session.createStore(testResponsesStatePolicy(), Date.now(), false);
    expect(first.writesState).toBe(true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append', []);

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_local', 0)).toBeNull();
    expect(await session.createStore(testResponsesStatePolicy(), Date.now(), false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('WebSocket store=true promotes every item referenced by a prior local snapshot', async () => {
    const repo = installRepo();
    const session = createResponsesWsSession();
    const local = session.createStore(testResponsesStatePolicy(), Date.now(), false);
    await local.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await local.commitSnapshot('resp_local', 'append', []);

    const durable = session.createStore(testResponsesStatePolicy(), Date.now(), true);
    expect(await durable.loadSnapshot('resp_local')).not.toBeNull();
    await durable.stageInputItems([{ type: 'message', role: 'user', content: 'durable' }]);
    await durable.commitSnapshot('resp_durable', 'append', []);

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_durable', 0);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected durable snapshot');
    expect(await repo.responsesItems.lookupMany('key-a', snapshot.itemIds, 0)).toHaveLength(snapshot.itemIds.length);
  });

  test('per-attempt private payloads reset on each beginAttempt', () => {
    const store = createResponsesHttpStore(testResponsesStatePolicy(), Date.now(), true);
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
});
