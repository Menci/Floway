import { test } from 'vitest';

import { classifyResponsesItemAffinity } from './affinity.ts';
import { createStoredResponsesItemId, hashResponsesItemEncryptedContent, isStoredResponsesItemId } from './format.ts';
import { rewriteResponsesItemsForCandidate } from './rewrite.ts';
import { createNonResponsesSourceStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubInternalModel, stubProviderModel, assert, assertEquals, assertFalse } from '@floway-dev/test-utils';
import { responsesItemsView, type CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_rewrite_test';

const candidate = (upstream: string, supportsResponsesItemReference = true): ModelCandidate => {
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([stubProviderModel()]),
  });
  return {
    provider: {
      upstream,
      kind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: modelProvider,
      supportsResponsesItemReference,
    },
    model: stubInternalModel({}, upstream),
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

const storedMessageId = (_label: string): string => createStoredResponsesItemId('message');
const storedReasoningId = (_label: string): string => createStoredResponsesItemId('reasoning');
const storedCompactionId = (_label: string): string => createStoredResponsesItemId('compaction');

const makePayload = (input: ResponsesInputItem[]): CanonicalResponsesPayload => ({
  model: 'test-model',
  input,
});

const rewrite = async (
  input: ResponsesInputItem[],
  cand: ModelCandidate,
): Promise<ResponsesInputItem[]> => {
  const store = createNonResponsesSourceStore(API_KEY_ID);
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  // Simulate the affinity classification that populates the store cache.
  await classifyResponsesItemAffinity({ sourceItems: input, view: responsesItemsView, store, candidates: [cand] });
  const result = await rewriteResponsesItemsForCandidate(makePayload(input), store, cand);
  return result.payload.input as ResponsesInputItem[];
};

// Case 1: no matching row → item is kept as-is
test('item with no stored row is kept as-is', async () => {
  await insertRows([]);
  const item: ResponsesInputItem = { type: 'message', role: 'user', content: 'hello' };
  const rewritten = await rewrite([item], candidate('up_a'));
  assertEquals(rewritten, [item]);
});

// Case 2: item_reference + row.payload === null + provider doesn't support item_reference → throw item-not-found
test('item_reference with null payload throws item-not-found when provider does not support item_reference', async () => {
  const id = storedMessageId('no-payload-ref');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a', payload: null }),
  ]);

  let threw = false;
  try {
    await rewrite([{ type: 'item_reference', id }], candidate('up_a', false));
  } catch {
    threw = true;
  }
  assert(threw, 'should have thrown item-not-found');
});

// Case 3: synthetic row (no upstream) → inline-expand from stored payload
test('synthetic row without upstream owner is inline-expanded to any provider', async () => {
  const id = storedReasoningId('synthetic');
  await insertRows([
    storedRow({
      id,
      itemType: 'reasoning',
      upstreamId: null,
      upstreamItemId: null,
      payload: { type: 'reasoning', id: 'rs_synthetic_origin', summary: [{ type: 'summary_text', text: 'trace' }] },
    }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'stale' }] }];
  const rewritten = await rewrite(input, candidate('up_b'));

  assert(rewritten.length === 1, 'synthetic reasoning must survive routing to a non-owning provider');
  assert(rewritten[0].type === 'reasoning');
  assertEquals((rewritten[0] as { summary?: { text: string }[] }).summary?.[0]?.text, 'trace');
});

// Case 4: owned reasoning + wrong upstream → drop (return null, item is skipped)
test('owned reasoning is dropped when routing to a different upstream', async () => {
  const id = storedReasoningId('owned-reasoning');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }];
  const rewritten = await rewrite(input, candidate('up_b'));

  assertEquals(rewritten, []);
});

// Case 5: same upstream + has upstreamItemId → substitute upstream's original id
test('matching upstream rewrites to upstream_item_id', async () => {
  const id = storedMessageId('origin');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale' }];
  const rewritten = await rewrite(input, candidate('up_a'));

  assertEquals(rewritten, [{ type: 'message', id: 'raw_msg_a', role: 'assistant', content: 'stale' }]);
});

// Case 6: cross-upstream owned → mint tmp id
test('non-matching portable owned item gets a temporary id without leaking raw upstream ids', async () => {
  const id = storedMessageId('portable');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'portable body' }];
  const rewritten = await rewrite(input, candidate('up_b'));
  const [item] = rewritten;

  assert(item.type === 'message');
  assert(typeof item.id === 'string');
  assert(item.id.startsWith('msg_tmp_'), item.id);
  assertFalse(isStoredResponsesItemId(item.id));
  assert(item.id !== id);
  assert(item.id !== 'raw_msg_a');
});

test('stored payload replaces stale caller content before provider id rewrite', async () => {
  const id = storedMessageId('canonical');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'canonical content' }],
      },
    }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale caller content' }];
  const rewritten = await rewrite(input, candidate('up_a'));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'canonical content' }],
  }]);
});

test('matching upstream keeps item_reference shape and rewrites to upstream item id', async () => {
  const id = storedMessageId('origin-reference');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'item_reference', id }];
  const rewritten = await rewrite(input, candidate('up_a'));

  assertEquals(rewritten, [{ type: 'item_reference', id: 'raw_msg_a' }]);
});

test('matching upstream without item_reference support expands the stored item body', async () => {
  const id = storedMessageId('origin-reference-expanded');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const input: ResponsesInputItem[] = [{ type: 'item_reference', id }];
  const rewritten = await rewrite(input, candidate('up_a', false));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'stored content' }],
  }]);
});

test('id-less reasoning matched by encrypted_content routes to owner and stamps upstream id', async () => {
  const enc = 'enc-reasoning-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('owned'), itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a', encryptedContentHash: hash, payload: null }),
  ]);

  const input = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];

  // Routed to the owner: stamped with upstream's own item id.
  const rewrittenOwner = await rewrite(input, candidate('up_a'));
  assertEquals(rewrittenOwner, [{ type: 'reasoning', summary: [], encrypted_content: enc, id: 'raw_rs_a' }]);

  // Routed elsewhere: reasoning is owned, dropped when upstream doesn't match.
  const rewrittenOther = await rewrite(input, candidate('up_b'));
  assertEquals(rewrittenOther, []);
});

test('id-less encrypted_content with no stored match is a benign passthrough', async () => {
  await insertRows([]);
  const input = [{ type: 'reasoning', summary: [], encrypted_content: 'never-stored' }] as unknown as ResponsesInputItem[];
  const rewritten = await rewrite(input, candidate('up_a'));

  assertEquals(rewritten, input);
});

test('id-less encrypted_content duplicate hash uses freshest stored row for rewrite', async () => {
  const enc = 'duplicate-enc';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedReasoningId('old'), itemType: 'reasoning', upstreamId: 'up_old', upstreamItemId: 'raw_old', encryptedContentHash: hash, payload: null, createdAt: 1_000, refreshedAt: 1_000 }),
    storedRow({ id: storedReasoningId('new'), itemType: 'reasoning', upstreamId: 'up_new', upstreamItemId: 'raw_new', encryptedContentHash: hash, payload: null, createdAt: 2_000, refreshedAt: 2_000 }),
  ]);

  const input = [{ type: 'reasoning', summary: [], encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const rewritten = await rewrite(input, candidate('up_new'));
  assertEquals(rewritten, [{ type: 'reasoning', summary: [], encrypted_content: enc, id: 'raw_new' }]);
});

test('id-less compaction is matched by encrypted_content hash and stamps upstream item id', async () => {
  const enc = 'enc-compaction-blob';
  const hash = await hashResponsesItemEncryptedContent(enc);
  await insertRows([
    storedRow({ id: storedCompactionId('owned'), itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a', encryptedContentHash: hash, payload: null }),
  ]);

  const input = [{ type: 'compaction', encrypted_content: enc }] as unknown as ResponsesInputItem[];
  const rewritten = await rewrite(input, candidate('up_a'));
  assertEquals(rewritten, [{ type: 'compaction', encrypted_content: enc, id: 'raw_cmp_a' }]);
});
