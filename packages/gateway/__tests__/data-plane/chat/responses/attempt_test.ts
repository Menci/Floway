import { test, vi } from 'vitest';

import { TEST_RESPONSES_RETENTION_SECONDS, testResponsesStatePolicy } from './test-policy.ts';
import { analyzeResponsesAffinity } from '../../../../src/data-plane/chat/responses/affinity/ingress.ts';
import { responsesAttempt } from '../../../../src/data-plane/chat/responses/attempt.ts';
import { hydrateResponsesPayload } from '../../../../src/data-plane/chat/responses/items/hydrate.ts';
import * as outputModule from '../../../../src/data-plane/chat/responses/items/output.ts';
import { createResponsesHttpStore } from '../../../../src/data-plane/chat/responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { StoredResponsesItem } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { acceptedAffinityEvaluation } from '../shared/affinity/helpers.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { CanonicalResponsesPayload, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type MessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderModel, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, ...(store ? { store } : {}) });

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
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
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
  callResponses: (model: ProviderModel, body: Omit<CanonicalResponsesPayload, 'model'>, action: ResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<ProviderResponsesResult>,
  enabledFlags: ReadonlySet<FlagId> = new Set<FlagId>(),
): ModelCandidate => {
  const provider = stubProvider({ callResponses });
  const upstream = 'up_test';
  return {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: provider,
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
  void repo.apiKeys.save({
    id: API_KEY_ID, userId: 1, name: 'Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    responsesRetentionSeconds: TEST_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

const insertStoredItem = async (repo: InMemoryRepo, overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id'> & { type: string }): Promise<StoredResponsesItem> => {
  const { type, ...itemOverrides } = overrides;
  const row: StoredResponsesItem = {
    apiKeyId: API_KEY_ID,
    itemHash: `hash-${overrides.id}`,
    payload: { item: { type, id: overrides.id } },
    refreshedAt: Date.now(),
    ...itemOverrides,
  };
  await repo.responsesItems.insertMany([row], 0);
  return row;
};

test('generate native success leaves source-edge state ownership to the caller', async () => {
  installRepo();

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
  const store = createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);

  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');

  const events = await collectEvents(result.events);
  assert(events.length >= 1, 'expected at least the response.completed event');

  assertEquals(callResponses.mock.calls.length, 1);
});

test('generate treats a translated Responses payload as opaque to native affinity and state', async () => {
  installRepo();
  let observedBody: Omit<CanonicalResponsesPayload, 'model'> | undefined;
  const callResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<CanonicalResponsesPayload, 'model'>,
  ): Promise<ProviderResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'responses.reasoning.encrypted_content',
  );
  const unwrap = vi.spyOn(ctx.affinity.codec, 'unwrap');
  const getStoredItem = vi.spyOn(store, 'getItemById');
  const itemId = 'rs_source_edge';

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }],
    }),
    ctx,
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(unwrap.mock.calls.length, 0);
  assertEquals(getStoredItem.mock.calls.length, 0);
  assertEquals(observedBody?.input, [{ type: 'reasoning', id: itemId, summary: [], encrypted_content: carrier }]);
});

test('generate applies role compatibility flags in target-chain order', async () => {
  installRepo();
  let observedBody: Omit<ResponsesPayload, 'model'> | undefined;
  const callResponses = vi.fn(async (
    _model: ProviderModel,
    body: Omit<ResponsesPayload, 'model'>,
  ): Promise<ProviderResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate(callResponses, new Set([
    'rewrite-developer-to-system',
    'rewrite-mid-conv-system-to-user',
    'rewrite-system-to-developer',
  ]));

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.input, [
    { type: 'message', role: 'system', content: 'base instructions' },
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'message', role: 'user', content: 'inline instructions' },
  ]);
});

test('generate defers the role rewrite until after translation to Chat Completions', async () => {
  installRepo();
  let observedBody: Omit<ChatCompletionsPayload, 'model'> | undefined;
  const callChatCompletions = vi.fn(async (
    _model: ProviderModel,
    body: Omit<ChatCompletionsPayload, 'model'>,
  ): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    observedBody = body;
    return {
      ok: true,
      events: (async function* () {
        yield eventFrame<ChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        yield eventFrame<ChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        yield eventFrame<ChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        });
        yield doneFrame();
      })(),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const upstream = 'up_chat';
  const endpoints = { chatCompletions: {} };
  const candidate: ModelCandidate = {
    provider: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
      instance: stubProvider({ callChatCompletions }),
    },
    model: stubInternalModel({
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({
          endpoints,
          enabledFlags: new Set(['rewrite-system-to-developer']),
        }),
      },
    }, upstream),
    fetcher: directFetcher,
  };

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.messages, [
    { role: 'developer', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'inline instructions' },
  ]);
});

test('generate passes non-events provider result through unchanged', async () => {
  installRepo();
  const wrapSpy = vi.spyOn(outputModule, 'wrapResponsesClientOutput');

  const upstreamResponse = new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 502, headers: new Headers({ 'content-type': 'application/json' }) });
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: false,
    response: upstreamResponse,
    modelKey: 'test-model-key',
  }));

  const candidate = makeCandidate(callResponses);
  const result = await responsesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
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

test('compact returns the clean upstream result for source-edge affinity and storage', async () => {
  installRepo();

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

  const callResponses = vi.fn(async (_model: ProviderModel, _body: Omit<CanonicalResponsesPayload, 'model'>, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`compact candidate received action='${action}'`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });

  const candidate = makeCandidate(callResponses);
  const store = createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true);
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
  assertEquals(result.result.id, compactionResult.id);
});

test('generate strips disallowed headers and injects external image loading across translation to Messages', async () => {
  installRepo();
  initExternalResourceFetcher(url => {
    assertEquals(url.href, 'https://example.com/image.png');
    return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }));
  });
  let observedHeaders: Headers | undefined;
  let observedAnthropicBeta: readonly string[] | undefined;
  let observedBody: Omit<MessagesPayload, 'model'> | undefined;
  const upstreamModel = stubInternalModel({ endpoints: { messages: {} } }, 'up_test');
  const messagesProvider = stubProvider({
    callMessages: async (_model, body, _signal, opts): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
      observedHeaders = opts.headers;
      observedAnthropicBeta = (opts as MessagesUpstreamCallOptions).anthropicBeta;
      observedBody = body as Omit<MessagesPayload, 'model'>;
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
      upstreamId: 'up_test', kind: 'custom', name: 'up_test', inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: messagesProvider,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };

  const result = await responsesAttempt.generate({
    payload: makePayload({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }],
      }],
    }),
    ctx: makeGatewayCtx(createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
    candidate,
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols', 'x-test': 'abc' }),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedHeaders?.get('x-test'), null);
  assertEquals(observedHeaders?.get('anthropic-beta'), null);
  assertEquals(observedAnthropicBeta, []);
  const message = observedBody?.messages[0];
  assert(message?.role === 'user' && Array.isArray(message.content));
  const image = message.content.find(block => block.type === 'image');
  assert(image?.type === 'image');
  assertEquals(image.source, { type: 'base64', media_type: 'image/png', data: 'AQID' });
});

test('generate seeds privatePayload before interceptors so the web-search shim replays the prior wsc results on echo', async () => {
  // End-to-end contract: when a stateless client (e.g. Codex CLI) echoes a
  // prior gateway-created web_search_call by its emitted id, the web-search shim's
  // `transformItems` (which runs as part of the interceptor chain) must
  // find the persisted `payload.private` and emit the cached function_call
  // + function_call_output pair to upstream — NOT the not-preserved
  // placeholder.
  //
  // The wire shape we model here:
  //   - row.id = the public item id echoed as `wsc.id`.
  //   - payload.item.id = that same public id.
  //   - payload.private = WebSearchCallPrivatePayload (v:1, functionCallItem, ir).
  //
  // This regression caught a prior ordering bug where hydration + beginAttempt
  // ran inside the interceptor closure, after the shim's input transform —
  // so privatePayload was always empty when the shim looked it up, and
  // every echoed wsc collapsed to the placeholder.
  const repo = installRepo();
  const storedId = `ws_${'a'.repeat(32)}`;
  const storedItem = {
    type: 'web_search_call' as const,
    id: storedId,
    status: 'completed' as const,
    action: { type: 'search' as const, query: 'deepseek v4', queries: ['deepseek v4'] },
  };
  await insertStoredItem(repo, {
    id: storedId,
    type: 'web_search_call',
    payload: {
      item: storedItem,
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

  const store = createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  await store.loadInputItems([{ type: 'web_search_call', id: storedId }], []);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.provider.upstreamId,
      modelId: candidate.model.id,
    },
    'responses.reasoning.encrypted_content',
    { syntheticItem: true },
  );

  const sourcePayload = makePayload({
    input: [
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'reasoning', id: 'rs_affinity', summary: [], encrypted_content: carrier },
      {
        type: 'web_search_call',
        id: storedId,
        status: 'completed',
        action: { type: 'search', queries: ['deepseek v4'] },
      } as unknown as never,
    ],
    tools: [{ type: 'web_search' }],
  });
  await store.loadInputItems(sourcePayload.input, sourcePayload.input);
  const hydrated = hydrateResponsesPayload(sourcePayload, store);
  const affinity = await analyzeResponsesAffinity(hydrated.payload, ctx.affinity.codec);
  const result = await responsesAttempt.generate({
    payload: acceptedAffinityEvaluation(affinity, candidate).materialize(),
    sourceState: {
      privatePayloads: hydrated.privatePayloads,
    },
    ctx,
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
  const store = createResponsesHttpStore(testResponsesStatePolicy(API_KEY_ID), Date.now(), true);
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
