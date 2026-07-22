import { describe, expect, test } from 'vitest';

import { hydrateResponsesPayload } from './hydrate.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { testResponsesStateLifetime, testResponsesStatePolicy, TEST_RESPONSES_STATE_EPOCH } from '../../../../test-helpers/responses-state.ts';

describe('Responses stored-item hydration', () => {
  test('replaces an arbitrary item reference with its exact producer payload and private state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const id = 'rs_producer';
    const now = Date.now();
    const row: StoredResponsesItem = {
      id,
      apiKeyId: 'key-a',
      stateEpoch: TEST_RESPONSES_STATE_EPOCH,
      payload: {
        item: { type: 'reasoning', id, summary: [], encrypted_content: 'wrapped' },
        private: { replay: true },
      },
      contentHash: 'hash',
      payloadHash: 'payload-hash',
      payloadFileKey: null,
      ...testResponsesStateLifetime(now),
    };
    await repo.responsesItems.insertMany([row], now);
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    const payload = { model: 'model', input: [{ type: 'item_reference' as const, id: row.id }] };
    await store.loadInputItems(payload.input, payload.input);

    const hydrated = hydrateResponsesPayload(payload, store);

    expect(hydrated.payload.input).toEqual([row.payload.item]);
    expect(hydrated.privatePayloads.get(row.id)).toEqual({ replay: true });
  });

  test('rejects any missing item reference without an id-format prefilter', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore(testResponsesStatePolicy('key-a'), true);
    expect(() => hydrateResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'arbitrary-missing-id' }],
    }, store)).toThrow();
  });

});
