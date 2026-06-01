import { test, vi } from 'vitest';

import { isStoredResponsesItemId } from './format.ts';
import { storeResponsesOutputItems, type StoreResponsesContext } from './output.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { ResponsesItemsRepo, StoredResponsesItem } from '../../../../../repo/types.ts';
import { assert, assertEquals } from '../../../../../test-assert.ts';
import type { RequestContext } from '../../../../llm/interceptors.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesOutputItem, ResponsesResult, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { translateResponsesViaMessages } from '@floway-dev/translate';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const apiKeyId = 'key_output';

type IteratorResultPromise = Promise<IteratorResult<ProtocolFrame<RawResponsesStreamEvent>>>;

const makeContext = (overrides: Partial<StoreResponsesContext> = {}): StoreResponsesContext => ({
  targetApi: overrides.targetApi ?? 'responses',
  upstream: overrides.upstream ?? 'up_native',
  store: overrides.store,
});

const makeRequest = (syntheticItemIds: Iterable<string> = []): RequestContext => ({
  requestStartedAt: 0,
  apiKeyId,
  runtimeLocation: 'test',
  clientStream: true,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set(syntheticItemIds) },
});

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

const framesFrom = async function* (events: readonly RawResponsesStreamEvent[]) {
  for (const event of events) yield eventFrame(event);
};

// All assertions below that expect rows present immediately after draining
// the stream exercise the streaming path, where finalized items write through
// at once. `.events` drops the commit handle, which is a no-op there.
const storeStreaming = (
  frames: AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>>,
  context: StoreResponsesContext,
  request: RequestContext,
): AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>> =>
  storeResponsesOutputItems(frames, responsesItemsView, context, request, true).events;

const collectEvents = async (events: AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>>): Promise<RawResponsesStreamEvent[]> => {
  const collected: RawResponsesStreamEvent[] = [];
  for await (const item of events) {
    if (item.type === 'event') collected.push(item.event);
  }
  return collected;
};

const eventAt = <TType extends RawResponsesStreamEvent['type']>(
  events: readonly RawResponsesStreamEvent[],
  type: TType,
): Extract<RawResponsesStreamEvent, { type: TType }> => {
  const event = events.find((candidate): candidate is Extract<RawResponsesStreamEvent, { type: TType }> => candidate.type === type);
  assert(event, `expected ${type}`);
  return event;
};

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

class ControlledResponsesItemsRepo implements ResponsesItemsRepo {
  calls: StoredResponsesItem[][] = [];
  resolveInsert: (() => void) | undefined;
  rejectInsert: ((error: unknown) => void) | undefined;

  lookupMany(): Promise<StoredResponsesItem[]> {
    return Promise.resolve([]);
  }

  lookupManyByEncryptedContentHash(): Promise<StoredResponsesItem[]> {
    return Promise.resolve([]);
  }

  insertMany(items: readonly StoredResponsesItem[]): Promise<void> {
    this.calls.push(items.map(item => structuredClone(item)));
    return new Promise((resolve, reject) => {
      this.resolveInsert = resolve;
      this.rejectInsert = reject;
    });
  }

  clearPayloadOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteOlderThan(): Promise<number> {
    return Promise.resolve(0);
  }

  deleteAll(): Promise<void> {
    return Promise.resolve();
  }
}

test('rewrites output item ids consistently across added, child, done, and terminal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: original.id!, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeContext(), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  assert(isStoredResponsesItemId(storedId));
  assert(storedId.startsWith('msg_'));
  assertEquals(eventAt(events, 'response.output_item.added').item.id, storedId);
  assertEquals(eventAt(events, 'response.output_text.delta').item_id, storedId);
  assertEquals(eventAt(events, 'response.completed').response.output[0].id, storedId);

  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, 'up_native');
  assertEquals(row.upstreamItemId, original.id);
  assertEquals(row.payload, { item: original });
});

test('persists each row before yielding the item-done frame', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');
  const iterator = storeStreaming(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeContext(), makeRequest())[Symbol.asyncIterator]();

  // added flows real-time without persist; mid-stream replay race is
  // accepted per design.
  const addedFrame = await iterator.next();
  assertEquals((addedFrame.value as ProtocolFrame<RawResponsesStreamEvent>).type, 'event');
  assertEquals(controlled.calls.length, 0);

  // done is held until the row insert resolves, so a client that has seen
  // `done` can reference the row on its next turn.
  const doneFrame = iterator.next();
  assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
  assertEquals(controlled.calls.length, 1);
  controlled.resolveInsert?.();
  assertEquals(((await doneFrame).value as ProtocolFrame<RawResponsesStreamEvent>).type, 'event');
});

test('insert failure does not sink the stream', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const original = messageItem('raw_msg_native', 'hello');
    const iterator = storeStreaming(framesFrom([
      { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
      { type: 'response.output_item.done', output_index: 0, item: original },
      { type: 'response.completed', response: response([original]) },
    ]), makeContext(), makeRequest())[Symbol.asyncIterator]();

    assertEquals(((await iterator.next()).value as ProtocolFrame<RawResponsesStreamEvent>).type, 'event');

    // done is held until the insert settles; a failing insert is swallowed and
    // the frame still flows, so storage can never sink the stream.
    const doneFrame = iterator.next();
    assertEquals(await promiseStateAfterMicrotasks(doneFrame), 'pending');
    controlled.rejectInsert?.(new Error('insert failed'));
    assertEquals(((await doneFrame).value as ProtocolFrame<RawResponsesStreamEvent>).type, 'event');

    const completed = (await iterator.next()).value as ProtocolFrame<RawResponsesStreamEvent>;
    assert(completed.type === 'event' && completed.event.type === 'response.completed');
    assert((await iterator.next()).done);
    assert(errorSpy.mock.calls.length > 0);
  } finally {
    errorSpy.mockRestore();
  }
});

test('does not insert rows for failed streams without observed items', async () => {
  const repo = new InMemoryRepo();
  const controlled = new ControlledResponsesItemsRepo();
  repo.responsesItems = controlled;
  initRepo(repo);

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.failed', response: response([], 'failed') },
  ]), makeContext(), makeRequest()));

  assertEquals(events.at(-1)?.type, 'response.failed');
  assertEquals(controlled.calls.length, 0);
});

test('items completed before a stream failure remain persisted', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: { ...original, content: [] } },
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.failed', response: response([], 'failed') },
  ]), makeContext(), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: original });
});

test('store false creates metadata rows with null payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeContext({ store: false }), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, null);
  assertEquals(row.upstreamItemId, original.id);
});

test('terminal output items missing done frames are stored and rewritten', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_terminal_only', 'late');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.completed', response: response([original]) },
  ]), makeContext(), makeRequest()));

  const storedId = eventAt(events, 'response.completed').response.output[0].id!;
  assert(isStoredResponsesItemId(storedId));
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: original });
});

test('two distinct upstream items receive distinct stored ids', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const first = messageItem('raw_msg_1', 'first');
  const second = messageItem('raw_msg_2', 'second');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.done', output_index: 1, item: second },
    { type: 'response.completed', response: response([first, second]) },
  ]), makeContext(), makeRequest()));

  const done = events.filter((event): event is Extract<RawResponsesStreamEvent, { type: 'response.output_item.done' }> => event.type === 'response.output_item.done');
  assert(done[0].item.id !== done[1].item.id);
  assert(isStoredResponsesItemId(done[0].item.id!));
  assert(isStoredResponsesItemId(done[1].item.id!));
  const rows = await repo.responsesItems.lookupMany(apiKeyId, [done[0].item.id!, done[1].item.id!]);
  assertEquals(rows.length, 2);
  assertEquals(rows[0].upstreamItemId, 'raw_msg_1');
  assertEquals(rows[1].upstreamItemId, 'raw_msg_2');
});

test('repeated mapper calls for the same upstream id refresh the stored payload', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const partial = { ...messageItem('raw_msg_repeat', ''), status: 'in_progress' as const, content: [] };
  const final = messageItem('raw_msg_repeat', 'final');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.added', output_index: 0, item: partial },
    { type: 'response.output_item.done', output_index: 0, item: final },
    { type: 'response.completed', response: response([final]) },
  ]), makeContext(), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: final });
});

test('via-translation synthesized items do not claim upstream ownership', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('msg_0', 'translated');

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), makeContext({ targetApi: 'messages' }), makeRequest()));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
});

test('gateway-synthesized items registered this request do not claim upstream ownership on a native stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  // A source interceptor (the web-search shim) synthesizes a web_search_call
  // with a gateway-minted id and registers it on the request. Even though the
  // upstream is a native Responses upstream (targetApi: 'responses'), the row
  // must carry no upstream identity — the upstream never issued this id — so it
  // stays non_affinity rather than biasing routing toward that upstream.
  const synthetic: Extract<ResponsesOutputItem, { type: 'web_search_call' }> = {
    type: 'web_search_call',
    id: 'ws_gw_synthetic00000000000',
    status: 'completed',
    action: { type: 'search', query: 'q', queries: ['q'] },
    results: [],
  };

  const events = await collectEvents(storeStreaming(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: synthetic },
    { type: 'response.completed', response: response([synthetic]) },
  ]), makeContext(), makeRequest([synthetic.id])));

  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.upstreamId, null);
  assertEquals(row.upstreamItemId, null);
  assertEquals(row.itemType, 'web_search_call');
});

test('non-streaming buffers item rows and persists nothing until commit', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  const stored = storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'response.completed', response: response([original]) },
  ]), responsesItemsView, makeContext(), makeRequest(), false);

  // Draining the stream finalizes the item but, in deferred mode, must not
  // touch the repo — the buffered row only lands on commit.
  const events = await collectEvents(stored.events);
  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  assertEquals((await repo.responsesItems.lookupMany(apiKeyId, [storedId])).length, 0);

  await stored.commitForNonStreaming!();
  const [row] = await repo.responsesItems.lookupMany(apiKeyId, [storedId]);
  assertEquals(row.payload, { item: original });
});

test('non-streaming item-done then stream error persists nothing when commit is skipped', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const original = messageItem('raw_msg_native', 'hello');

  // The respond layer drains the stream to assemble the JSON body; a stream
  // error after an item-done makes the reassembler throw, so the success
  // branch (and its commit) is never reached and the buffer is discarded.
  const stored = storeResponsesOutputItems(framesFrom([
    { type: 'response.output_item.done', output_index: 0, item: original },
    { type: 'error', message: 'upstream exploded', code: 'server_error' },
  ]), responsesItemsView, makeContext(), makeRequest(), false);

  const events = await collectEvents(stored.events);
  const storedId = eventAt(events, 'response.output_item.done').item.id!;
  // commit() is deliberately not called, mirroring the 502 path.
  assertEquals((await repo.responsesItems.lookupMany(apiKeyId, [storedId])).length, 0);
});

// End-to-end proof for the responses-via-other direction: a Responses client
// routed to a Messages upstream. The translator synthesizes Responses output
// items from the Messages stream, every synthesized item now carries an id,
// and `storeResponsesOutputItems` (targetApi: 'messages') records each as a
// synthetic row (upstreamId null, payload present) that later requests can
// inline-expand via item_reference.
const messagesFramesFrom = async function* (events: readonly MessagesStreamEvent[]) {
  for (const event of events) yield eventFrame(event);
};

const translateMessagesUpstreamToResponses = async (
  events: readonly MessagesStreamEvent[],
): Promise<AsyncIterable<ProtocolFrame<RawResponsesStreamEvent>>> => {
  const trip = await translateResponsesViaMessages(
    { model: 'claude-test', input: [], stream: true } as never,
    { model: 'claude-test' },
  );
  return trip.events(messagesFramesFrom(events));
};

test('responses-via-messages synthesized message and function_call items persist as synthetic rows', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const upstreamFrames = await translateMessagesUpstreamToResponses([
    { type: 'message_start', message: { id: 'msg_up', type: 'message', role: 'assistant', content: [], model: 'claude-test', stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ] as MessagesStreamEvent[]);

  const events = await collectEvents(
    storeStreaming(upstreamFrames, makeContext({ targetApi: 'messages', upstream: 'up_anthropic' }), makeRequest()),
  );

  const doneEvents = events.filter(
    (event): event is Extract<RawResponsesStreamEvent, { type: 'response.output_item.done' }> => event.type === 'response.output_item.done',
  );
  const messageDone = doneEvents.find(event => event.item.type === 'message');
  const functionDone = doneEvents.find(event => event.item.type === 'function_call');
  assert(messageDone, 'expected a message output_item.done');
  assert(functionDone, 'expected a function_call output_item.done');

  // The client sees gateway stored ids on the wire — the synthesized index ids
  // are mapped through the storage layer just like native upstream ids.
  const messageStoredId = messageDone.item.id!;
  const functionStoredId = functionDone.item.id!;
  assert(isStoredResponsesItemId(messageStoredId));
  assert(isStoredResponsesItemId(functionStoredId));
  assert(messageStoredId.startsWith('msg_'));
  assert(functionStoredId.startsWith('fc_'));

  const rows = await repo.responsesItems.lookupMany(apiKeyId, [messageStoredId, functionStoredId]);
  const rowById = new Map(rows.map(row => [row.id, row]));
  const messageRow = rowById.get(messageStoredId)!;
  const functionRow = rowById.get(functionStoredId)!;

  // Synthetic: no upstream ownership, full payload retained for inline replay.
  assertEquals(messageRow.upstreamId, null);
  assertEquals(messageRow.upstreamItemId, null);
  assertEquals(messageRow.payload?.item, {
    type: 'message',
    id: 'msg_0',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
  });
  assertEquals(functionRow.upstreamId, null);
  assertEquals(functionRow.upstreamItemId, null);
  assertEquals(functionRow.payload?.item, {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'toolu_1',
    name: 'lookup',
    arguments: '{"q":"x"}',
    status: 'completed',
  });
});
