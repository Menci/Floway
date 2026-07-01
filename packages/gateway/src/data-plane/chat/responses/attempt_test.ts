import { test, vi } from 'vitest';

import { responsesAttempt } from './attempt.ts';
import { createStoredResponsesItemId, isStoredResponseId } from './items/format.ts';
import * as outputModule from './items/output.ts';
import { createResponsesHttpStore, createNonResponsesSourceStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../repo/types.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderModel, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (store?: ChatGatewayCtx['store']): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: store ?? createNonResponsesSourceStore(API_KEY_ID),
});

const makePayload = (overrides: Partial<CanonicalResponsesPayload> = {}): CanonicalResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

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

const makeProviderEvents = async function* (events: readonly ResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (
  callResponses: (model: ProviderModel, body: Omit<ResponsesPayload, 'model'>, action: ResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderResponsesResult>,
  enabledFlags: ReadonlySet<string> = new Set<string>(),
): ModelCandidate => {
  const provider = stubProvider({ callResponses });
  const upstream = 'up_test';
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
    model: stubInternalModel({
      providerModels: { [upstream]: stubProviderModel({ enabledFlags }) },
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

const installRepo = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const insertStoredItem = async (repo: InMemoryRepo, overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'itemType'>): Promise<StoredResponsesItem> => {
  const row: StoredResponsesItem = {
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    origin: 'synthetic',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
    ...overrides,
  };
  await repo.responsesItems.insertMany([row]);
  return row;
};

test('generate native success wraps the upstream event stream once', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  const completedEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));

  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const ctx = makeGatewayCtx(store);
  const commitSpy = vi.spyOn(store, 'commitSnapshot').mockResolvedValue();

  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');

  // Drain so the wrapped pipeline runs and storage callbacks fire.
  const events = await collectEvents(result.events);
  assert(events.length >= 1, 'expected at least the response.completed event');

  assertEquals(callResponses.mock.calls.length, 1);
  assertEquals(wrapSpy.mock.calls.length, 1);
  const wrapArgs = wrapSpy.mock.calls[0][1];
  assertEquals(wrapArgs.upstream, 'up_test');
  assertEquals(wrapArgs.targetApi, 'responses');
  // The upstream emitted no compaction-shape item, so wrap derived 'append'.
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'append');

  wrapSpy.mockRestore();
});

test('generate derives snapshotMode=replace when the upstream emits a compaction output item', async () => {
  // A direct `/v1/responses` generate carrying a `compaction_trigger` input
  // (Codex's RemoteCompactionV2) — or a `context_management` `compact_threshold`
  // turn that triggers server-side compaction — yields a compaction-shape
  // output envelope on the wire. Wrap observes that output and derives a
  // 'replace' snapshot regardless of how the request was framed.
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  const compactionItem = {
    type: 'compaction',
    id: 'cmp_trigger',
    encrypted_content: 'ENC',
  };
  const compactionResponse: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const completedEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: compactionResponse,
  };
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));

  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const commitSpy = vi.spyOn(store, 'commitSnapshot').mockResolvedValue();

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'kept message' },
      ],
    }),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assertEquals(wrapSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'replace');

  wrapSpy.mockRestore();
});

test('generate returns failure when rewrite throws item-not-found', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => {
    throw new Error('callResponses should not be called when rewrite fails');
  });
  const candidate = makeCandidate(callResponses);
  // Force `supportsResponsesItemReference: false` so a stored row with no
  // inline payload triggers the rewrite-side throw.
  candidate.provider.supportsResponsesItemReference = false;

  const missingId = createStoredResponsesItemId('message');
  // Pre-seed the store cache: a row with no inline payload, referenced as
  // `item_reference`. The store will resolve the id, and rewrite will throw
  // because the candidate cannot accept `item_reference`.
  const store = createResponsesHttpStore(API_KEY_ID, true);
  // Insert into the underlying repo so `loadInputItems` populates the cache.
  // The store uses `getRepo()` lazily, so the repo installed via `installRepo`
  // already feeds this lookup.
  const repo = installRepo();
  await insertStoredItem(repo, { id: missingId, itemType: 'message', payload: null });
  await store.loadInputItems({
    sourceItems: [{ type: 'item_reference' as const, id: missingId }],
    view: {
      visitAsResponsesItems: async (items, visit) => {
        for (const item of items as readonly { id: string }[]) await visit({ type: 'item_reference', id: item.id });
      },
    },
  });

  const result = await responsesAttempt.generate({
    payload: makePayload({ input: [{ type: 'item_reference', id: missingId }] }),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, null);
  assertEquals(body.error.message, `Item with id '${missingId}' not found.`);
  assertEquals(callResponses.mock.calls.length, 0);
});

test('generate passes non-events provider result through unchanged', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  const upstreamResponse = new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 502, headers: new Headers({ 'content-type': 'application/json' }) });
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: false,
    response: upstreamResponse,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callResponses);
  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(createResponsesHttpStore(API_KEY_ID, true)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 502);
  // Wrap must not run when the upstream failed before any events flowed.
  assertEquals(wrapSpy.mock.calls.length, 0);
  wrapSpy.mockRestore();
});

test('compact reshapes the trigger turn into a result and derives snapshotMode=replace from the synthesized envelope', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesOutputForStorage');

  // Native /responses/compact returns a fully-shaped compaction envelope —
  // the `action: 'compact'` branch of `provider.callResponses` does the
  // Copilot compaction_trigger reshape internally — so the attempt receives
  // a ResponsesResult, expands it into synthetic frames, and wraps the
  // output for storage. The synthesized envelope carries a `compaction`
  // output item; wrap observes it and derives the 'replace' snapshot.
  const compactionItem = {
    type: 'compaction' as const,
    id: 'cmp_1',
    encrypted_content: 'ENC',
  };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    // Cast: `compaction` is an input-shaped item type the protocol's
    // ResponsesResult.output type does not include but the runtime accepts.
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };

  const callResponses = vi.fn(async (_model: ProviderModel, _body: Omit<ResponsesPayload, 'model'>, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`compact candidate received action='${action}'`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });

  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const commitSpy = vi.spyOn(store, 'commitSnapshot').mockResolvedValue();
  const result = await responsesAttempt.invoke({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'kept message' },
      ],
    }),
    action: 'compact',
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(result.result.output.length, 1);
  assertEquals((result.result.output[0] as { id: string }).id, 'cmp_1');
  // The compact result wears a Floway-minted response id, not the upstream's
  // — same id wrap committed the snapshot under.
  assert(isStoredResponseId(result.result.id));

  // wrap-output-storage runs exactly once on the synthesized compaction
  // events; the compaction item in the output drives commitSnapshot('replace').
  assertEquals(wrapSpy.mock.calls.length, 1);
  assertEquals(wrapSpy.mock.calls[0][1].targetApi, 'responses');
  assertEquals(commitSpy.mock.calls.length, 1);
  assertEquals(commitSpy.mock.calls[0][1], 'replace');

  wrapSpy.mockRestore();
});

// In-attempt test asserting the narrow header-inheritance contract: when an
// outer protocol passes invocation headers, the translated Messages call sees
// them on the wire.
test('generate inherits invocation headers across translation to Messages', async () => {
  installRepo();
  let observedHeaders: Headers | undefined;
  const upstreamModel = stubInternalModel({ endpoints: { messages: {} } }, 'up_test');
  const messagesProvider = stubProvider({
    callMessages: async (_model, _body, _signal, opts): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
      observedHeaders = opts.headers;
      return {
        ok: true,
        events: (async function* () {
          yield eventFrame<MessagesStreamEvent>({
            type: 'message_start',
            message: {
              id: 'msg_1', type: 'message', role: 'assistant', content: [],
              model: 'test-model', stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          });
          yield eventFrame<MessagesStreamEvent>({ type: 'message_stop' });
          yield doneFrame();
        })(),
        modelKey: 'k',
        headers: new Headers(),
      };
    },
  });
  const candidate: ModelCandidate = {
    provider: {
      upstream: 'up_test', kind: 'custom', name: 'up_test',
      disabledPublicModelIds: [], modelPrefix: null, instance: messagesProvider, supportsResponsesItemReference: true,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };

  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(createResponsesHttpStore(API_KEY_ID, true)),
    candidate,
    headers: new Headers({ 'x-test': 'abc' }),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedHeaders?.get('x-test'), 'abc');
});

test('generate seeds privatePayload before interceptors so the web-search shim replays the prior wsc results on echo', async () => {
  // End-to-end contract: when a stateless client (e.g. Codex CLI) echoes a
  // prior web_search_call by the gateway-minted id, the web-search shim's
  // `transformItems` (which runs as part of the interceptor chain) must
  // find the persisted `payload.private` and emit the cached function_call
  // + function_call_output pair to upstream — NOT the not-preserved
  // placeholder.
  //
  // The wire shape we model here:
  //   - row.id = stored gateway id (`ws_<crc>_<body>`) — wrapResponsesOutputForStorage
  //     emits this on the wire and clients echo it back as `wsc.id`.
  //   - payload.item.id = the original `ws_gw_` wire id the shim synthesized
  //     on turn 1; beginAttempt keys privatePayload by it after inline expansion.
  //   - payload.private = WebSearchCallPrivatePayload (v:1, functionCallItem, ir).
  //
  // This regression caught a prior ordering bug where rewrite + beginAttempt
  // ran inside the interceptor closure, after the shim's input transform —
  // so privatePayload was always empty when the shim looked it up, and
  // every echoed wsc collapsed to the placeholder.
  const repo = installRepo();
  const storedId = createStoredResponsesItemId('web_search_call');
  const wireId = 'ws_gw_72927da0b19d48aa874e9937';
  await insertStoredItem(repo, {
    id: storedId,
    itemType: 'web_search_call',
    origin: 'synthetic',
    payload: {
      item: {
        type: 'web_search_call',
        id: wireId,
        status: 'completed',
        action: { type: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
      },
      private: {
        v: 1,
        functionCallItem: {
          type: 'function_call',
          call_id: 'call_orig_xyz',
          name: 'web_search',
          arguments: '{"search_query":[{"q":"deepseek v4"}]}',
          status: 'completed',
        },
        ir: {
          action: { type: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
          results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'CACHED_SNIPPET_BODY' }],
        },
      },
    },
  });

  // Capture the upstream-bound body so we can verify what the shim produced
  // after the echoed wsc passed through transformItems.
  let capturedBody: { input?: unknown[] } | undefined;
  const upstreamResponse = makeResponsesResult();
  // The shim's multi-turn loop requires `response.created` (carrying a model
  // name) before any synthesized terminal envelope. Emit the canonical
  // created → in_progress → completed sequence so the shim can wrap.
  const upstreamEvents: ResponsesStreamEvent[] = [
    { type: 'response.created', sequence_number: 0, response: upstreamResponse },
    { type: 'response.in_progress', sequence_number: 1, response: upstreamResponse },
    { type: 'response.completed', sequence_number: 2, response: upstreamResponse },
  ];
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    capturedBody = body as { input?: unknown[] };
    return { action: 'generate', ok: true, events: makeProviderEvents(upstreamEvents), modelKey: 'test-model-key', headers: new Headers() };
  });
  const candidate = makeCandidate(callResponses, new Set(['responses-web-search-shim']));

  const store = createResponsesHttpStore(API_KEY_ID, true);
  await store.loadInputItems({
    sourceItems: [{ id: storedId } as unknown as { id: string }],
    view: {
      visitAsResponsesItems: async (items, visit) => {
        for (const item of items as readonly { id: string }[]) {
          await visit({ type: 'web_search_call', id: item.id } as unknown as never);
        }
      },
    },
  });

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'user', content: 'follow-up' },
        {
          type: 'web_search_call',
          id: storedId,
          status: 'completed',
          action: { type: 'search', queries: ['deepseek v4'] },
        } as unknown as never,
      ],
      tools: [{ type: 'web_search' }],
    }),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assert(capturedBody !== undefined, 'callResponses was not invoked');
  const input = (capturedBody!.input ?? []) as Array<{ type: string; call_id?: string; output?: string; name?: string; arguments?: string }>;
  // The wsc echo MUST be replaced by the recovered function_call + output pair,
  // carrying the persisted call_id and the cached snippet body verbatim.
  const fc = input.find(i => i.type === 'function_call' && i.call_id === 'call_orig_xyz');
  assert(fc !== undefined, 'expected replayed function_call with the persisted call_id');
  assertEquals(fc!.name, 'web_search');
  assertEquals(fc!.arguments, '{"search_query":[{"q":"deepseek v4"}]}');
  const fco = input.find(i => i.type === 'function_call_output' && i.call_id === 'call_orig_xyz');
  assert(fco !== undefined, 'expected replayed function_call_output');
  assert(fco!.output?.includes('CACHED_SNIPPET_BODY'), `expected cached body in function_call_output, got: ${fco!.output}`);
  // And the not-preserved placeholder MUST NOT appear.
  assert(
    !input.some(i => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes('Prior search results were not preserved')),
    'shim emitted the not-preserved placeholder despite a stored private payload',
  );
});

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const completedEvent: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'request-id': 'req_resp_xyz',
  });
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent]),
    modelKey: 'test-model-key',
    headers: upstreamHeaders,
  }));
  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(API_KEY_ID, true);
  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(store),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('request-id'), 'req_resp_xyz');
  await collectEvents(result.events);
});
