import { describe, expect, test } from 'vitest';

import { createStoredResponsesItemId } from './format.ts';
import { hydrateResponsesPayload } from './rewrite.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';

describe('Responses stored-item hydration', () => {
  test('replaces a public item reference with its complete client-wire payload and private state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const id = createStoredResponsesItemId('reasoning');
    const row: StoredResponsesItem = {
      id,
      apiKeyId: 'key-a',
      itemType: 'reasoning',
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

    const rewritten = hydrateResponsesPayload(payload, store);

    expect(rewritten.payload.input).toEqual([row.payload.item]);
    expect(rewritten.privatePayloads.get(row.id)).toEqual({ replay: true });
  });

  test('rejects a missing gateway item reference', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore('key-a', true);
    expect(() => hydrateResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA' }],
    }, store)).toThrow();
  });
});
