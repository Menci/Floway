import { describe, expect, test } from 'vitest';

import { createResponsesItemId } from './format.ts';
import { hydrateResponsesPayload, rewriteResponsesItemsForCandidate } from './rewrite.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import { stubModelCandidate } from '@floway-dev/test-utils';

describe('Responses stored-item hydration', () => {
  test('replaces a public item reference with its complete client-wire payload and private state', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const id = createResponsesItemId('reasoning');
    const row: StoredResponsesItem = {
      id,
      apiKeyId: 'key-a',
      upstreamId: 'upstream-a',
      upstreamItemId: 'rs_upstream',
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

    const base = stubModelCandidate();
    const sameUpstream = stubModelCandidate({ provider: { ...base.provider, upstream: 'upstream-a' } });
    const otherUpstream = stubModelCandidate({ provider: { ...base.provider, upstream: 'upstream-b' } });
    const restored = rewriteResponsesItemsForCandidate(
      rewritten.payload,
      rewritten.privatePayloads,
      store,
      sameUpstream,
    );
    expect(restored.payload.input).toEqual([{
      type: 'reasoning',
      id: 'rs_upstream',
      summary: [],
      encrypted_content: 'wrapped',
    }]);
    expect(restored.privatePayloads.get('rs_upstream')).toEqual({ replay: true });

    const preserved = rewriteResponsesItemsForCandidate(
      rewritten.payload,
      rewritten.privatePayloads,
      store,
      otherUpstream,
    );
    expect(preserved.payload.input).toEqual([row.payload.item]);
    expect(preserved.privatePayloads.get(id)).toEqual({ replay: true });
  });

  test('rejects a missing gateway item reference', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore('key-a', true);
    expect(() => hydrateResponsesPayload({
      model: 'model',
      input: [{ type: 'item_reference', id: 'msg_z1mVjw_0xVvS8c_KjD1sBkZk5qbdA' }],
    }, store)).toThrow();
  });

  test('accepts compaction after a client canonicalizes the compaction_summary alias', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const id = createResponsesItemId('compaction');
    const row: StoredResponsesItem = {
      id,
      apiKeyId: 'key-a',
      upstreamId: null,
      upstreamItemId: null,
      itemType: 'compaction_summary',
      payload: { item: { type: 'compaction_summary', id, encrypted_content: 'wrapped' } },
      contentHash: 'hash',
      createdAt: 1_000,
    };
    await repo.responsesItems.insertMany([row]);
    const store = createResponsesHttpStore('key-a', true);
    const input = [{ type: 'compaction', id, encrypted_content: 'wrapped' }] as unknown as Parameters<typeof hydrateResponsesPayload>[0]['input'];
    await store.loadInputItems(input, input);

    expect(hydrateResponsesPayload({ model: 'model', input }, store).payload.input).toEqual([row.payload.item]);
  });
});
