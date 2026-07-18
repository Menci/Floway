import { afterEach, test, vi } from 'vitest';

import { createResponsesItemId } from './items/format.ts';
import { createResponsesHttpStore, MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem, StoredResponsesSnapshot } from '../../../repo/types.ts';
import { mockChatGatewayCtx } from '../../../test-helpers/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { CanonicalResponsesPayload, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the serve exactly the provider
// candidates it wants, optionally with an alias-rules overlay attached.
// `sawModel` defaults to true when at least one candidate was queued; the
// `model-missing` failure tests queue an empty list and expect `sawModel:
// false` so the serve renders 404 rather than 400.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}
const resolutionsQueue: QueuedResolution[] = [];
const lastResolveCall: { model?: string } = {};
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async ({ model }: { model: string }) => {
      lastResolveCall.model = model;
      const next = resolutionsQueue.shift();
      if (next === undefined) throw new Error('serve_test: no resolution enqueued');
      return next;
    }),
  };
});

const { responsesServe } = await import('./serve.ts');
const { expandPreviousResponseId } = await import('./serve-prep.ts');

const API_KEY_ID = 'key_serve_test';

const queueResolution = (
  candidates: readonly ModelCandidate[],
  extra: { sawModel?: boolean; aliasRules?: AliasRules } = {},
): void => {
  const rules = extra.aliasRules;
  resolutionsQueue.push({
    candidates: rules !== undefined ? candidates.map(c => ({ ...c, rules })) : candidates,
    sawModel: extra.sawModel ?? candidates.length > 0,
    failedUpstreams: [],
  });
};

afterEach(() => { resolutionsQueue.length = 0; });

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({
    apiKeyId: API_KEY_ID,
    wantsStream: true,
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
  modelId?: string;
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
    },
    // Default keeps stubInternalModel's three-endpoint map intact; tests that
    // need a rejected candidate pass an explicit `endpoints` override.
    model: stubInternalModel({
      id: overrides.modelId ?? 'test-model',
      ...(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
    }, upstream),
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
  queueResolution([candidate]);

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
  const observedModelIds: string[] = [];
  const callResponses = vi.fn(async (model: unknown, _body: unknown, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    observedModelIds.push((model as { id: string }).id);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-target', callResponses });
  queueResolution([candidate]);
  const payload = compactPayload({ model: 'gpt-alias' });

  const result = await responsesServe.compact({
    payload,
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(callResponses.mock.calls.length, 1);
  assertEquals(callResponses.mock.calls[0][2], 'compact');
  assertEquals(observedModelIds, ['gpt-target']);
  assertEquals(payload.model, 'gpt-alias');
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const originalImageUrl = 'data:image/png;base64,AQID';
  const payload = makePayload({
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: originalImageUrl, detail: 'auto' }],
    }],
  });
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderResponsesResult> => {
    const item = (body as Omit<CanonicalResponsesPayload, 'model'>).input[0];
    if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
    item.content[0].image_url = 'data:image/webp;base64,COMPRESSED';
    return { action: 'generate', ok: false, response: firstError, modelKey: 'first-key' };
  });
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult('resp_second'),
  };
  let fallbackImageUrl: string | null | undefined;
  const secondCall = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderResponsesResult> => {
    const item = (body as Omit<CanonicalResponsesPayload, 'model'>).input[0];
    if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
    fallbackImageUrl = item.content[0].image_url;
    return { action: 'generate', ok: true, events: makeProtocolFrames([completed]), modelKey: 'second-key', headers: new Headers() };
  });
  const first = makeCandidate({ upstream: 'up_a', callResponses: firstCall });
  const second = makeCandidate({ upstream: 'up_b', callResponses: secondCall });
  queueResolution([first, second]);

  const result = await responsesServe.generate({
    payload,
    ctx: makeGatewayCtx(),
    headers: new Headers(),
  });

  // The narrowed candidate list exists exactly so a transient upstream
  // failure (5xx/429/network) on one entry rolls over to the next. The
  // second candidate's success is the request's final answer.
  assertEquals(result.type, 'events');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
  assertEquals(fallbackImageUrl, originalImageUrl);
  const sourceItem = payload.input[0];
  if (sourceItem.type !== 'message' || !Array.isArray(sourceItem.content) || sourceItem.content[0]?.type !== 'input_image') throw new Error('expected source image content');
  assertEquals(sourceItem.content[0].image_url, originalImageUrl);
});

// A mid-attempt throw (interceptor bug / translation error / provider-layer
// JS exception bypassing tryCatchChatServeFailure) must attribute the perf
// error row to the throwing candidate, not the previous one that already
// failed cleanly with a 5xx.
test('mid-attempt throw stamps telemetry with the throwing candidate, not the previous one', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderResponsesResult> => {
    throw new Error('simulated provider-layer JS exception');
  });
  queueResolution([
    makeCandidate({ upstream: 'up_a', callResponses: firstCall }),
    makeCandidate({ upstream: 'up_b', callResponses: secondCall }),
  ]);

  const ctx = makeGatewayCtx();
  await responsesServe.generate({
    payload: makePayload(),
    ctx,
    headers: new Headers(),
  }).then(
    () => { throw new Error('expected responsesServe.generate to throw'); },
    (error: unknown) => {
      assertEquals((error as Error).message, 'simulated provider-layer JS exception');
    },
  );

  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
  assertEquals(ctx.attempt.telemetry?.upstream, 'up_b');
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

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
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callResponses })]);

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

test('compact renders model-missing as a 404 when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

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
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callResponses })]);

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
  const previousMessageId = createResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: previousMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    contentHash: 'previous-message-hash',
    payload: { item: { type: 'message', id: previousMessageId, role: 'user', content: 'first turn' } },
    createdAt: 1_000,
  }]);
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_prev',
    apiKeyId: API_KEY_ID,
    itemIds: [previousMessageId],
    createdAt: 1_000,
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
  for (const item of items) await backing.insertItems([item]);
  for (const snapshot of snapshots) await backing.insertSnapshot(snapshot);
  return new LayeredStatefulResponsesStore({
    apiKeyId: API_KEY_ID,
    reads: [backing],
    writes: [backing],
  });
};

test('expandPreviousResponseId resolves snapshots from a non-repo-backed store', async () => {
  installRepo(); // affinity lookups in the wider flow still need a repo, but here the helper only touches the store.
  const id = createResponsesItemId('message');
  const item: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    contentHash: 'memory-message-hash',
    payload: { item: { type: 'message', id, role: 'user', content: 'remembered' } },
    createdAt: 1_000,
  };
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_mem',
    apiKeyId: API_KEY_ID,
    itemIds: [id],
    createdAt: 1_000,
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
  queueResolution([candidate]);

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
  queueResolution([candidate]);

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

test('alias resolution swaps the inbound model id for the target and overlays rules onto the Responses IR', async () => {
  installRepo();
  const capturedBodies: ResponsesPayload[] = [];
  const observedModelIds: string[] = [];
  const callResponses = vi.fn(async (model: unknown, body: unknown): Promise<ProviderResponsesResult> => {
    observedModelIds.push((model as { id: string }).id);
    capturedBodies.push(body as ResponsesPayload);
    return { action: 'generate', ok: true, events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: makeResponsesResult() }]), modelKey: 'gpt-5.4', headers: new Headers() };
  });
  const candidate = makeCandidate({ upstream: 'up_a', modelId: 'gpt-5.4', callResponses });
  queueResolution([candidate], {
    aliasRules: { reasoning: { effort: 'high', summary: 'detailed' }, verbosity: 'medium', serviceTier: 'priority' },
  });

  const payload = makePayload({ model: 'gpt-fast' });
  const result = await responsesServe.generate({
    payload,
    ctx: makeGatewayCtx(createResponsesHttpStore(API_KEY_ID, true)),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  // Resolver and caller payload retain the inbound alias; the provider model
  // argument carries the resolved target id while the body omits `model`.
  assertEquals(lastResolveCall.model, 'gpt-fast');
  assertEquals(observedModelIds, ['gpt-5.4']);
  assertEquals(payload.model, 'gpt-fast');
  const observed = capturedBodies[0]!;
  assertEquals(observed.reasoning?.effort, 'high');
  assertEquals(observed.reasoning?.summary, 'detailed');
  assertEquals(observed.text?.verbosity, 'medium');
  assertEquals(observed.service_tier, 'priority');
});

test('alias whose targets have no kind-matching binding surfaces as the regular model-missing 404', async () => {
  installRepo();
  queueResolution([], { sawModel: false });

  const result = await responsesServe.generate({
    payload: makePayload({ model: 'gpt-fast' }),
    ctx: makeGatewayCtx(createResponsesHttpStore(API_KEY_ID, true)),
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.message, 'Model gpt-fast is not available on any configured upstream.');
});
