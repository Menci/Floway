import { expect, test } from 'vitest';

import { wrapResponsesClientOutput } from './output.ts';
import { isResponsesItemId } from './format.ts';
import { createResponsesHttpStore } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { ResponsesAttemptState } from '../attempt-state.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const frames = async function* (response: ResponsesResult): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
  const item = response.output[0];
  yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
  yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
  yield eventFrame({ type: 'response.completed', response });
  yield doneFrame();
};

test('client output rewrites ids and persists the exact complete item before terminal', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
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

test('client output uses one item id across lifecycle snapshots without committing a failed snapshot', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
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
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output mints and persists one lifecycle id for an id-less item', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
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
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
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

test('client output rejects terminal item drift after output_item.done', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
  const collect = async () => {
    for await (const _frame of wrapResponsesClientOutput(input(), {
      store,
      attemptState: new ResponsesAttemptState(),
      responseId: 'resp_public',
    })) void _frame;
  };

  await expect(collect()).rejects.toThrow('Responses output item 0 changed after output_item.done');
  expect(await repo.responsesSnapshots.lookup('key-a', 'resp_public')).toBeNull();
});

test('client output rejects repeated output_item.done drift', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
  const first = { type: 'reasoning' as const, id: 'rs_upstream', summary: [{ type: 'summary_text' as const, text: 'old' }] };
  const changed = { ...first, summary: [{ type: 'summary_text' as const, text: 'new' }] };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: first });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: changed });
  };
  const collect = async () => {
    for await (const _frame of wrapResponsesClientOutput(input(), {
      store,
      attemptState: new ResponsesAttemptState(),
      responseId: 'resp_public',
    })) void _frame;
  };

  await expect(collect()).rejects.toThrow('Responses output item 0 changed after output_item.done');
});

test('snapshot output IDs follow output_index rather than done arrival order', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') terminal = frame.event.response;
  if (terminal === undefined) throw new Error('Expected terminal response');

  expect((await repo.responsesSnapshots.lookup('key-a', 'resp_public'))?.itemIds).toEqual(
    terminal.output.map(item => item.id),
  );
});

test('finalized item validation accepts the compaction_summary alias', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const store = createResponsesHttpStore('key-a', true);
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
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  })) if (frame.type === 'event') events.push(frame.event);

  expect(events.at(-1)?.type).toBe('response.completed');
});
