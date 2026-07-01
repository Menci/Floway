import { afterEach, test, vi } from 'vitest';

import { createStoredResponsesItemId } from './items/format.ts';
import { createResponsesHttpStore, MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem, StoredResponsesSnapshot } from '../../../repo/types.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

// `enumerateModelCandidates` is the only seam between serve and the
// provider registry — mocking it directly keeps the serve tests narrow
// (no fake fetch, no repo upstream rows for provider catalogs) and lets
// each test hand the serve exactly the candidates it wants to exercise.
// `sawModel` defaults to true when at least one candidate was queued; the
// `model-missing` failure tests queue an empty list and expect `sawModel:
// false` so the serve renders 404 rather than 400.
const candidatesQueue: { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('serve_test: no candidates enqueued');
      return next;
    }),
  };
});

const { responsesServe } = await import('./serve.ts');
const { expandPreviousResponseId } = await import('./serve-prep.ts');

const API_KEY_ID = 'key_serve_test';

const queueCandidates = (candidates: readonly ModelCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel, failedUpstreams: [] });
};

afterEach(() => { candidatesQueue.length = 0; });

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (store?: ChatGatewayCtx['store']): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: store ?? createResponsesHttpStore(API_KEY_ID, true),
});

const makePayload = (overrides: Partial<CanonicalResponsesPayload> = {}): CanonicalResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

// Compact tests need a real input array (a bare string can't carry the
// compaction trigger or item_reference shapes the routing layer cares
// about). Default to the kept-user-message the existing happy-path test
// uses; override `input` when a test needs a different shape.
const compactPayload = (overrides: Partial<CanonicalResponsesPayload> = {}): CanonicalResponsesPayload =>
  makePayload({ input: [{ type: 'message', role: 'user', content: 'kept' }], ...overrides });

const makeResponsesResult = (id = 'resp_test'): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi' }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProtocolFrames = async function* <E>(events: readonly E[]): AsyncGenerator<ProtocolFrame<E>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callResponses: overrides.callResponses,
    callMessages: overrides.callMessages,
    callChatCompletions: overrides.callChatCompletions,
  });
  return {
    provider: {
      upstream,
      kind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      instance: provider,
      supportsResponsesItemReference: true,
    },
    // Default keeps stubInternalModel's three-endpoint map intact; tests that
    // need a rejected candidate pass an explicit `endpoints` override.
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate routes a native Responses candidate end to end', async () => {
  installRepo();
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProtocolFrames([completed]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callResponses });
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  assert(events.length >= 1);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('compact returns a result envelope from the wrapped attempt', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponses = vi.fn(async (_model: unknown, _body: unknown, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  const candidate = makeCandidate({ upstream: 'up_a', callResponses });
  queueCandidates([candidate]);

  const result = await responsesServe.compact({
    payload: compactPayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(callResponses.mock.calls.length, 1);
  assertEquals(callResponses.mock.calls[0][2], 'compact');
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: false, response: firstError, modelKey: 'first-key',
  }));
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult('resp_second'),
  };
  const secondCall = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true, events: makeProtocolFrames([completed]), modelKey: 'second-key', headers: new Headers(),
  }));
  const first = makeCandidate({ upstream: 'up_a', callResponses: firstCall });
  const second = makeCandidate({ upstream: 'up_b', callResponses: secondCall });
  queueCandidates([first, second]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // The narrowed candidate list exists exactly so a transient upstream
  // failure (5xx/429/network) on one entry rolls over to the next. The
  // second candidate's success is the request's final answer.
  assertEquals(result.type, 'events');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await responsesServe.generate({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('generate filters out candidates whose endpoints do not satisfy the responses preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callResponses = vi.fn();
  // responsesTarget prefers responses > messages > chat-completions; an
  // endpoints-only `completions` candidate matches none and is filtered out.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callResponses })]);

  const result = await responsesServe.generate({
    payload: makePayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callResponses.mock.calls.length, 0);
});

test('generate renders routing-unavailable as a 400 when a forcing item names an absent upstream', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  const row: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([row]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('compact renders routing-unavailable when no candidate exposes the responses endpoint', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  await repo.responsesItems.insertMany([{
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.compact({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('compact renders model-missing as a 404 when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await responsesServe.compact({
    payload: compactPayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('not available'));
});

test('compact renders model-unsupported as a 400 when the only candidate\'s endpoints don\'t satisfy responses target preferences', async () => {
  installRepo();
  const callResponses = vi.fn();
  // responsesTarget prefers responses > messages > chat-completions; an
  // endpoints-only `completions` candidate matches none and is filtered out.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callResponses })]);

  const result = await responsesServe.compact({
    payload: compactPayload({ model: 'wrong-endpoint-model' }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callResponses.mock.calls.length, 0);
});

test('expandPreviousResponseId prepends snapshot items and strips the previous_response_id field', async () => {
  const repo = installRepo();
  const previousMessageId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: previousMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id: previousMessageId, role: 'user', content: 'first turn' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_prev',
    apiKeyId: API_KEY_ID,
    itemIds: [previousMessageId],
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesSnapshots.insert(snapshot);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const expanded = await expandPreviousResponseId(
    makePayload({
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'second turn' }],
    }),
    store,
  );

  assertEquals(expanded.previous_response_id, undefined);
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id: previousMessageId });
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'second turn' });
});

// In-memory store backed by the layered implementation but with no repo
// behind it, so an `expandPreviousResponseId` test can sit on a snapshot
// that lives nowhere else.
const memoryStore = async (snapshots: readonly StoredResponsesSnapshot[], items: readonly StoredResponsesItem[]) => {
  const backing = new MemoryStatefulResponsesBacking();
  for (const item of items) await backing.insertItems([item], { durable: true });
  for (const snapshot of snapshots) await backing.insertSnapshot(snapshot);
  return new LayeredStatefulResponsesStore({
    apiKeyId: API_KEY_ID,
    reads: [backing],
    itemWrites: [{ backing, durable: true }],
    snapshotWrites: [{ backing, durable: true }],
    stageInputs: true,
    shouldStorePayload: true,
  });
};

test('expandPreviousResponseId resolves snapshots from a non-repo-backed store', async () => {
  installRepo(); // affinity lookups in the wider flow still need a repo, but here the helper only touches the store.
  const id = createStoredResponsesItemId('message');
  const item: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id, role: 'user', content: 'remembered' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_mem',
    apiKeyId: API_KEY_ID,
    itemIds: [id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const store = await memoryStore([snapshot], [item]);

  const expanded = await expandPreviousResponseId(
    makePayload({ previous_response_id: 'resp_mem', input: [{ type: 'message', role: 'user', content: 'new turn' }] }),
    store,
  );

  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id });
});

test('generate falls through translate-out to messages target', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        type: 'message_start',
        message: {
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
    modelKey: 'messages-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_m', endpoints: { messages: {} }, callMessages });
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate falls through translate-out to chat-completions target', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]),
    modelKey: 'chat-completions-key',
    headers: new Headers(),
  }));
  const candidate = makeCandidate({ upstream: 'up_c', endpoints: { chatCompletions: {} }, callChatCompletions });
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate reuses an existing input row when a later turn echoes the same user message', async () => {
  const repo = installRepo();
  let turn = 0;
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => {
    turn += 1;
    return {
      action: 'generate', ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(`resp_turn_${turn}`),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const payload = makePayload({ input: [{ type: 'message', role: 'user', content: 'hello' }] });

  queueCandidates([makeCandidate({ callResponses })]);
  const turn1 = await responsesServe.generate({ payload, ctx: makeGatewayCtx(store), headers: new Headers() });
  if (turn1.type !== 'events') throw new Error('turn 1: expected events');
  const turn1Events = await collectEvents(turn1.events);

  queueCandidates([makeCandidate({ callResponses })]);
  const turn2 = await responsesServe.generate({ payload, ctx: makeGatewayCtx(store), headers: new Headers() });
  if (turn2.type !== 'events') throw new Error('turn 2: expected events');
  const turn2Events = await collectEvents(turn2.events);

  // Both snapshots' first item id is the staged user message; a working
  // content-hash preload makes turn 2 reuse turn 1's row instead of minting
  // a fresh one. Look up by the Floway-minted response id wrap puts on
  // each terminal event — the upstream's `resp_turn_N` id is discarded.
  const turn1ResponseId = (turn1Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const turn2ResponseId = (turn2Events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>).response.id;
  const snap1 = await repo.responsesSnapshots.lookup(API_KEY_ID, turn1ResponseId);
  const snap2 = await repo.responsesSnapshots.lookup(API_KEY_ID, turn2ResponseId);
  if (snap1 === null || snap2 === null) throw new Error('expected both snapshots to be persisted');
  const turn1InputId = snap1.itemIds[0];
  const turn2InputId = snap2.itemIds[0];
  if (turn1InputId === undefined || turn2InputId === undefined) throw new Error('expected each snapshot to start with a staged input item');
  assertEquals(turn2InputId, turn1InputId);
});

test('generate treats compaction_trigger-bearing input as compaction: snapshot replaces prior history with the compaction output alone, trigger reaches the wire but never stores a row', async () => {
  const repo = installRepo();

  // Seed a prior conversation: one user message + a snapshot pointing at it.
  // The compacting turn references that snapshot via previous_response_id, so
  // generate without the trigger would normally append [prior items + this
  // turn's input + output] into the new snapshot. The trigger flips that to
  // 'replace' so the new snapshot only carries the compaction blob — the
  // whole point of compaction is to drop the prior history.
  const priorMessageId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: priorMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id: priorMessageId, role: 'user', content: 'old turn' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);
  await repo.responsesSnapshots.insert({
    id: 'resp_before_compact',
    apiKeyId: API_KEY_ID,
    itemIds: [priorMessageId],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  let receivedInput: unknown = null;
  const callResponses = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderResponsesResult> => {
    receivedInput = (body as { input: unknown }).input;
    return {
      action: 'generate', ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: {
          ...makeResponsesResult(),
          output: [{ type: 'compaction', id: 'upstream_cmp_id', encrypted_content: 'ENC' }] as unknown as ResponsesResult['output'],
        },
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueCandidates([makeCandidate({ upstream: 'up_a', callResponses })]);

  const result = await responsesServe.generate({
    payload: makePayload({
      previous_response_id: 'resp_before_compact',
      input: [{ type: 'compaction_trigger' }],
    }),
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  if (result.type !== 'events') throw new Error('expected events');
  const events = await collectEvents(result.events);
  const completed = events.find(e => e.type === 'response.completed') as Extract<ResponsesStreamEvent, { type: 'response.completed' }>;
  const responseId = completed.response.id;

  // 'replace' semantics: only the new compaction row, no item_reference to
  // priorMessageId and no row for the trigger. (The test would also throw
  // outright at `stageInputItem` if the trigger early-return regressed,
  // since createStoredResponsesItemId('compaction_trigger') has no prefix.)
  const snap = await repo.responsesSnapshots.lookup(API_KEY_ID, responseId);
  if (snap === null) throw new Error('expected snapshot to be persisted');
  assertEquals(snap.itemIds.length, 1);
  const onlyItemId = snap.itemIds[0];
  if (onlyItemId === undefined) throw new Error('unreachable');
  assertEquals(onlyItemId.startsWith('cmp_'), true);

  // The trigger still reaches the upstream — the gateway only intercepts at
  // the storage seam, not on the wire. The expanded prefix puts item_reference
  // first, the trigger last.
  if (!Array.isArray(receivedInput)) throw new Error('expected the wire input to be an array');
  assertEquals((receivedInput.at(-1) as { type?: unknown })?.type, 'compaction_trigger');
});
