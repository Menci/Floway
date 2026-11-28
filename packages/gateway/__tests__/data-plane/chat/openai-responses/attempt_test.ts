import { expect, test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from './test-policy.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { openaiResponsesAttempt } from '../../../../src/data-plane/chat/openai-responses/attempt.ts';
import { withOpenAIResponsesCompactShim } from '../../../../src/data-plane/chat/openai-responses/interceptors/compact-shim.ts';
import { openaiResponsesInterceptors } from '../../../../src/data-plane/chat/openai-responses/interceptors/index.ts';
import type { OpenAIResponsesInterceptor } from '../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { createOpenAIResponsesHttpStore } from '../../../../src/data-plane/chat/openai-responses/items/store.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { encodeBase64UrlJson } from '../../../../src/shared/base64url-json.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { acceptedAffinityEvaluation } from '../shared/affinity/helpers.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesPayloadEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type UpstreamModel, type UpstreamOpenAIResponsesResult, type UpstreamStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions, type FlagId } from '@floway-dev/upstream';

const API_KEY_ID = 'key_attempt_test';

const makeGatewayCtx = (store?: ChatGatewayCtx['store']) =>
  mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true, ...(store ? { store } : {}) });

const makePayload = (overrides: Partial<CanonicalOpenAIResponsesPayload> = {}): CanonicalOpenAIResponsesPayload => ({
  model: 'test-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...overrides,
});

const makeOpenAIResponsesResult = (id = 'resp_test'): OpenAIResponsesResultEx => ({
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
  error: null,
  incomplete_details: null,
});

const makeProviderEvents = async function* (events: readonly OpenAIResponsesStreamEventEx[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (
  callOpenAIResponses: (model: UpstreamModel, body: Omit<CanonicalOpenAIResponsesPayload, 'model'>, action: OpenAIResponsesAction, signal: AbortSignal | undefined, opts: UpstreamCallOptions) => Promise<UpstreamOpenAIResponsesResult>,
  enabledFlags: ReadonlySet<FlagId> = new Set<FlagId>(),
): ModelCandidate => {
  const instance = stubUpstream({ callOpenAIResponses });
  const upstream = 'up_test';
  return {
    upstream: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      instance,
    },
    model: stubUpstreamModel({ enabledFlags }),
    fetcher: directFetcher,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>): Promise<OpenAIResponsesStreamEventEx[]> => {
  const out: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

const installRepo = () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: API_KEY_ID, userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, randomizeUpstreams: false, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  return repo;
};

test('generate isolates provider mutations with JSON-safe container cloning', async () => {
  installRepo();
  const metadata = JSON.parse('{"__proto__":{"retained":true},"nested":{"value":"source"}}') as Record<string, unknown>;
  const payload = makePayload({ metadata: metadata as unknown as Record<string, string> });
  const sourceItem = payload.input[0];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<UpstreamOpenAIResponsesResult> => {
    const clonedMetadata = body.metadata as { nested: { value: string } } & Record<string, unknown>;
    assert(Object.hasOwn(clonedMetadata, '__proto__'), 'clone lost the own __proto__ JSON field');
    clonedMetadata.nested.value = 'provider';
    (body.input[0] as { role: string }).role = 'assistant';
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([]),
      modelKey: 'test-model-key',
    };
  });

  await openaiResponsesAttempt.generate({
    payload,
    ctx: makeGatewayCtx(),
    candidate: makeCandidate(callOpenAIResponses),
    headers: new Headers(),
  });

  assertEquals((payload.metadata as unknown as { nested: { value: string } }).nested.value, 'source');
  assertEquals((sourceItem as { role: string }).role, 'user');
});

test('generate sends an explicit null namespace for unresolved calls to previously declared namespace tools when flagged', async () => {
  installRepo();
  const tool = (name: string) => ({ type: 'function' as const, name });
  const customTool = (name: string) => ({ type: 'custom' as const, name });
  const namespace = (name: string, ...members: string[]) => ({ type: 'namespace' as const, name, description: name, tools: members.map(tool) });
  const call = (name: string) => ({ type: 'function_call' as const, name, call_id: `call_${name}`, arguments: '{}', status: 'completed' as const });
  const customCall = { type: 'custom_tool_call' as const, name: 'echo_text', call_id: 'call_custom_echo_text', input: 'sample' };
  const functionCallForCustom = call(customCall.name);
  const additionalTools = {
    type: 'additional_tools' as const,
    role: 'developer' as const,
    tools: [
      namespace('first', 'unique', 'ambiguous', 'before_declaration', 'flat_at_top', 'flat_custom_at_top', 'flat_in_history', 'qualified'),
      namespace('second', 'ambiguous'),
      { type: 'namespace' as const, name: 'custom_group', description: 'Custom tools', tools: [customTool(customCall.name)] },
      tool('flat_in_history'),
    ],
  };
  const searchOutput = { type: 'tool_search_output' as const, tools: [namespace('discovered', 'from_search')] };
  const unique = call('unique');
  const ambiguous = call('ambiguous');
  const fromSearch = call('from_search');
  const failedResult = { type: 'function_call_output' as const, call_id: unique.call_id, output: 'unsupported call: unique' };
  const payload = makePayload({
    tools: [tool('flat_at_top'), customTool('flat_custom_at_top'), namespace('top_level', 'top_level_only')],
    input: [
      call('before_declaration'), additionalTools, unique, failedResult, ambiguous, searchOutput, fromSearch,
      call('unknown'), call('top_level_only'), call('flat_at_top'), call('flat_custom_at_top'), call('flat_in_history'),
      customCall, functionCallForCustom,
      { ...call('qualified'), namespace: 'first' },
    ],
  });
  const providerCall = vi.fn(async (_model: UpstreamModel, _body: Omit<CanonicalOpenAIResponsesPayload, 'model'>): Promise<UpstreamOpenAIResponsesResult> => ({
    action: 'generate', ok: true, events: makeProviderEvents([]), modelKey: 'test-model-key',
  }));

  const flagged = makeCandidate(providerCall, new Set(['openai-responses-null-unresolved-function-call-namespace']));
  await openaiResponsesAttempt.generate({ payload, ctx: makeGatewayCtx(), candidate: flagged, headers: new Headers() });
  await openaiResponsesAttempt.generate({ payload, ctx: makeGatewayCtx(), candidate: makeCandidate(providerCall), headers: new Headers() });

  assertEquals(providerCall.mock.calls.length, 2);
  assertEquals(providerCall.mock.calls[1][1].input, payload.input);
  assertEquals(providerCall.mock.calls[0][1].input, [
    call('before_declaration'), additionalTools, { ...unique, namespace: null }, failedResult,
    { ...ambiguous, namespace: null }, searchOutput, { ...fromSearch, namespace: null },
    call('unknown'), call('top_level_only'), call('flat_at_top'), call('flat_custom_at_top'), call('flat_in_history'),
    customCall, { ...functionCallForCustom, namespace: null },
    { ...call('qualified'), namespace: 'first' },
  ]);
  assert(!Object.hasOwn(unique, 'namespace'));
});

test('generate treats a translated OpenAI Responses payload as opaque to native affinity and state', async () => {
  installRepo();
  let observedBody: Omit<CanonicalOpenAIResponsesPayload, 'model'> | undefined;
  const callOpenAIResponses = vi.fn(async (
    _model: UpstreamModel,
    body: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
  ): Promise<UpstreamOpenAIResponsesResult> => {
    observedBody = body;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([{
        type: 'response.completed',
        sequence_number: 0,
        response: makeOpenAIResponsesResult(),
      }]),
      modelKey: 'test-model-key',
      http: { status: 200, headers: new Headers() },
    };
  });
  const candidate = makeCandidate(callOpenAIResponses);
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true);
  const ctx = makeGatewayCtx(store);
  const carrier = await ctx.affinity.codec.wrap(
    undefined,
    {
      upstreamId: candidate.upstream.upstreamId,
      modelId: candidate.model.id,
      opaqueBlobCompatibilityIdentity: { upstreamId: candidate.upstream.upstreamId, key: candidate.model.id },
    },
    'openai-responses.reasoning.encrypted_content',
  );
  const unwrap = vi.spyOn(ctx.affinity.codec, 'unwrap');
  const getStoredItem = vi.spyOn(store, 'getItemById');
  const itemId = 'rs_source_edge';

  const result = await openaiResponsesAttempt.generate({
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

test('generate defers the role rewrite until after translation to OpenAI Chat Completions', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayloadEx, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (
    _model: UpstreamModel,
    body: Omit<OpenAIChatCompletionsPayloadEx, 'model'>,
  ): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedBody = body;
    return {
      ok: true,
      events: (async function* () {
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{  index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{  index: 0, delta: { content: 'hi' }, finish_reason: null }],
        });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({
          id: 'chatcmpl_test',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'test-model',
          choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
        });
        yield doneFrame();
      })(),
      modelKey: 'test-model-key',
      http: { status: 200, headers: new Headers() },
    };
  });
  const upstream = 'up_chat';
  const endpoints = { openaiChatCompletions: {} };
  const candidate: ModelCandidate = {
    upstream: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      instance: stubUpstream({ callOpenAIChatCompletions }),
    },
    model: stubUpstreamModel({
      endpoints,
      enabledFlags: new Set(['rewrite-system-to-developer']),
    }),
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [
        { type: 'message', role: 'system', content: 'base instructions' },
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
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

test('generate strips disallowed headers and states a remote image URL to Anthropic Messages', async () => {
  installRepo();
  initExternalResourceFetcher(() => {
    throw new Error('translation must not fetch images');
  });
  let observedHeaders: Headers | undefined;
  let observedAnthropicBeta: readonly string[] | undefined;
  let observedBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
  const upstreamModel = stubUpstreamModel({ endpoints: { anthropicMessages: {} } });
  const anthropicMessagesProvider = stubUpstream({
    callAnthropicMessages: async (_model, body, _signal, opts): Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>> => {
      observedHeaders = opts.headers;
      observedAnthropicBeta = (opts as AnthropicMessagesUpstreamCallOptions).anthropicBeta;
      observedBody = body as Omit<AnthropicMessagesPayload, 'model'>;
      return {
        ok: true,
        events: (async function* () {
          yield eventFrame<AnthropicMessagesStreamEventEx>({
            type: 'message_start',
            message: {
              container: null, diagnostics: null, stop_details: null,
              id: 'msg_1', type: 'message', role: 'assistant', content: [],
              model: 'test-model', stop_reason: null, stop_sequence: null,
              usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 1, output_tokens: 0 },
            },
          });
          yield eventFrame<AnthropicMessagesStreamEventEx>({ type: 'message_stop' });
          yield doneFrame();
        })(),
        modelKey: 'k',
        http: { status: 200, headers: new Headers() },
      };
    },
  });
  const candidate: ModelCandidate = {
    upstream: {
      upstreamId: 'up_test', kind: 'custom', name: 'up_test', inboundHeaderAllowlist: [],
      instance: anthropicMessagesProvider,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }],
      }],
    }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), true)),
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
  assertEquals(image.source, { type: 'url', url: 'https://example.com/image.png' });
});

test('generate restores signed hosted-tool replay data without stored state', async () => {
  installRepo();
  const storedId = `ws_${'a'.repeat(32)}`;
  const storedItem = {
    type: 'web_search_call' as const,
    id: storedId,
    status: 'completed' as const,
    action: { type: 'search' as const, query: 'deepseek v4', queries: ['deepseek v4'] },
  };
  const replay = {
    functionCall: {
      type: 'function_call' as const,
      call_id: 'call_orig_xyz',
      name: 'web_search',
      arguments: '{"search_query":[{"q":"deepseek v4"}]}',
      status: 'completed',
    },
    data: {
      action: { type: 'search', query: 'deepseek v4', queries: ['deepseek v4'] },
      results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'CACHED_SNIPPET_BODY' }],
    },
  };

  // Capture the upstream-bound body so we can verify what the shim produced
  // after the echoed wsc passed through transformItems.
  let capturedBody: { input?: unknown[] } | undefined;
  const upstreamResponse = makeOpenAIResponsesResult();
  // The shim's multi-turn loop requires `response.created` (carrying a model
  // name) before any synthesized terminal envelope. Emit the canonical
  // created → in_progress → completed sequence so the shim can wrap.
  const upstreamEvents: OpenAIResponsesStreamEventEx[] = [
    { type: 'response.created', sequence_number: 0, response: upstreamResponse },
    { type: 'response.in_progress', sequence_number: 1, response: upstreamResponse },
    { type: 'response.completed', sequence_number: 2, response: upstreamResponse },
  ];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<UpstreamOpenAIResponsesResult> => {
    capturedBody = body as { input?: unknown[] };
    return { action: 'generate', ok: true, events: makeProviderEvents(upstreamEvents), modelKey: 'test-model-key', http: { status: 200, headers: new Headers() } };
  });
  const candidate = makeCandidate(callOpenAIResponses, new Set(['openai-responses-web-search-shim']));

  const ctx = makeGatewayCtx();
  const carrier = await ctx.affinity.codec.wrap(
    await ctx.sidecarCodecFactory.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall).encode({ v: 1, type: storedItem.type, ...replay }),
    {
      upstreamId: candidate.upstream.upstreamId,
      modelId: candidate.model.id,
      opaqueBlobCompatibilityIdentity: { upstreamId: candidate.upstream.upstreamId, key: candidate.model.id },
    },
    'openai-responses.reasoning.encrypted_content',
  );

  const sourcePayload = makePayload({
    input: [
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'reasoning', id: 'rs_affinity', summary: [], encrypted_content: carrier },
      storedItem,
    ],
    tools: [{ type: 'web_search' }],
  });
  const affinity = await analyzeOpenAIResponsesAffinity(JSON.parse(JSON.stringify(sourcePayload)), ctx.affinity.codec);
  const result = await openaiResponsesAttempt.generate({
    payload: acceptedAffinityEvaluation(affinity, candidate).materialize(),
    ctx,
    candidate,
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);

  assert(capturedBody !== undefined, 'callOpenAIResponses was not invoked');
  const input = (capturedBody!.input ?? []) as Array<{ type: string; call_id?: string; output?: string; name?: string; arguments?: string }>;
  const fc = input.find(i => i.type === 'function_call' && i.call_id === 'call_orig_xyz');
  assert(fc !== undefined, 'expected replayed function_call with the persisted call_id');
  assertEquals(fc!.name, 'web_search');
  assertEquals(fc!.arguments, '{"search_query":[{"q":"deepseek v4"}]}');
  const fco = input.find(i => i.type === 'function_call_output' && i.call_id === 'call_orig_xyz');
  assert(fco !== undefined, 'expected replayed function_call_output');
  assert(fco!.output?.includes('CACHED_SNIPPET_BODY'), `expected cached body in function_call_output, got: ${fco!.output}`);
  assert(
    !input.some(i => i.type === 'function_call_output' && typeof i.output === 'string' && i.output.includes('Prior search results were not preserved')),
    'shim emitted the not-preserved placeholder despite authenticated replay data',
  );
});

test('namespace wire mapping follows compact expansion and is isolated from outer shims across repeated dispatches', async () => {
  installRepo();
  const namespace = { type: 'namespace' as const, name: 'files', description: '', tools: [{ type: 'function' as const, name: 'read', parameters: { type: 'object' } }] };
  const history = { type: 'function_call' as const, name: 'read', namespace: 'files', call_id: 'past', arguments: '{}', status: 'completed' as const };
  const payload = makePayload({
    tools: [{ type: 'function', name: 'files_read' }, namespace],
    input: [{ type: 'compaction', encrypted_content: encodeBase64UrlJson([history, { type: 'function_call_output', call_id: 'past', output: 'done' }]) }],
  });
  const original = structuredClone(payload);
  const providerBodies: Omit<OpenAIChatCompletionsPayloadEx, 'model'>[] = [];
  const endpoints = { openaiChatCompletions: {} };
  const candidate: ModelCandidate = {
    ...makeCandidate(async () => { throw new Error('native Responses must not be called'); }),
    model: stubUpstreamModel({ endpoints }),
  };
  candidate.upstream.instance.callOpenAIChatCompletions = async (_model, body) => {
    providerBodies.push(structuredClone(body));
    assert(JSON.stringify(body.messages).includes('files_read_2'), 'compact-expanded history must be mapped at dispatch');
    const tool = body.tools?.[1];
    assert(tool?.type === 'function' && tool.function.parameters !== undefined);
    tool.function.parameters.providerOnly = true;
    return {
      ok: true, modelKey: 'test-model-key', events: (async function* () {
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({ id: 'chat_isolation', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{  index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'next', type: 'function', function: { name: 'files_read_2', arguments: '{}' } }] }, finish_reason: null }] });
        yield eventFrame<OpenAIChatCompletionsStreamEvent>({ id: 'chat_isolation', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{  index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        yield doneFrame();
      })(),
    };
  };
  let observed = 0;
  const observer: OpenAIResponsesInterceptor = async (invocation, _ctx, run) => {
    assertEquals(invocation.payload.input[0], history, 'outer reader must observe expanded canonical history');
    const freeze = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return;
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    };
    freeze(invocation.payload);
    const first = await run();
    assertEquals(invocation.payload.tools?.[1], namespace, 'translation must leave outer declarations canonical');
    assertEquals(invocation.payload.input[0], history);
    assert(first.type === 'events');
    const events = await collectEvents(first.events);
    const done = events.find(event => event.type === 'response.output_item.done');
    assert(done?.type === 'response.output_item.done' && done.item.type === 'function_call');
    assertEquals([done.item.name, done.item.namespace], ['read', 'files']);
    observed++;
    return await run();
  };
  // Observe the real seam between compact expansion and the outer server-tool
  // loop. Dispatch twice like that loop does; both invocations must start from
  // Standard rather than the first call's ephemeral names.
  const chain = openaiResponsesInterceptors as OpenAIResponsesInterceptor[];
  const compactIndex = chain.indexOf(withOpenAIResponsesCompactShim);
  assert(compactIndex >= 0, 'expected the compaction interceptor in the dispatch chain');
  chain.splice(compactIndex + 1, 0, observer);
  try {
    const result = await openaiResponsesAttempt.generate({ payload, ctx: makeGatewayCtx(), candidate, headers: new Headers() });
    assert(result.type === 'events');
    await collectEvents(result.events);
    assertEquals(observed, 1);
    assertEquals(providerBodies.length, 2);
    assertEquals(providerBodies[0], providerBodies[1]);
    assertEquals(payload, original);
  } finally {
    chain.splice(chain.indexOf(observer), 1);
  }
});

const goalObjectiveInput: OpenAIResponsesPayloadEx['input'] = [
  { type: 'message', role: 'user', content: 'Write unit tests' },
  { type: 'function_call', call_id: 'call_goal', name: 'create_goal', arguments: '{"objective":"Write unit tests"}' },
  { type: 'function_call_output', call_id: 'call_goal', output: '{"goal":{"status":"active"}}' },
  { type: 'function_call_output', id: 'fco_goal', name: 'goal_objective', namespace: 'agent', output: 'Write unit tests' },
];

test('generate lowers a standalone function_call_output to external context across translation to OpenAI Chat Completions', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayloadEx, 'model'> | undefined;
  const endpoints = { openaiChatCompletions: {} };
  const candidate: ModelCandidate = {
    upstream: {
      upstreamId: 'up_chat', kind: 'custom', name: 'up_chat', inboundHeaderAllowlist: [],
      instance: stubUpstream({
        callOpenAIChatCompletions: async (_model, body): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>> => {
          observedBody = body;
          return {
            ok: true,
            events: (async function* () {
              yield eventFrame<OpenAIChatCompletionsStreamEvent>({ id: 'chatcmpl_goal', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }] });
              yield doneFrame();
            })(),
            modelKey: 'k',
            http: { status: 200, headers: new Headers() },
          };
        },
      }),
    },
    model: stubUpstreamModel({ endpoints }),
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({ input: goalObjectiveInput, tools: [{ type: 'function', name: 'create_goal', parameters: { type: 'object' } }] }),
    ctx: makeGatewayCtx(createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(API_KEY_ID), Date.now(), false)),
    candidate,
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.messages, [
    { role: 'user', content: 'Write unit tests' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_goal', type: 'function', function: { name: 'create_goal', arguments: '{"objective":"Write unit tests"}' } }] },
    { role: 'tool', tool_call_id: 'call_goal', content: '{"goal":{"status":"active"}}' },
    { role: 'user', content: '<external_goal_objective>Write unit tests</external_goal_objective>' },
  ]);
});

test('generate translates through GenerateContent, lowers agent_message, preserves rawJSON numbers, and pivots compact via the shim', async () => {
  installRepo();
  let capturedBody: GeminiGenerateContentPayload | undefined;
  let wireBody = '';
  const callGeminiGenerateContent = vi.fn(async (_model: unknown, body: GeminiGenerateContentPayload): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => {
    capturedBody = body;
    wireBody = JSON.stringify(body);
    return {
      ok: true,
      modelKey: 'k',
      http: { status: 200, headers: new Headers() },
      events: (async function* () {
        yield eventFrame<GeminiGenerateContentStreamEvent>({
          responseId: 'gem_resp_gw',
          modelVersion: 'test-model',
          candidates: [{
            index: 0,
            content: { role: 'model', parts: [{ thought: true, text: 'Gemini thought.' }, { text: 'Compacted summary.' }] },
            finishReason: 'STOP',
          }],
        });
        yield doneFrame();
      })(),
    };
  });
  const candidate: ModelCandidate = {
    upstream: {
      upstreamId: 'up_gemini', kind: 'custom', name: 'up_gemini', inboundHeaderAllowlist: [],
      instance: stubUpstream({ callGeminiGenerateContent }),
    },
    model: stubUpstreamModel({ endpoints: { geminiGenerateContent: {} } }),
    fetcher: directFetcher,
  };

  const result = await openaiResponsesAttempt.generate({
    payload: makePayload({
      instructions: 'Follow protocol.',
      reasoning: { effort: 'medium' },
      tools: [{ type: 'function', name: 'score', parameters: { type: 'object' } }],
      input: [
        { type: 'agent_message', author: 'lead', recipient: 'worker', content: [{ type: 'input_text', text: 'Subagent task prompt' }] },
        { type: 'message', role: 'user', content: 'Score it.' },
        { type: 'function_call', call_id: 'call_score', name: 'score', arguments: '{"threshold":1.0}' },
        { type: 'function_call_output', call_id: 'call_score', output: '{"score":12.50}' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate,
    headers: new Headers(),
  });
  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(wireBody).toContain('Subagent task prompt');
  expect(wireBody).toContain('"args":{"threshold":1.0}');
  expect(wireBody).toContain('"response":{"score":12.50}');
  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('unreachable');
  const assembled = await collectOpenAIResponsesProtocolEventsToResult(result.events);
  expect(assembled.output).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Gemini thought.' }] }),
    expect.objectContaining({ type: 'message', content: [expect.objectContaining({ type: 'output_text', text: 'Compacted summary.' })] }),
  ]));

  const compacted = await openaiResponsesAttempt.invoke({
    action: 'compact',
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'Summarize this conversation.' }] }),
    ctx: mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: false }),
    candidate,
    headers: new Headers(),
  });
  expect(compacted.type).toBe('result');
  if (compacted.type !== 'result') throw new Error('unreachable');
  expect(compacted.result.output).toEqual([
    expect.objectContaining({ type: 'compaction', encrypted_content: expect.any(String) }),
  ]);
});
