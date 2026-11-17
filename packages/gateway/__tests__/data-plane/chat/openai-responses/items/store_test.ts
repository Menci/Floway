import { afterEach, describe, expect, test, vi } from 'vitest';

import { hashOpenAIResponsesItem } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { createOpenAIResponsesHttpStore, createOpenAIResponsesWsSession } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DAY = Date.UTC(2026, 0, 10);

afterEach(() => vi.useRealTimers());

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

describe('OpenAIResponsesStatefulStore', () => {
  test('HTTP store=false performs no state writes', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(store.writesState).toBe(false);

    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.commitSnapshot('resp_none', 'append', []);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_none', 0)).toBeNull();
  });

  test('HTTP store=false still reads durably-stored items and snapshots', async () => {
    installRepo();
    const writer = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
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
    const reader = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(reader.writesState).toBe(false);
    expect((await reader.loadSnapshot('resp_saved'))?.itemIds).toEqual([output.id]);
    expect(reader.getItemById(output.id)).toMatchObject({ id: 'msg_public' });
  });

  test('replace snapshots persist only their output state', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
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

    expect(await repo.openaiResponsesItems.lookupManyByItemHash('key-a', [await hashOpenAIResponsesItem(input)], 0)).toEqual([]);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_compact', 0))?.itemIds).toEqual([output.id]);
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
    await repo.openaiResponsesItems.insertMany([item], 0);
    await repo.openaiResponsesSnapshots.insert({ id: 'resp_old', apiKeyId: 'key-a', itemIds: [item.id], refreshedAt: initialRefreshedAt });
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(await store.loadSnapshot('resp_old')).not.toBeNull();
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_old', 0)).not.toBeNull();
    await store.commitSnapshot('resp_new', 'append', []);

    const [refreshed] = await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0);
    expect(refreshed.refreshedAt).toBe(TEST_DAY);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_new', 0))?.itemIds).toEqual([item.id]);
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toHaveLength(1);
  });

  test('a store crossing UTC midnight refreshes items into the new day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(TEST_DAY + DAY_MS - 1_000);
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
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

    expect((await repo.openaiResponsesItems.lookupMany('key-a', [output.id], 0))[0].refreshedAt).toBe(TEST_DAY + DAY_MS);
    expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_after_midnight', 0))?.refreshedAt).toBe(TEST_DAY + DAY_MS);
  });

  test('a request keeps its retention snapshot when the visibility window ends mid-request', async () => {
    vi.useFakeTimers();
    const retentionSeconds = 24 * 60 * 60;
    const requestStartedAt = TEST_DAY + 2 * DAY_MS - 1_000;
    vi.setSystemTime(requestStartedAt);
    const repo = installRepo();
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: retentionSeconds });
    const item = {
      id: 'msg_cutoff_edge',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg_cutoff_edge', role: 'assistant', content: [] } },
      itemHash: 'cutoff-edge-hash',
      refreshedAt: TEST_DAY + DAY_MS,
    };
    await repo.openaiResponsesItems.insertMany([item], 0);
    const store = createOpenAIResponsesHttpStore({ id: 'key-a', openaiResponsesRetentionSeconds: retentionSeconds }, requestStartedAt, true);

    vi.setSystemTime(TEST_DAY + 3 * DAY_MS + 1_000);
    const reference = { type: 'item_reference' as const, id: item.id };
    await store.loadInputItems([reference], []);
    await store.stageInputItems([reference]);
    await store.commitSnapshot('resp_after_cutoff', 'append', []);

    expect((await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0))[0].refreshedAt)
      .toBe(TEST_DAY + 3 * DAY_MS);
  });

  test('disable between output-item done and terminal preserves the in-flight request snapshot', async () => {
    const repo = installRepo();
    const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    const output = {
      id: 'msg-before-disable',
      apiKeyId: 'key-a',
      payload: { item: { type: 'message', id: 'msg-before-disable', role: 'assistant', content: [] } },
      itemHash: 'before-disable-hash',
      refreshedAt: Date.now(),
    };
    await store.persistOutputItem(output);
    await repo.apiKeys.update('key-a', { openaiResponsesRetentionSeconds: 0 });
    await store.commitSnapshot('resp-after-disable', 'append', [output.id]);

    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp-after-disable', 0)).not.toBeNull();
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const first = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    expect(first.writesState).toBe(true);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append', []);

    expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_local', 0)).toBeNull();
    expect(await session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('WebSocket store=true promotes every item referenced by a prior local snapshot', async () => {
    const repo = installRepo();
    const session = createOpenAIResponsesWsSession();
    const local = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
    await local.stageInputItems([{ type: 'message', role: 'user', content: 'local' }]);
    await local.commitSnapshot('resp_local', 'append', []);

    const durable = session.createStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
    expect(await durable.loadSnapshot('resp_local')).not.toBeNull();
    await durable.stageInputItems([{ type: 'message', role: 'user', content: 'durable' }]);
    await durable.commitSnapshot('resp_durable', 'append', []);

    const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_durable', 0);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) throw new Error('Expected durable snapshot');
    expect(await repo.openaiResponsesItems.lookupMany('key-a', snapshot.itemIds, 0)).toHaveLength(snapshot.itemIds.length);
  });
});
