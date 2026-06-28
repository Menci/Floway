import { test } from 'vitest';

import { createStoredResponsesItemId } from './items/format.ts';
import { createNonResponsesSourceStore } from './items/store.ts';
import { planResponsesRouting } from './routing.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../repo/types.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_routing_test';

const candidateFor = (upstream: string): ProviderCandidate => {
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
      supportsResponsesItemReference: true,
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
  overrides: Pick<StoredResponsesItem, 'id' | 'itemType'> & Partial<StoredResponsesItem>,
): StoredResponsesItem => ({
  apiKeyId: API_KEY_ID,
  upstreamId: null,
  upstreamItemId: null,
  origin: 'upstream',
  contentHash: null,
  encryptedContentHash: null,
  payload: null,
  createdAt: 1_000,
  refreshedAt: 1_000,
  ...overrides,
});

const payload = (input: ResponsesPayload['input']): ResponsesPayload => ({
  model: 'stub-model',
  input,
});

test('payload with no stored references passes candidates through unchanged', async () => {
  await insertRows([]);
  const candidates = [candidateFor('up_a'), candidateFor('up_b')];

  const decision = await planResponsesRouting({
    payload: payload([{ type: 'message', role: 'user', content: 'hello' }]),
    candidates,
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'success');
  if (decision.kind === 'success') {
    assertEquals(decision.candidates.length, candidates.length);
    assertEquals(decision.candidates.map(c => c.provider.upstream), ['up_a', 'up_b']);
  }
});

test('item_reference forcing an upstream absent from candidates fails routing', async () => {
  const id = createStoredResponsesItemId('compaction');
  await insertRows([
    storedRow({ id, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
  ]);

  const decision = await planResponsesRouting({
    payload: payload([{ type: 'item_reference', id }]),
    candidates: [candidateFor('up_b')],
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'failure');
  if (decision.kind === 'failure') {
    assertEquals(decision.failure.kind, 'routing-unavailable');
  }
});
