import { expect, test, vi } from 'vitest';

import { isResponsesItemId } from './format.ts';
import { wrapResponsesClientOutput } from './output.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const frames = async function* (response: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  const item = response.output[0];
  yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
  yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
  yield eventFrame({ type: 'response.completed', response });
  yield doneFrame();
};

const completedReasoningItem: ResponsesOutputReasoning = Object.freeze({
  type: 'reasoning',
  id: 'rs_upstream',
  summary: [],
});

const memoryOutputHarness = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return { repo, store: createResponsesHttpStore('key-a', true) };
};

test('client output rewrites ids and persists the exact complete item before terminal', async () => {
  const { repo, store } = memoryOutputHarness();
  const result: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [{ type: 'reasoning', id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' }],
    error: null,
    incomplete_details: null,
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(frames(result), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const terminal = events.at(-1);
  expect(terminal?.type).toBe('response.completed');
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  const publicItem = terminal.response.output[0];
  expect(publicItem.id).not.toBe('rs_upstream');
  const rows = await repo.responsesItems.lookupMany('key-a', [publicItem.id!]);
  expect(rows[0].payload.item).toEqual(publicItem);
  expect(rows[0].payload.item).toMatchObject({ encrypted_content: 'wrapped-affinity' });
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).not.toBeNull();
});

test('client output waits for persistence before publishing output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const insert = repo.responsesItems.insertMany.bind(repo.responsesItems);
  let resolveInsertStarted!: () => void;
  const insertStarted = new Promise<void>(resolve => { resolveInsertStarted = resolve; });
  let releaseInsert!: () => void;
  const insertReleased = new Promise<void>(resolve => { releaseInsert = resolve; });
  vi.spyOn(repo.responsesItems, 'insertMany').mockImplementation(async items => {
    resolveInsertStarted();
    await insertReleased;
    await insert(items);
  });
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
    await new Promise(() => {});
  };
  const iterator = wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  const pendingDone = iterator.next();
  await insertStarted;
  expect(await Promise.race([pendingDone.then(() => true), Promise.resolve(false)])).toBe(false);

  releaseInsert();
  const done = await pendingDone;
  if (done.value?.type !== 'event' || done.value.event.type !== 'response.output_item.done') {
    throw new Error('Expected completed output item');
  }
  const clientId = done.value.event.item.id!;
  expect(await repo.responsesItems.lookupMany('key-a', [clientId])).toHaveLength(1);
  await iterator.return?.(doneFrame());
});

test('client output does not publish output_item.done when persistence fails', async () => {
  const { repo, store } = memoryOutputHarness();
  const persistenceError = new Error('simulated item persistence failure');
  vi.spyOn(repo.responsesItems, 'insertMany').mockRejectedValue(persistenceError);
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
  };
  const iterator = wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toBe(persistenceError);
});

test('store=false passes the upstream item id through and mints no gateway id', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', false);
  const result: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [{ type: 'reasoning', id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' }],
    error: null,
    incomplete_details: null,
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(frames(result), { store, responseId: 'resp_public' })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const terminal = events.at(-1);
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  // The envelope id stays gateway-owned, but the item id is the upstream's own
  // so the origin upstream recognizes it if the client echoes it next turn.
  expect(terminal.response.id).toBe('resp_public');
  expect(terminal.response.output[0].id).toBe('rs_upstream');
  const added = events.find(event => event.type === 'response.output_item.added');
  expect(added?.type === 'response.output_item.added' && added.item.id).toBe('rs_upstream');
  expect(await repo.responsesItems.lookupMany('key-a', ['rs_upstream'])).toEqual([]);
});

test('client output uses one item id across lifecycle snapshots without committing a failed snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = { type: 'reasoning' as const, id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'failed',
    output: [item],
    error: { code: 'failed', message: 'failed' },
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', error: null } });
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'response.failed', response });
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const ids = events.flatMap(event => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') return [event.item.id];
    if ('response' in event) return event.response.output.map(output => output.id);
    return [];
  });
  expect(new Set(ids).size).toBe(1);
  expect(await repo.responsesItems.lookupMany('key-a', ids.filter((id): id is string => typeof id === 'string'))).toHaveLength(1);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output persists a completed item before forwarding an error event', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'error', message: 'upstream failed' });
  };
  let clientId: string | undefined;

  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = frame.event.item.id;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.responsesItems.lookupMany('key-a', [clientId!])).toHaveLength(1);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output does not persist a partial item without output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'error', message: 'upstream failed' });
  };
  let clientId: string | undefined;

  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.added') clientId = frame.event.item.id;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.responsesItems.lookupMany('key-a', [clientId!])).toEqual([]);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output persists completed items before rethrowing an iterator error', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const upstreamError = new Error('stream transport failed');
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    throw upstreamError;
  };
  let clientId: string | undefined;
  const collect = async () => {
    for await (const frame of wrapResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = frame.event.item.id;
    }
  };

  await expect(collect()).rejects.toBe(upstreamError);
  expect(clientId).toEqual(expect.any(String));
  expect(await repo.responsesItems.lookupMany('key-a', [clientId!])).toHaveLength(1);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output persists completed items when the source ends without a terminal event', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield doneFrame();
  };
  let clientId: string | undefined;

  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = frame.event.item.id;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.responsesItems.lookupMany('key-a', [clientId!])).toHaveLength(1);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output persists a completed item when its consumer cancels', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    await new Promise(() => {});
  };
  const iterator = wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  if (first.value?.type !== 'event' || first.value.event.type !== 'response.output_item.done') {
    throw new Error('Expected completed output item');
  }
  const clientId = first.value.event.item.id!;
  await iterator.return?.(doneFrame());

  expect(await repo.responsesItems.lookupMany('key-a', [clientId])).toHaveLength(1);
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output makes every finalized item durable before publishing its done frame', async () => {
  const { repo, store } = memoryOutputHarness();
  const items = Array.from({ length: 3 }, (_, index) => ({
    type: 'reasoning' as const,
    id: `rs_upstream_${index}`,
    summary: [{ type: 'summary_text' as const, text: `summary ${index}` }],
  }));
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: items,
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    for (const [outputIndex, item] of items.entries()) {
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item });
    }
    yield eventFrame({ type: 'response.completed', response });
  };
  const iterator = wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  for (const item of items) {
    const next = await iterator.next();
    expect(next.value?.type === 'event' && next.value.event.type).toBe('response.output_item.done');
    if (next.value?.type !== 'event' || next.value.event.type !== 'response.output_item.done') {
      throw new Error('Expected finalized output item');
    }
    expect(next.value.event.item.id).not.toBe(item.id);
    expect(await repo.responsesItems.lookupMany('key-a', [next.value.event.item.id!])).toHaveLength(1);
  }
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();

  const terminal = await iterator.next();
  expect(terminal.value?.type === 'event' && terminal.value.event.type).toBe('response.completed');
  expect((await repo.responsesSnapshots.lookup('key-a', 'resp_public'))?.itemIds).toHaveLength(items.length);
});

test('client output mints and persists one lifecycle id for an id-less item', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer' }],
  };
  const result: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(frames(result), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  const itemIds = events.flatMap(event => {
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') return [event.item.id];
    if (event.type === 'response.completed') return event.response.output.map(output => output.id);
    return [];
  });
  expect(new Set(itemIds).size).toBe(1);
  const [clientId] = itemIds;
  expect(typeof clientId === 'string' && isResponsesItemId(clientId)).toBe(true);
  expect(await repo.responsesItems.lookupMany('key-a', [clientId!])).toHaveLength(1);
  expect((await repo.responsesSnapshots.lookup('key-a', 'resp_public'))?.itemIds).toContain(clientId);
});

test('client output binds a later delta item_id to an id-less lifecycle', async () => {
  const { store } = memoryOutputHarness();
  const item = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer' }],
  };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'response.output_text.delta', item_id: 'msg_late_upstream', output_index: 0, content_index: 0, delta: 'answer' });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'response.completed', response });
  };

  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  const added = events.find(event => event.type === 'response.output_item.added');
  const delta = events.find(event => event.type === 'response.output_text.delta');
  expect(added?.type).toBe('response.output_item.added');
  expect(delta?.type).toBe('response.output_text.delta');
  if (added?.type !== 'response.output_item.added' || delta?.type !== 'response.output_text.delta') {
    throw new Error('Expected added and delta events');
  }
  expect(isResponsesItemId(added.item.id!)).toBe(true);
  expect(delta.item_id).toBe(added.item.id);
});

test('client output forwards terminal item drift while retaining the first done snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const doneItem = { type: 'reasoning' as const, id: 'rs_upstream', summary: [{ type: 'summary_text' as const, text: 'old' }] };
  const terminalItem = { ...doneItem, summary: [{ type: 'summary_text' as const, text: 'new' }] };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [terminalItem],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: doneItem });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: doneItem });
    yield eventFrame({ type: 'response.completed', response });
  };
  let terminal: ResponsesResult | undefined;
  const collect = async () => {
    for await (const frame of wrapResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.completed') terminal = frame.event.response;
    }
  };

  await collect();
  expect(terminal?.output[0]).toMatchObject({
    summary: [{ type: 'summary_text', text: 'new' }],
  });
  const snapshot = await repo.responsesSnapshots.lookup('key-a', 'resp_public');
  expect(snapshot).not.toBeNull();
  if (snapshot === null) throw new Error('Expected persisted snapshot');
  expect((await repo.responsesItems.lookupMany('key-a', snapshot.itemIds))[0].payload.item).toMatchObject({
    summary: [{ type: 'summary_text', text: 'old' }],
  });
});

test('client output forwards repeated done drift while retaining the first done snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const first = { type: 'reasoning' as const, id: 'rs_upstream', summary: [{ type: 'summary_text' as const, text: 'old' }] };
  const changed = { ...first, summary: [{ type: 'summary_text' as const, text: 'new' }] };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: changed });
  };
  const publicItems: Array<typeof first> = [];
  const collect = async () => {
    for await (const frame of wrapResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
        publicItems.push(frame.event.item as typeof first);
      }
    }
  };

  await collect();
  expect(publicItems).toHaveLength(2);
  expect(publicItems[0].id).toBe(publicItems[1].id);
  expect(publicItems[1]).toMatchObject({ summary: [{ type: 'summary_text', text: 'new' }] });
  expect((await repo.responsesItems.lookupMany('key-a', [publicItems[0].id]))[0].payload.item).toMatchObject({
    summary: [{ type: 'summary_text', text: 'old' }],
  });
});

test('snapshot output IDs follow output_index rather than done arrival order', async () => {
  const { repo, store } = memoryOutputHarness();
  const first = { type: 'reasoning' as const, id: 'rs_first', summary: [] };
  const second = { type: 'reasoning' as const, id: 'rs_second', summary: [] };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [first, second],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: second });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.completed', response });
  };
  let terminal: ResponsesResult | undefined;
  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') terminal = frame.event.response;
  if (terminal === undefined) throw new Error('Expected terminal response');

  expect((await repo.responsesSnapshots.lookup('key-a', 'resp_public'))?.itemIds).toEqual(
    terminal.output.map(item => item.id),
  );
});

test('finalized item validation accepts the compaction_summary alias', async () => {
  const { store } = memoryOutputHarness();
  const summary = { type: 'compaction_summary', id: 'cmp_upstream', encrypted_content: 'opaque' } as unknown as ResponsesResult['output'][number];
  const canonical = { ...summary, type: 'compaction' } as unknown as ResponsesResult['output'][number];
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [canonical],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: summary });
    yield eventFrame({ type: 'response.completed', response });
  };
  const events: ResponsesStreamEvent[] = [];
  for await (const frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  expect(events.at(-1)?.type).toBe('response.completed');
});
