import { test } from 'vitest';

import { classifyResponsesItemAffinity } from './affinity.ts';
import { createStoredResponsesItemId, hashResponsesItemEncryptedContent } from './format.ts';
import { createNonResponsesSourceStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_affinity_test';

const candidate = (upstream: string, supportsResponsesItemReference = true): ProviderCandidate => {
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([stubUpstreamModel()]),
  });
  return {
    provider: {
      upstream,
      providerKind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      provider: modelProvider,
      supportsResponsesItemReference,
    },
    model: stubUpstreamModel(),
    fetcher: directFetcher,
  };
};

const insertRows = async (rows: readonly StoredResponsesItem[]) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.responsesItems.insertMany(rows);
  return repo;
};

const storedRow = (
  overrides: Omit<Partial<StoredResponsesItem>, 'payload'> & Pick<StoredResponsesItem, 'id' | 'itemType'> & { payload?: unknown | null },
): StoredResponsesItem => {
  const { payload, ...rest } = overrides;
  return {
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    origin: overrides.origin ?? (overrides.upstreamId === undefined || overrides.upstreamId === null ? 'synthetic' : 'upstream'),
    contentHash: null,
    encryptedContentHash: null,
    payload: payload === undefined || payload === null
      ? null
      : typeof payload === 'object' && Object.hasOwn(payload, 'item')
        ? payload as StoredResponsesItem['payload']
        : { item: payload },
    createdAt: 1_000,
    refreshedAt: 1_000,
    ...rest,
  };
};

const classifyItems = async (
  sourceItems: readonly ResponsesInputItem[],
  candidates: readonly ProviderCandidate[],
) => {
  const store = createNonResponsesSourceStore(API_KEY_ID);
  return await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store,
    candidates,
  });
};

const storedMessageId = (_label: string): string => createStoredResponsesItemId('message');
const storedReasoningId = (_label: string): string => createStoredResponsesItemId('reasoning');
const storedCompactionId = (_label: string): string => createStoredResponsesItemId('compaction');

test('missing stored item_reference returns item-not-found failure', async () => {
  await insertRows([]);
  const id = storedMessageId('missing');

  const result = await classifyItems([{ type: 'item_reference', id }], [candidate('up_a')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') {
    assertEquals(result.failure.kind, 'item-not-found');
    if (result.failure.kind === 'item-not-found') assertEquals(result.failure.itemId, id);
  }
});

test('invalid stored item_reference ids are not looked up as stored rows', async () => {
  const id = 'msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA';
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const result = await classifyItems([{ type: 'item_reference', id }], [candidate('up_a')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'item-not-found');
});

test('metadata-only item_reference without upstream affinity rejects instead of routing', async () => {
  const id = storedMessageId('metadata-only-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: null, upstreamItemId: null, payload: null }),
  ]);

  const result = await classifyItems([{ type: 'item_reference', id }], [candidate('up_a')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'item-not-found');
});

test('metadata-only item_reference with upstream affinity but no upstream item id rejects as not found', async () => {
  const id = storedMessageId('metadata-only-origin-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: null, payload: null }),
  ]);

  const result = await classifyItems([{ type: 'item_reference', id }], [candidate('up_a')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'item-not-found');
});

test('empty references pass through all candidates unchanged', async () => {
  await insertRows([]);

  const result = await classifyItems([], [candidate('up_a'), candidate('up_b')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('non-affinity items (no id, no encrypted_content) pass through candidates unchanged', async () => {
  await insertRows([]);
  const items: ResponsesInputItem[] = [{ type: 'message', role: 'user', content: 'hello' }];

  const result = await classifyItems(items, [candidate('up_a'), candidate('up_b')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('duplicate stored ids dedupe preferred upstreams by last occurrence', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const result = await classifyItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-old' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-new' }] },
  ], [candidate('up_b'), candidate('up_a')]);

  // up_a appears last so it should be sorted first; up_b second
  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('mixed portable upstreams are ordered by reverse last occurrence before remaining candidates', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const result = await classifyItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
  ], [candidate('up_c'), candidate('up_a'), candidate('up_b')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_b', 'up_a', 'up_c']);
});

test('conflicting compaction forcing upstreams reject the request', async () => {
  const first = storedCompactionId('first');
  const second = storedCompactionId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
    storedRow({ id: second, itemType: 'compaction', upstreamId: 'up_b', upstreamItemId: 'raw_cmp_b' }),
  ]);

  const result = await classifyItems([
    { type: 'compaction', id: first },
    { type: 'compaction', id: second },
  ] as ResponsesInputItem[], [candidate('up_a'), candidate('up_b')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'routing-unavailable');
});

test('row item type must match source item type', async () => {
  const reasoningId = storedReasoningId('wrong-type');
  await insertRows([
    storedRow({ id: reasoningId, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const result = await classifyItems([
    { type: 'message', id: reasoningId, role: 'assistant', content: 'visible message' },
  ] as ResponsesInputItem[], [candidate('up_a')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'routing-unavailable');
});

test('metadata-only item_reference rejects when the origin upstream does not support item_reference', async () => {
  const id = storedMessageId('metadata-only-reference-unsupported');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a', payload: null }),
  ]);

  const result = await classifyItems([{ type: 'item_reference', id }], [candidate('up_a', false)]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') {
    assertEquals(result.failure.kind, 'item-not-found');
    if (result.failure.kind === 'item-not-found') assertEquals(result.failure.itemId, id);
  }
});

test('forcing upstream with no matching candidate rejects as routing-unavailable', async () => {
  const id = storedCompactionId('forcing-no-candidate');
  await insertRows([
    storedRow({ id, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
  ]);

  const result = await classifyItems([
    { type: 'compaction', id } as ResponsesInputItem,
  ], [candidate('up_b')]);

  assertEquals(result.kind, 'failure');
  if (result.kind === 'failure') assertEquals(result.failure.kind, 'routing-unavailable');
});

test('id-less reasoning is matched by encrypted_content hash and prefers its owning upstream', async () => {
  const enc = 'enc-reasoning-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('owned'), itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a', encryptedContentHash: hash, payload: null }),
  ]);

  const items = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const result = await classifyItems(items, [candidate('up_b'), candidate('up_a')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('id-less encrypted_content duplicate hash keeps the freshest stored row for affinity', async () => {
  const enc = 'duplicate-enc';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('old'), itemType: 'reasoning', upstreamId: 'up_old', upstreamItemId: 'raw_old', encryptedContentHash: hash, payload: null, createdAt: 1_000, refreshedAt: 1_000 }),
    storedRow({ id: storedReasoningId('new'), itemType: 'reasoning', upstreamId: 'up_new', upstreamItemId: 'raw_new', encryptedContentHash: hash, payload: null, createdAt: 2_000, refreshedAt: 2_000 }),
  ]);

  const items = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const result = await classifyItems(items, [candidate('up_old'), candidate('up_new')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_new', 'up_old']);
});

test('id-less compaction is matched by encrypted_content hash and forces its owning upstream', async () => {
  const enc = 'enc-compaction-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedCompactionId('owned'), itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a', encryptedContentHash: hash, payload: null }),
  ]);

  const items = [{ type: 'compaction', encrypted_content: enc }] as unknown as ResponsesInputItem[];

  const resultWithOwner = await classifyItems(items, [candidate('up_b'), candidate('up_a')]);
  assertEquals(resultWithOwner.kind, 'success');
  if (resultWithOwner.kind === 'success') assertEquals(resultWithOwner.candidates.map(c => c.provider.upstream), ['up_a']);

  const resultWithoutOwner = await classifyItems(items, [candidate('up_b')]);
  assertEquals(resultWithoutOwner.kind, 'failure');
  if (resultWithoutOwner.kind === 'failure') assertEquals(resultWithoutOwner.failure.kind, 'routing-unavailable');
});

test('id-less encrypted_content with no stored match is a benign passthrough with all candidates', async () => {
  await insertRows([]);
  const items = [{ type: 'reasoning', summary: [], encrypted_content: 'never-stored' }] as unknown as ResponsesInputItem[];

  const result = await classifyItems(items, [candidate('up_a'), candidate('up_b')]);

  assertEquals(result.kind, 'success');
  if (result.kind === 'success') assertEquals(result.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
});
