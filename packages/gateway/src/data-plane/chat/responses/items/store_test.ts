import { test, vi } from 'vitest';

import { createStoredResponsesItemId } from './format.ts';
import { createNonResponsesSourceStore, createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assert, assertEquals, assertExists } from '@floway-dev/test-utils';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_stateful_store';

const storedRow = (overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'itemType'>): StoredResponsesItem => ({
  apiKeyId: API_KEY_ID,
  upstreamId: null,
  upstreamItemId: null,
  origin: 'upstream',
  payload: { item: { type: overrides.itemType, id: overrides.id } },
  contentHash: null,
  encryptedContentHash: null,
  createdAt: 1_000,
  refreshedAt: 1_000,
  ...overrides,
});

test('stages programmatic tool items with their documented id prefixes and preserves every field', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const input: ResponsesInputItem[] = [
    {
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }],
    },
    {
      type: 'program',
      id: 'program_input_1',
      call_id: 'program_call_1',
      code: 'await exec("hello")',
      fingerprint: 'opaque-fingerprint',
    },
    {
      type: 'program_output',
      id: 'program_output_input_1',
      call_id: 'program_call_1',
      result: 'hello',
      status: 'completed',
    },
  ];
  const store = createResponsesHttpStore(API_KEY_ID, true);

  await store.stageInputItems(input);
  await store.commitSnapshot('resp_programmatic', 'append');

  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_programmatic');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds.length, 3);
  assert(snapshot.itemIds[0].startsWith('at_'));
  assert(snapshot.itemIds[1].startsWith('prog_'));
  assert(snapshot.itemIds[2].startsWith('prog_out_'));
  const payloads = await repo.responsesItems.lookupPayloads(API_KEY_ID, snapshot.itemIds);
  assertEquals(payloads.map(record => record.payload.item), input);
});

test('stages agent and context-compaction items with stable prefixes and preserves every field', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const input: ResponsesInputItem[] = [
    { type: 'agent_message', author: '/root/a', recipient: '/root', content: [{ type: 'input_text', text: 'done' }] },
    { type: 'multi_agent_call', action: 'spawn_agent', arguments: '{}', call_id: 'call_1' },
    { type: 'multi_agent_call_output', action: 'spawn_agent', call_id: 'call_1', output: [] },
    { type: 'context_compaction', encrypted_content: 'opaque' },
  ];
  const store = createResponsesHttpStore(API_KEY_ID, true);

  await store.stageInputItems(input);
  await store.commitSnapshot('resp_agents', 'append');

  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_agents');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds.map(id => id.slice(0, id.indexOf('_'))), ['amsg', 'mac', 'maco', 'cmp']);
  const payloads = await repo.responsesItems.lookupPayloads(API_KEY_ID, snapshot.itemIds);
  assertEquals(payloads.map(record => record.payload.item), input);
});

test('content-hash preload skips items already addressed by a stored id', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const lookupByContentHash = vi.spyOn(repo.responsesItems, 'lookupManyByContentHash');
  const storedId = createStoredResponsesItemId('message');
  const input: ResponsesInputItem[] = [
    { type: 'message', id: storedId, role: 'assistant', content: 'stored' },
    { type: 'message', id: 'client-message', role: 'user', content: 'new' },
  ];
  const store = createResponsesHttpStore(API_KEY_ID, true);

  await store.loadInputItems({ sourceItems: input, view: responsesItemsView, inputItemsToStage: input });

  assertEquals(lookupByContentHash.mock.calls.length, 1);
  assertEquals(lookupByContentHash.mock.calls[0][1].length, 1);
});

test('snapshots with non-replayable metadata-only rows load as missing', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const missingPayload = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'input',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([missingPayload]);
  await repo.responsesSnapshots.insert({
    id: 'resp_expired',
    apiKeyId: API_KEY_ID,
    itemIds: [missingPayload.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);

  assertEquals(await store.loadSnapshot('resp_expired'), null);
});

test('snapshots with upstream-owned metadata-only rows remain replayable', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const upstreamOwned = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([upstreamOwned]);
  await repo.responsesSnapshots.insert({
    id: 'resp_metadata',
    apiKeyId: API_KEY_ID,
    itemIds: [upstreamOwned.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);
  const snapshot = await store.loadSnapshot('resp_metadata');

  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [upstreamOwned.id]);
});

test('createNonResponsesSourceStore reads items for affinity but does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const item = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_msg_a',
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([item]);

  const store = createNonResponsesSourceStore(API_KEY_ID);

  // Items are still readable for affinity lookups.
  const input = [{ type: 'message', id: item.id, role: 'assistant', content: [] }] as unknown as ResponsesInputItem[];
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  assertExists(store.getItemById(item.id));

  // commitSnapshot is a no-op when snapshotWrites is empty.
  const outputItem: StoredResponsesItem = {
    ...item,
    id: createStoredResponsesItemId('message'),
    origin: 'upstream',
    payload: { item: { type: 'message', id: 'out_1', role: 'assistant', content: [] } },
  };
  store.beginAttempt(new Map());
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_new', 'append');

  // No snapshot was written because snapshotWrites is empty for non-Responses sources.
  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_new'), null);
});

test('createResponsesHttpStore with store=false does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, false);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
  });
  store.beginAttempt(new Map());
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_no_store', 'append');

  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_no_store'), null);
});

test('createResponsesHttpStore with store=true writes snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
    upstreamId: 'up_snap',
    upstreamItemId: 'raw_snap',
    payload: { item: { type: 'message', id: 'snap_1', role: 'assistant', content: [] } },
  });
  store.beginAttempt(new Map());
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_with_store', 'append');

  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_with_store');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [outputItem.id]);
});

test('committing a snapshot refreshes durable history without rewriting it', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const itemId = createStoredResponsesItemId('message');
  const inputItem: ResponsesInputItem = { type: 'message', id: itemId, role: 'assistant', content: [] };
  const item = storedRow({
    id: itemId,
    itemType: 'message',
    upstreamId: 'up_history',
    upstreamItemId: 'raw_history',
    payload: { item: inputItem },
  });
  await repo.responsesItems.insertMany([item]);
  const insertMany = vi.spyOn(repo.responsesItems, 'insertMany');
  const refreshMany = vi.spyOn(repo.responsesItems, 'refreshMany');
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const input = [inputItem];

  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  await store.stageInputItems(input);
  await store.commitSnapshot('resp_history', 'append');

  assertEquals(insertMany.mock.calls, []);
  assertEquals(refreshMany.mock.calls.length, 1);
  assertEquals(refreshMany.mock.calls[0]![0], API_KEY_ID);
  assertEquals(refreshMany.mock.calls[0]![1], [item.id]);
  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_history');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [item.id]);
});
