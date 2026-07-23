import { describe, expect, test } from 'vitest';

import { hydrateResponsesPayload } from './hydrate.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';

describe('Responses stored-item hydration', () => {
  test('replaces an arbitrary item reference with its exact producer payload and private state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const id = 'rs_producer';
    const row: StoredResponsesItem = {
      id,
      apiKeyId: 'key-a',
      payload: {
        item: { type: 'reasoning', id, summary: [], encrypted_content: 'wrapped' },
        private: { replay: true },
      },
      contentHash: 'hash',
      createdAt: 1_000,
    };
    await repo.responsesItems.insertMany([row]);
    const store = createResponsesHttpStore('key-a', true);
    const payload = { model: 'model', input: [{ type: 'item_reference' as const, id: row.id }] };
    await store.loadInputItems(payload.input, payload.input);

    const hydrated = hydrateResponsesPayload(payload, store);

    expect(hydrated.payload.input).toEqual([row.payload.item]);
    expect(hydrated.privatePayloads.get(row.id)).toEqual({ replay: true });
  });

  test('rejects any missing item reference without an id-format prefilter', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore('key-a', true);
    expect(() => hydrateResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'arbitrary-missing-id' }],
    }, store)).toThrow();
  });

});
