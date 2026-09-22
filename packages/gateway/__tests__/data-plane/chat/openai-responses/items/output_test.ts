import { describe, expect, test, vi } from 'vitest';

import { openaiResponsesItemId } from '../../../../../src/data-plane/chat/openai-responses/items/identity.ts';
import { wrapOpenAIResponsesClientOutput, wrapOpenAIResponsesObservedOutput } from '../../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesOutputReasoning, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const frames = async function* (response: OpenAIResponsesResult): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const item = response.output[0];
  yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
  yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
  yield eventFrame({ type: 'response.completed', response });
  yield doneFrame();
};

const completedReasoningItem: OpenAIResponsesOutputReasoning = Object.freeze({
  type: 'reasoning',
  id: 'rs_upstream',
  summary: [],
});

const memoryOutputHarness = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return { repo, store: createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true) };
};

const responseFor = (output: OpenAIResponsesResult['output']): OpenAIResponsesResult => ({
  id: 'resp_upstream',
  object: 'response',
  model: 'model',
  status: 'completed',
  output,
  error: null,
  incomplete_details: null,
});

describe('terminal output authority', () => {
  const reasoningItem = { type: 'reasoning' as const, id: 'rs_1', summary: [] };
  const messageItem = {
    type: 'message' as const,
    id: 'msg_1',
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'hi', annotations: [] }],
  };

  const terminalOutputOf = async (source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): Promise<string[]> => {
    const seen: OpenAIResponsesStreamEvent[] = [];
    for await (const frame of wrapOpenAIResponsesObservedOutput(source)) {
      if (frame.type === 'event') seen.push(frame.event);
    }
    const terminal = seen.at(-1);
    if (terminal?.type !== 'response.completed') throw new Error('expected a completed terminal');
    return terminal.response.output.map(item => item.type);
  };

  test('states the items the turn closed, not the output the envelope stated', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: reasoningItem });
      yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: messageItem });
      yield eventFrame({ type: 'response.completed', response: { ...responseFor([reasoningItem]), output: [messageItem] } });
    };

    expect(await terminalOutputOf(source())).toEqual(['reasoning', 'message']);
  });

  test('orders the stated items by output_index, not by the order they closed', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: messageItem });
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: reasoningItem });
      yield eventFrame({ type: 'response.completed', response: responseFor([]) });
    };

    expect(await terminalOutputOf(source())).toEqual(['reasoning', 'message']);
  });

  test('leaves a terminal reached without a closed item exactly as it arrived', async () => {
    const source = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.completed', response: responseFor([messageItem]) });
    };

    expect(await terminalOutputOf(source())).toEqual(['message']);
  });
});

test('client output rewrites only the response id inside queued envelopes', async () => {
  const { store } = memoryOutputHarness();
  const queued: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'queued',
    output: [completedReasoningItem],
    error: null,
    incomplete_details: null,
  };
  const input = (async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.queued', response: queued });
  })();
  const output: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(input, { store, responseId: 'resp_public' })) output.push(frame);

  expect(output[0]).toMatchObject({
    event: {
      type: 'response.queued',
      response: { id: 'resp_public', output: [{ type: 'reasoning' }] },
    },
  });
  const frame = output[0];
  if (frame.type !== 'event' || frame.event.type !== 'response.queued') throw new Error('expected queued event');
  expect(frame.event.response.output[0].id).toBe('rs_upstream');
});

test('client output preserves emitted ids and persists the exact complete item before terminal', async () => {
  const { repo, store } = memoryOutputHarness();
  const result: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [{ type: 'reasoning', id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' }],
    error: null,
    incomplete_details: null,
  };

  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(frames(result), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const terminal = events.at(-1);
  expect(terminal?.type).toBe('response.completed');
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  const publicItem = terminal.response.output[0];
  expect(publicItem.id).toBe('rs_upstream');
  const rows = await repo.openaiResponsesItems.lookupMany('key-a', [publicItem.id!], 0);
  expect(rows[0].payload.item).toEqual(publicItem);
  expect(rows[0].payload.item).toMatchObject({ encrypted_content: 'wrapped-affinity' });
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).not.toBeNull();
});

test('client output waits for persistence before publishing output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const insert = repo.openaiResponsesItems.insertMany.bind(repo.openaiResponsesItems);
  let resolveInsertStarted!: () => void;
  const insertStarted = new Promise<void>(resolve => { resolveInsertStarted = resolve; });
  let releaseInsert!: () => void;
  const insertReleased = new Promise<void>(resolve => { releaseInsert = resolve; });
  vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockImplementation(async (items, earliestVisibleCutoff) => {
    resolveInsertStarted();
    await insertReleased;
    await insert(items, earliestVisibleCutoff);
  });
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
    await new Promise(() => {});
  };
  const iterator = wrapOpenAIResponsesClientOutput(input(), {
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
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId], 0)).toHaveLength(1);
  await iterator.return?.(doneFrame());
});

test('client output does not publish output_item.done when persistence fails', async () => {
  const { repo, store } = memoryOutputHarness();
  const persistenceError = new Error('simulated item persistence failure');
  vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(persistenceError);
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: completedReasoningItem });
  };
  const iterator = wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toBe(persistenceError);
});

test('store=false passes the emitted item id through without persistence', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
  const result: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [{ type: 'reasoning', id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' }],
    error: null,
    incomplete_details: null,
  };

  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(frames(result), { store, responseId: 'resp_public' })) {
    if (frame.type === 'event') events.push(frame.event);
  }

  const terminal = events.at(-1);
  if (terminal?.type !== 'response.completed') throw new Error('Expected terminal response');
  // The client-facing boundary applies the response ID without changing item IDs.
  expect(terminal.response.id).toBe('resp_public');
  expect(terminal.response.output[0].id).toBe('rs_upstream');
  const added = events.find(event => event.type === 'response.output_item.added');
  expect(added?.type === 'response.output_item.added' && added.item.id).toBe('rs_upstream');
  expect(await repo.openaiResponsesItems.lookupMany('key-a', ['rs_upstream'], 0)).toEqual([]);
});

test('client output uses one item id across lifecycle snapshots without committing a failed snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = { type: 'reasoning' as const, id: 'rs_upstream', summary: [], encrypted_content: 'wrapped-affinity' };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'failed',
    output: [item],
    error: { code: 'failed', message: 'failed' },
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress', error: null } });
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'response.failed', response });
  };

  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
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
  expect(await repo.openaiResponsesItems.lookupMany('key-a', ids.filter((id): id is string => typeof id === 'string'), 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output persists a completed item before forwarding an error event', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'error', message: 'upstream failed' });
  };
  let clientId: string | undefined;

  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = openaiResponsesItemId(frame.event.item) ?? undefined;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId!], 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output does not persist a partial item without output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'error', message: 'upstream failed' });
  };
  let clientId: string | undefined;

  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.added') clientId = openaiResponsesItemId(frame.event.item) ?? undefined;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId!], 0)).toEqual([]);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output persists completed items before rethrowing an iterator error', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const upstreamError = new Error('stream transport failed');
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    throw upstreamError;
  };
  let clientId: string | undefined;
  const collect = async () => {
    for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = openaiResponsesItemId(frame.event.item) ?? undefined;
    }
  };

  await expect(collect()).rejects.toBe(upstreamError);
  expect(clientId).toEqual(expect.any(String));
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId!], 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output persists completed items when the source ends without a terminal event', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield doneFrame();
  };
  let clientId: string | undefined;

  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.output_item.done') clientId = openaiResponsesItemId(frame.event.item) ?? undefined;
  }

  expect(clientId).toEqual(expect.any(String));
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId!], 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output persists a completed item when its consumer cancels', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = completedReasoningItem;
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    await new Promise(() => {});
  };
  const iterator = wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  if (first.value?.type !== 'event' || first.value.event.type !== 'response.output_item.done') {
    throw new Error('Expected completed output item');
  }
  const clientId = first.value.event.item.id!;
  await iterator.return?.(doneFrame());

  expect(await repo.openaiResponsesItems.lookupMany('key-a', [clientId], 0)).toHaveLength(1);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('client output makes every finalized item durable before publishing its done frame', async () => {
  const { repo, store } = memoryOutputHarness();
  const items = Array.from({ length: 3 }, (_, index) => ({
    type: 'reasoning' as const,
    id: `rs_upstream_${index}`,
    summary: [{ type: 'summary_text' as const, text: `summary ${index}` }],
  }));
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: items,
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    for (const [outputIndex, item] of items.entries()) {
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item });
    }
    yield eventFrame({ type: 'response.completed', response });
  };
  const iterator = wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })[Symbol.asyncIterator]();

  for (const item of items) {
    const next = await iterator.next();
    expect(next.value?.type === 'event' && next.value.event.type).toBe('response.output_item.done');
    if (next.value?.type !== 'event' || next.value.event.type !== 'response.output_item.done') {
      throw new Error('Expected finalized output item');
    }
    expect(next.value.event.item.id).toBe(item.id);
    expect(await repo.openaiResponsesItems.lookupMany('key-a', [next.value.event.item.id!], 0)).toHaveLength(1);
  }
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();

  const terminal = await iterator.next();
  expect(terminal.value?.type === 'event' && terminal.value.event.type).toBe('response.completed');
  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toHaveLength(items.length);
});

test('client output refuses to persist an id-less upstream item', async () => {
  const { store } = memoryOutputHarness();
  const item = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer', annotations: [] }],
  };
  const result: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };

  const collect = async () => {
    for await (const _frame of wrapOpenAIResponsesClientOutput(frames(result), {
      store,
      responseId: 'resp_public',
    })) { /* drain */ }
  };

  await expect(collect()).rejects.toThrow('OpenAI Responses message output has no id');
});

test('stateful output rejects a terminal item that never emitted output_item.done', async () => {
  const { repo, store } = memoryOutputHarness();
  const item = { type: 'reasoning' as const, id: 'rs_terminal_only', summary: [] };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };
  const input = (async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  })();
  const collect = async () => {
    for await (const _frame of wrapOpenAIResponsesClientOutput(input, {
      store,
      responseId: 'resp_public',
    })) { /* drain */ }
  };

  await expect(collect()).rejects.toThrow('terminal output_index 0 arrived before output_item.done');
  expect(await repo.openaiResponsesItems.lookupMany('key-a', [item.id], 0)).toEqual([]);
  expect(await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0)).toBeNull();
});

test('store=false forwards an id-less finalized item without persistence work', async () => {
  initRepo(new InMemoryRepo());
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), false);
  const item = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer', annotations: [] }],
  };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [item],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
    yield eventFrame({ type: 'response.output_text.delta', item_id: 'msg_late_upstream', output_index: 0, content_index: 0, delta: 'answer' });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
    yield eventFrame({ type: 'response.completed', response });
  };

  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  expect(events.map(event => event.type)).toEqual([
    'response.output_item.added',
    'response.output_text.delta',
    'response.output_item.done',
    'response.completed',
  ]);
});

test('client output forwards terminal item drift while retaining the first done snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const doneItem = { type: 'reasoning' as const, id: 'rs_upstream', summary: [], encrypted_content: 'done-blob' };
  const terminalItem = { ...doneItem, encrypted_content: 'terminal-blob' };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [terminalItem],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: doneItem });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: doneItem });
    yield eventFrame({ type: 'response.completed', response });
  };
  let terminal: OpenAIResponsesResult | undefined;
  const collect = async () => {
    for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
    })) {
      if (frame.type === 'event' && frame.event.type === 'response.completed') terminal = frame.event.response;
    }
  };

  await collect();
  expect(terminal?.output[0]).toMatchObject({ encrypted_content: 'terminal-blob' });
  const snapshot = await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0);
  expect(snapshot).not.toBeNull();
  if (snapshot === null) throw new Error('Expected persisted snapshot');
  expect((await repo.openaiResponsesItems.lookupMany('key-a', snapshot.itemIds, 0))[0].payload.item)
    .toMatchObject({ encrypted_content: 'done-blob' });
});

test('client output forwards repeated done drift while retaining the first done snapshot', async () => {
  const { repo, store } = memoryOutputHarness();
  const first = { type: 'reasoning' as const, id: 'rs_upstream', summary: [{ type: 'summary_text' as const, text: 'old' }] };
  const changed = { ...first, summary: [{ type: 'summary_text' as const, text: 'new' }] };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: changed });
  };
  const publicItems: Array<typeof first> = [];
  const collect = async () => {
    for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
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
  expect((await repo.openaiResponsesItems.lookupMany('key-a', [publicItems[0].id], 0))[0].payload.item).toMatchObject({
    summary: [{ type: 'summary_text', text: 'old' }],
  });
});

test('later done and terminal views may omit id after first-done durability', async () => {
  const { repo, store } = memoryOutputHarness();
  const first = {
    type: 'message' as const,
    id: 'msg_first_done',
    status: 'completed' as const,
    role: 'assistant' as const,
    content: [{ type: 'output_text' as const, text: 'first', annotations: [] }],
  };
  const later = {
    type: 'message' as const,
    status: 'completed' as const,
    role: 'assistant' as const,
    content: [{ type: 'output_text' as const, text: 'later', annotations: [] }],
  };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [later],
    error: null,
    incomplete_details: null,
  };
  const input = (async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: later });
    yield eventFrame({ type: 'response.completed', response });
  })();
  const events: OpenAIResponsesStreamEvent[] = [];
  for await (const frame of wrapOpenAIResponsesClientOutput(input, {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  const doneItems = events.flatMap(event => event.type === 'response.output_item.done' ? [event.item] : []);
  expect(doneItems).toEqual([first, later]);
  const terminal = events.at(-1);
  expect(terminal?.type === 'response.completed' && terminal.response.output).toEqual([later]);
  expect((await repo.openaiResponsesItems.lookupMany('key-a', [first.id], 0))[0].payload.item).toEqual(first);
});

test('snapshot output IDs follow output_index rather than done arrival order', async () => {
  const { repo, store } = memoryOutputHarness();
  const first = { type: 'reasoning' as const, id: 'rs_first', summary: [] };
  const second = { type: 'reasoning' as const, id: 'rs_second', summary: [] };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [first, second],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 1, item: second });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.completed', response });
  };
  let terminal: OpenAIResponsesResult | undefined;
  for await (const frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') terminal = frame.event.response;
  if (terminal === undefined) throw new Error('Expected terminal response');

  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toEqual(
    terminal.output.map(item => item.id),
  );
});

test('snapshot retains completed streamed items omitted from the terminal output', async () => {
  const { repo, store } = memoryOutputHarness();
  const call = {
    type: 'custom_tool_call' as const,
    id: 'ctc_streamed_only',
    call_id: 'call_streamed_only',
    name: 'exec_command',
    input: 'printf floway-repro',
    status: 'completed',
  };
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'completed',
    output: [],
    error: null,
    incomplete_details: null,
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: call });
    yield eventFrame({ type: 'response.completed', response });
  };

  for await (const _frame of wrapOpenAIResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
  })) { /* drain */ }

  expect((await repo.openaiResponsesSnapshots.lookup('key-a', 'resp_public', 0))?.itemIds).toEqual([call.id]);
  expect((await repo.openaiResponsesItems.lookupMany('key-a', [call.id], 0))[0].payload.item).toEqual(call);
});
