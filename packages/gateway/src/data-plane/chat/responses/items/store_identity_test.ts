import { test } from 'vitest';

import { createStoredResponsesItemId } from './format.ts';
import { createResponsesHttpStore, type StatefulResponsesStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assert, assertEquals, assertExists } from '@floway-dev/test-utils';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_responses_item_identity';

const loadAndStage = async (store: StatefulResponsesStore, input: readonly ResponsesInputItem[]): Promise<void> => {
  await store.loadInputItems({
    sourceItems: input,
    view: responsesItemsView,
    inputItemsToStage: input,
  });
  await store.stageInputItems(input);
};

test('changed input payload with a stable client id persists as a distinct input row', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const first: ResponsesInputItem = { type: 'message', id: 'client_message_1', role: 'user', content: 'first' };
  const second: ResponsesInputItem = { type: 'message', id: 'client_message_1', role: 'user', content: 'second' };

  const firstStore = createResponsesHttpStore(API_KEY_ID, true);
  await loadAndStage(firstStore, [first]);
  await firstStore.commitSnapshot('resp_first', 'append');

  const secondStore = createResponsesHttpStore(API_KEY_ID, true);
  await loadAndStage(secondStore, [second]);
  await secondStore.commitSnapshot('resp_second', 'append');

  const firstSnapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_first');
  const secondSnapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_second');
  assertExists(firstSnapshot);
  assertExists(secondSnapshot);
  assertEquals(firstSnapshot.itemIds.length, 1);
  assertEquals(secondSnapshot.itemIds.length, 1);
  assert(firstSnapshot.itemIds[0] !== secondSnapshot.itemIds[0]);
  const rows = await repo.responsesItems.lookupMany(API_KEY_ID, [firstSnapshot.itemIds[0]!, secondSnapshot.itemIds[0]!]);
  const payloads = await repo.responsesItems.lookupPayloads(API_KEY_ID, [firstSnapshot.itemIds[0]!, secondSnapshot.itemIds[0]!]);
  assertEquals(rows.map(row => row.origin), ['input', 'input']);
  assertEquals(payloads.map(record => record.payload.item), [first, second]);
});

test('metadata-only durable item accepts a full payload repair', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const item: StoredResponsesItem = {
    id: createStoredResponsesItemId('message'),
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_responses',
    upstreamItemId: 'raw_message_1',
    itemType: 'message',
    origin: 'upstream',
    payload: null,
    contentHash: null,
    encryptedContentHash: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([item]);
  const input: ResponsesInputItem = { type: 'message', id: item.id, role: 'assistant', content: 'repaired' };
  const store = createResponsesHttpStore(API_KEY_ID, true);

  await loadAndStage(store, [input]);
  await store.commitSnapshot('resp_repaired', 'append');

  const [repaired] = await repo.responsesItems.lookupMany(API_KEY_ID, [item.id]);
  const [payload] = await repo.responsesItems.lookupPayloads(API_KEY_ID, [item.id]);
  assertExists(repaired);
  assertEquals(repaired.origin, 'upstream');
  assertEquals(payload.payload.item, input);
  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_repaired');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [item.id]);
});
