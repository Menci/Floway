import { describe, expect, test } from 'vitest';

import { rewriteResponsesPayload } from './rewrite.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

describe('Responses stored-item hydration', () => {
  test('replaces a public item reference with its complete client-wire payload and private state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const row: StoredResponsesItem = {
      id: 'rs_public',
      apiKeyId: 'key-a',
      itemType: 'reasoning',
      payload: {
        item: { type: 'reasoning', id: 'rs_public', summary: [], encrypted_content: 'wrapped' },
        private: { replay: true },
      },
      contentHash: 'hash',
      createdAt: 1_000,
    };
    await repo.responsesItems.insertMany([row]);
    const store = createResponsesHttpStore('key-a', true);
    const payload = { model: 'model', input: [{ type: 'item_reference' as const, id: row.id }] };
    await store.loadInputItems({ sourceItems: payload.input, view: responsesItemsView });

    const rewritten = rewriteResponsesPayload(payload, store);

    expect(rewritten.payload.input).toEqual([row.payload.item]);
    expect(rewritten.privatePayloads.get(row.id)).toEqual({ replay: true });
  });

  test('rejects a missing gateway item reference', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore('key-a', true);
    expect(() => rewriteResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA' }],
    }, store)).toThrow();
  });
});
