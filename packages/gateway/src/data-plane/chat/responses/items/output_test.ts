import { test, vi } from 'vitest';

import { isStoredResponsesItemId } from './format.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './output.ts';
import { createResponsesHttpStore, LayeredStatefulResponsesStore, RepoStatefulResponsesBacking, type StatefulResponsesBacking, type StatefulResponsesStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { ResponsesItemsRepo, StoredResponsesItem, StoredResponsesItemMetadata, StoredResponsesItemPayloadRecord } from '../../../../repo/types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

const apiKeyId = 'key_output_new';

const makeStore = (overrides: { store?: boolean; syntheticItemIds?: Iterable<string>; privatePayloads?: Iterable<readonly [string, unknown]> } = {}) => {
  const store = createResponsesHttpStore(apiKeyId, overrides.store);
  if (overrides.syntheticItemIds) {
    for (const id of overrides.syntheticItemIds) {
      const privatePayload = overrides.privatePayloads
        ? [...overrides.privatePayloads].find(([k]) => k === id)?.[1]
        : undefined;
      store.addSyntheticItem(id, privatePayload);
    }
  }
  return store;
};

const messageItem = (id: string, text: string): Extract<ResponsesOutputItem, { type: 'message' }> => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

const response = (output: ResponsesOutputItem[], status: ResponsesResult['status'] = 'completed'): ResponsesResult => ({
  id: 'resp_test',
  object: 'response',
  model: 'gpt-test',
  status,
  output,
  output_text: '',
  error: status === 'failed' ? { message: 'failed', code: 'server_error' } : null,
  incomplete_details: null,
});

const framesFrom = async function* (events: readonly ResponsesStreamEvent[]) {
  for (const event of events) yield eventFrame(event);
};

const TEST_RESPONSE_ID = 'resp_test123';

const wrap = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  overrides: Parameters<typeof makeStore>[0] = {},
  extra: { targetApi?: 'responses' | 'messages' | 'chat-completions'; responseId?: string } = {},
) => {
  const store = makeStore(overrides);
  return {
    events: wrapResponsesOutputForStorage(frames, {
      store,
      upstream: 'up_native',
      targetApi: extra.targetApi ?? 'responses',
      responseId: extra.responseId ?? TEST_RESPONSE_ID,
    }),
    store,
  };
};

const wrapWithStore = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  store: StatefulResponsesStore,
  extra: { targetApi?: 'responses' | 'messages' | 'chat-completions'; upstream?: string; responseId?: string } = {},
) => wrapResponsesOutputForStorage(frames, {
  store,
  upstream: extra.upstream ?? 'up_native',
  targetApi: extra.targetApi ?? 'responses',
  responseId: extra.responseId ?? TEST_RESPONSE_ID,
});

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const collected: ResponsesStreamEvent[] = [];
  for await (const item of events) {
    if (item.type === 'event') collected.push(item.event);
  }
  return collected;
};

const eventAt = <TType extends ResponsesStreamEvent['type']>(
  events: readonly ResponsesStreamEvent[],
  type: TType,
): Extract<ResponsesStreamEvent, { type: TType }> => {
  const event = events.find((candidate): candidate is Extract<ResponsesStreamEvent, { type: TType }> => candidate.type === type);
  assert(event, `expected ${type}`);
  return event;
};

type IteratorResultPromise = Promise<IteratorResult<ProtocolFrame<ResponsesStreamEvent>>>;

const promiseStateAfterMicrotasks = async (promise: IteratorResultPromise): Promise<'pending' | 'fulfilled' | 'rejected'> => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  promise.then(
    () => { state = 'fulfilled'; },
    () => { state = 'rejected'; },
  );
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
    if (state !== 'pending') return state;
  }
  return state;
};

const waitForInsertCall = async (repo: ControlledResponsesItemsRepo): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    if (repo.calls.length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for insertMany');
};

class ControlledResponsesItemsRepo implements ResponsesItemsRepo {
  calls: StoredResponsesItem[][] = [];
  resolveInsert: (() => void) | undefined;
  rejectInsert: ((error: unknown) => void) | undefined;

  lookupMany(): Promise<StoredResponsesItemMetadata[]> { return Promise.resolve([]); }
  lookupManyByEncryptedContentHash(): Promise<StoredResponsesItemMetadata[]> { return Promise.resolve([]); }
  lookupManyByContentHash(): Promise<StoredResponsesItemMetadata[]> { return Promise.resolve([]); }
  lookupPayloads(): Promise<StoredResponsesItemPayloadRecord[]> { return Promise.resolve([]); }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    this.calls.push(items.map(item => structuredClone(item)));
    return new Promise((resolve, reject) => {
      this.resolveInsert = resolve;
      this.rejectInsert = reject;
    });
  }

  fillPayloads(): Promise<number> { return Promise.resolve(0); }
  refreshMany(): Promise<number> { return Promise.resolve(0); }
  clearPayloadOlderThan(): Promise<number> { return Promise.resolve(0); }
  deleteOlderThan(): Promise<number> { return Promise.resolve(0); }
  deleteAll(): Promise<void> { return Promise.resolve(); }
}

test('rewrites output item ids consistently across added, child, done, and terminal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: original.id!, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]));

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  assert(isStoredResponsesItemId(storedId));
  assert(storedId.startsWith('msg_'));
  assertEquals(eventAt(collected, 'response.output_item.added').item.id, storedId);
  assertEquals(eventAt(collected, 'response.output_text.delta').item_id, storedId);
  assertEquals(eventAt(collected, 'response.completed').response.output[0].id, storedId);

  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  const [payload] = await repo.responsesItems.lookupPayloads(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, 'up_native');
  assertEquals(row.upstreamItemId, original.id);
  assertEquals(payload.payload, { item: original });
});

test('rewrites and persists programmatic tool output items without changing their payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const program: Extract<ResponsesOutputItem, { type: 'program' }> = {
    type: 'program',
    id: 'program_native_1',
    call_id: 'program_call_1',
    code: 'await exec("hello")',
    fingerprint: 'opaque-fingerprint',
  };
  const programOutput: Extract<ResponsesOutputItem, { type: 'program_output' }> = {
    type: 'program_output',
    id: 'program_output_native_1',
    call_id: 'program_call_1',
    result: 'hello',
    status: 'completed',
  };
  const additionalTools: Extract<ResponsesOutputItem, { type: 'additional_tools' }> = {
    type: 'additional_tools',
    id: 'additional_tools_native_1',
    role: 'developer',
    tools: [{ type: 'custom', name: 'exec', format: { type: 'text' } }],
  };

  const { events } = wrap(framesFrom([
    { type: 'response.completed', response: response([additionalTools, program, programOutput]) },
  ]));

  const completed = eventAt(await collectEvents(events), 'response.completed');
  const [storedAdditionalTools, storedProgram, storedProgramOutput] = completed.response.output;
  assert(storedAdditionalTools.id?.startsWith('at_'));
  assert(storedProgram.id?.startsWith('prog_'));
  assert(storedProgramOutput.id?.startsWith('prog_out_'));
  assertEquals(storedAdditionalTools, { ...additionalTools, id: storedAdditionalTools.id });
  assertEquals(storedProgram, { ...program, id: storedProgram.id });
  assertEquals(storedProgramOutput, { ...programOutput, id: storedProgramOutput.id });

  const payloads = await repo.responsesItems.lookupPayloads(apiKeyId, completed.response.output.map(item => item.id!));
  assertEquals(payloads.map(record => record.payload.item), [additionalTools, program, programOutput]);
});

test('persists each row before yielding the item-done frame', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const iterator = wrapWithStore(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store)[Symbol.asyncIterator]();

  const addedFrame = await iterator.next();
  assertEquals((addedFrame.value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
  assertEquals(controlled.calls.length, 0);

  // done is held until the row insert resolves; the client that has seen
  // `done` finds the row on its next turn.
  const doneFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
  await waitForInsertCall(controlled);
  assertEquals(controlled.calls.length, 1);
  controlled.resolveInsert?.();
  assertEquals(((await doneFrame).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');
});

test('insert failure rejects before yielding the item-done frame', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const iterator = wrapWithStore(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), createResponsesHttpStore(apiKeyId, undefined))[Symbol.asyncIterator]();

  assertEquals(((await iterator.next()).value as ProtocolFrame<ResponsesStreamEvent>).type, 'event');

  const doneFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
  await waitForInsertCall(controlled);
  controlled.rejectInsert?.(new Error('insert failed'));
  await assertRejects(() => doneFrame, Error, 'insert failed');
});

test('does not insert rows for failed streams without observed items', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);

  const { events } = wrap(framesFrom([
    { type: 'response.failed', response: response([], 'failed') },
  ]));

  const collected = await collectEvents(events);
  assertEquals(collected.at(-1)?.type, 'response.failed');
  assertEquals(controlled.calls.length, 0);
});

test('store false creates metadata rows with null payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), { store: false });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.hasPayload, false);
  assertEquals(row.upstreamItemId, original.id);
});

test('terminal output items missing done frames are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_only', 'late');

  const { events } = wrap(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]));

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [payload] = await repo.responsesItems.lookupPayloads(apiKeyId, [storedId]);
  assertEquals(payload.payload, { item: original });
});

test('two distinct upstream items receive distinct stored ids', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const first = messageItem('raw_msg_1', 'first');
  const second = messageItem('raw_msg_2', 'second');

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.completed', response: response([first, second]) },
  ]));

  const collected = await collectEvents(events);
  const done = collected.filter((event): event is Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }> => event.type === 'response.output_item.done');
  assert(done[0].item.id !== done[1].item.id);
  assert(isStoredResponsesItemId(done[0].item.id!));
  assert(isStoredResponsesItemId(done[1].item.id!));
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [done[0].item.id!, done[1].item.id!]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].upstreamItemId, 'raw_msg_1');
  assertEquals(rows[1].upstreamItemId, 'raw_msg_2');
});

test('via-translation synthesized items do not claim upstream ownership', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('msg_0', 'translated');

  const store = createResponsesHttpStore(apiKeyId, undefined);
  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store, { targetApi: 'messages' });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
});

test('gateway-synthesized items do not claim upstream ownership on a native stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const synthetic: Extract<ResponsesOutputItem, { type: 'web_search_call' }> = {
    type: 'web_search_call',
    id: 'ws_gw_synthetic00000000000',
    status: 'completed',
    action: { type: 'search', query: 'q', queries: ['q'] },
    results: [],
  };

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: synthetic },
    { type: 'response.completed', response: response([synthetic]) },
  ]), { syntheticItemIds: [synthetic.id] });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
  assertEquals(row.itemType, 'web_search_call');
});

test('private payload registered on the request is attached to the persisted row', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const synthetic: Extract<ResponsesOutputItem, { type: 'web_search_call' }> = {
    type: 'web_search_call',
    id: 'ws_gw_priv00000000000000000',
    status: 'completed',
    action: { type: 'search', query: 'q', queries: ['q'] },
    results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'public-wire' }],
  };
  const privateBlob = { v: 1, functionCallItem: { type: 'function_call', call_id: 'call_orig_xyz', name: 'web_search', arguments: '{"search_query":[{"q":"q"}]}', status: 'completed' }, ir: { action: synthetic.action, results: [{ type: 'text_result', url: 'u', title: 't', snippet: 'server-only body' }] } };

  const { events } = wrap(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: synthetic },
    { type: 'response.completed', response: response([synthetic]) },
  ]), { syntheticItemIds: [synthetic.id], privatePayloads: [[synthetic.id, privateBlob]] });

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.output_item.done').item.id!;
  const [payload] = await repo.responsesItems.lookupPayloads(apiKeyId, [storedId]);
  assertEquals(payload.payload.private, privateBlob);
});

// --- snapshot-mode derivation tests ---
//
// Wrap derives the snapshot mode by observing the output stream: a
// `compaction` or its `compaction_summary` wire alias surfaces `'replace'`,
// any other shape surfaces `'append'`. The mode is asserted directly on
// `store.commitSnapshot` rather than via repo state because the store
// configuration ('append' vs 'replace') flows into the snapshot's itemIds
// shape — itemIds is a downstream consequence we don't need to re-test here.

const spyCommitSnapshot = (store: ReturnType<typeof createResponsesHttpStore>) =>
  vi.spyOn(store, 'commitSnapshot').mockResolvedValue();

test('derives snapshotMode=append when no compaction item appears in output', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_append', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const commitSpy = spyCommitSnapshot(store);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_upstream_ignored' } },
  ]), store, { responseId: 'resp_append' });

  await collectEvents(events);
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][0], 'resp_append');
  assertEquals(commitSpy.mock.calls[0][1], 'append');
});

test('derives snapshotMode=replace from a streamed compaction output item', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  // `compaction` is an input-shaped item type the protocol's `ResponsesOutputItem`
  // union does not declare; cast through the assertion so the event payload
  // mirrors what a real upstream emits on the wire.
  const compactionItem = {
    type: 'compaction',
    id: 'cmp_streamed',
    encrypted_content: 'ENC',
  } as unknown as ResponsesOutputItem;
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const commitSpy = spyCommitSnapshot(store);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: compactionItem },
    { type: 'response.completed', response: { ...response([compactionItem]), object: 'response.compaction' } },
  ]), store, { responseId: 'resp_replace_streamed' });

  await collectEvents(events);
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'replace');
});

test('derives snapshotMode=replace from a streamed compaction_summary alias item', async () => {
  // Codex's protocol pins `compaction_summary` as a serde alias for
  // `compaction` (https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs);
  // wrap treats either literal as a compaction-shape envelope.
  const repo = new InMemoryRepo();
  initRepo(repo);
  const summaryItem = {
    type: 'compaction_summary',
    id: 'cmp_summary',
    encrypted_content: 'ENC',
  } as unknown as ResponsesOutputItem;
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const commitSpy = spyCommitSnapshot(store);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: summaryItem },
    { type: 'response.completed', response: { ...response([summaryItem]), object: 'response.compaction' } },
  ]), store, { responseId: 'resp_replace_summary' });

  await collectEvents(events);
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'replace');
});

test('derives snapshotMode=replace when the compaction item only appears in the terminal envelope', async () => {
  // The non-streaming compact path runs through `syntheticEventsFromResult`,
  // which emits the compaction item via generic `output_item.added`/`done`
  // pairs. A fully non-streaming upstream that surfaces the item only in
  // `response.completed.output[]` — without any preceding `output_item.done`
  // — must still trigger `'replace'`. This covers that terminal-envelope-only
  // case.
  const repo = new InMemoryRepo();
  initRepo(repo);
  const compactionItem = {
    type: 'compaction',
    id: 'cmp_terminal_only',
    encrypted_content: 'ENC',
  } as unknown as ResponsesOutputItem;
  const store = createResponsesHttpStore(apiKeyId, undefined);
  const commitSpy = spyCommitSnapshot(store);

  const events = wrapWithStore(framesFrom([
    { type: 'response.completed', response: { ...response([compactionItem]), object: 'response.compaction' } },
  ]), store, { responseId: 'resp_replace_terminal' });

  await collectEvents(events);
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'replace');
});

test('snapshot is committed under the gateway-minted id', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_upstream_ignored' } },
  ]), store, { responseId: 'resp_snap_id' });

  await collectEvents(events);
  const snapshot = await repo.responsesSnapshots.lookup(apiKeyId, 'resp_snap_id');
  assert(snapshot !== null, 'expected snapshot to be written under Floway-minted id');
  assertEquals(snapshot.id, 'resp_snap_id');
});

test('no snapshot is written when the store has no snapshotWrites configured', async () => {
  // Cross-protocol stores (`createNonResponsesSourceStore`) ship with an
  // empty `snapshotWrites` configuration; commitSnapshot is then a no-op
  // at the store-write layer, so the wrap layer's unconditional call has
  // no externally observable effect.
  const repo = new InMemoryRepo();
  initRepo(repo);
  const repoBacking = new RepoStatefulResponsesBacking(() => repo);
  const noSnapshotStore = new LayeredStatefulResponsesStore({
    apiKeyId,
    reads: [repoBacking],
    itemWrites: [{ backing: repoBacking, durable: true }],
    snapshotWrites: [],
    stageInputs: false,
  });
  const original = messageItem('raw_msg_no_snap', 'hi');

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_upstream_ignored' } },
  ]), noSnapshotStore, { responseId: 'resp_no_snap' });

  await collectEvents(events);
  const snapshot = await repo.responsesSnapshots.lookup(apiKeyId, 'resp_no_snap');
  assertEquals(snapshot, null);
});

test('snapshot commit failure rejects before yielding the terminal frame', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_snap_err', 'hi');
  const repoBacking = new RepoStatefulResponsesBacking(() => repo);
  const faultyBacking: StatefulResponsesBacking = {
    lookupItems: args => repoBacking.lookupItems(args),
    lookupPayloads: (aid, ids) => repoBacking.lookupPayloads(aid, ids),
    insertItems: items => repoBacking.insertItems(items),
    fillPayloads: items => repoBacking.fillPayloads(items),
    refreshItems: (aid, ids, at) => repoBacking.refreshItems(aid, ids, at),
    lookupSnapshot: async () => null,
    insertSnapshot: async () => { throw new Error('snapshot write failed'); },
    refreshSnapshot: async () => {},
  };

  const faultyStore = new LayeredStatefulResponsesStore({
    apiKeyId,
    reads: [repoBacking],
    itemWrites: [{ backing: repoBacking, durable: true }],
    snapshotWrites: [{ backing: faultyBacking, durable: false }],
    stageInputs: true,
  });

  const events = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: { ...response([original]), id: 'resp_snap_fail' } },
  ]), faultyStore);

  await assertRejects(() => collectEvents(events), Error, 'snapshot write failed');
  assertEquals(await repo.responsesSnapshots.lookup(apiKeyId, TEST_RESPONSE_ID), null);
});

test('in-stream commit: row is visible immediately after done frame', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_in_stream', 'hi');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const iterator = wrapWithStore(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), store)[Symbol.asyncIterator]();

  const doneFrame = await iterator.next();
  assert(doneFrame.value?.type === 'event');
  const storedId = (doneFrame.value.event as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>).item.id!;

  // Row should be committed before the done frame was yielded
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(rows.length, 1, 'row should be visible immediately after done frame');
});

test('end-of-stream items in terminal frame are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_eoi', 'eos');
  const store = createResponsesHttpStore(apiKeyId, undefined);

  const events = wrapWithStore(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]), store);

  const collected = await collectEvents(events);
  const storedId = eventAt(collected, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  const [payload] = await repo.responsesItems.lookupPayloads(apiKeyId, [storedId]);
  assertEquals(row.hasPayload, true);
  assertEquals(payload.payload, { item: original });
});

// --- syntheticEventsFromResult / drainAsync ---

test('syntheticEventsFromResult emits the same frame sequence as emitToResponsesCompact', async () => {
  const item = messageItem('compact_msg_01', 'hello');
  const result: ResponsesResult = {
    id: 'resp_compact_test',
    object: 'response',
    model: 'gpt-test',
    status: 'completed',
    output: [item],
    output_text: 'hello',
    error: null,
    incomplete_details: null,
  };

  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of syntheticEventsFromResult(result)) frames.push(frame);

  // responsesResultToEvents with genericOutputItems produces:
  //   response.created, response.in_progress,
  //   response.output_item.added, response.output_item.done (generic pair),
  //   response.completed
  // then a done sentinel frame.
  const eventTypes = frames.filter(f => f.type === 'event').map(f => (f as { event: ResponsesStreamEvent }).event.type);
  assertEquals(eventTypes, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.output_item.done',
    'response.completed',
  ]);
  assertEquals(frames.at(-1)?.type, 'done');
});

test('drainAsync iterates to completion and returns void', async () => {
  let count = 0;
  const iter = async function* () {
    count += 1;
    yield 'a';
    count += 1;
    yield 'b';
    count += 1;
  };
  const result = await drainAsync(iter());
  assertEquals(result, undefined);
  assertEquals(count, 3);
});
