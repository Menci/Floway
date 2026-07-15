import { describe, expect, test } from 'vitest';

import { createResponsesHttpStore, createResponsesWsSession } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';

describe('StatefulResponsesStore', () => {
  test('HTTP store=false performs no state writes', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', false);

    expect(store.storesState).toBe(false);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await store.commitSnapshot('resp_none', 'append');
    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_none')).toBeNull();
  });

  test('HTTP default stores complete input and output snapshots', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const store = createResponsesHttpStore('key-a', undefined);
    await store.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    const output = {
      id: 'msg_public',
      apiKeyId: 'key-a',
      itemType: 'message',
      payload: { item: { type: 'message', id: 'msg_public', role: 'assistant', content: [] } },
      contentHash: 'output-hash',
      createdAt: 1_000,
    };
    store.stageOutputItem(output);
    await store.commitSnapshot('resp_saved', 'append');

    const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_saved');
    expect(snapshot?.itemIds).toHaveLength(2);
    expect(await repo.responsesItems.lookupMany('key-a', [output.id])).toEqual([output]);
  });

  test('WebSocket store=false retains socket-local state only', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const session = createResponsesWsSession();
    const first = session.createStore('key-a', false);
    await first.stageInputItems([{ type: 'message', role: 'user', content: 'hello' }]);
    await first.commitSnapshot('resp_local', 'append');

    expect(await repo.responsesSnapshots.lookup('key-a', 'resp_local')).toBeNull();
    expect(await session.createStore('key-a', false).loadSnapshot('resp_local')).not.toBeNull();
  });

  test('attempt-private payload is request scoped', () => {
    initRepo(new InMemoryRepo());
    const store = createResponsesHttpStore('key-a', true);
    store.beginAttempt(new Map([['item', { first: true }]]));
    store.setPrivatePayload('second', { value: 2 });
    expect(store.getPrivatePayload('item')).toEqual({ first: true });
    expect(store.getPrivatePayload('second')).toEqual({ value: 2 });
    store.beginAttempt(new Map());
    expect(store.getPrivatePayload('item')).toBeUndefined();
  });
});
