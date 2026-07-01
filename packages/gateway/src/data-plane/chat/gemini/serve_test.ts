import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the serve exactly the model
// candidates it wants, optionally with an alias-rules overlay attached.
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

const { geminiServe } = await import('./serve.ts');

const API_KEY_ID = 'key_gemini_serve_test';

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

const makeGatewayCtx = (): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  responseHeaders: new Headers(),
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(API_KEY_ID),
});

const makePayload = (overrides: Partial<GeminiPayload> = {}): GeminiPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeChatCompletionsEvents = (text = 'hi'): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeMessagesEvents = (id = 'msg_1'): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', content: [],
      model: 'test-model', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

const makeResponsesResultEvent = (id = 'resp_test'): ResponsesStreamEvent => {
  const response: ResponsesResult = {
    id, object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi from responses' }],
    }],
    output_text: 'hi from responses', error: null, incomplete_details: null,
  };
  return { type: 'response.completed', sequence_number: 0, response };
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: 'chat-completions' | 'messages' | 'responses';
  endpoints?: ModelEndpoints;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'chat-completions';
  // The gemini serve layer picks the target from model.endpoints (chat-completions
  // first, then messages, then responses). Narrow endpoints to the target this
  // test wants so the gemini serve layer picks the expected target via
  // geminiGenerateTarget.canServe. An explicit `endpoints` override beats the
  // default `targetApi`-derived map, for tests that need a candidate whose
  // endpoints satisfy none of the target preferences.
  const endpoints = overrides.endpoints ?? (targetApi === 'chat-completions'
    ? { chatCompletions: {} }
    : targetApi === 'messages'
      ? { messages: {} }
      : { responses: {} });
  const provider = stubProvider({
    callChatCompletions: overrides.callChatCompletions,
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, kind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, instance: provider, supportsResponsesItemReference: true,
    },
    model: stubInternalModel({ endpoints }, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async <TEvent>(events: AsyncIterable<ProtocolFrame<TEvent>>): Promise<TEvent[]> => {
  const out: TEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

const expectType = <T extends { type: string }, K extends T['type']>(r: T, k: K): Extract<T, { type: K }> => {
  assertEquals(r.type, k);
  return r as Extract<T, { type: K }>;
};

test('generate translates through native Chat Completions target end to end', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueResolution([makeCandidate({ targetApi: 'chat-completions', callChatCompletions })]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const events = expectType(result, 'events').events;
  await collectEvents(events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate translates through Messages when only that endpoint is exposed', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueResolution([makeCandidate({ targetApi: 'messages', callMessages })]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const events = expectType(result, 'events').events;
  await collectEvents(events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate translates through Responses when only that endpoint is exposed', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true, events: makeProtocolFrames([makeResponsesResultEvent()]), modelKey: 'k', headers: new Headers(),
  }));
  queueResolution([makeCandidate({ targetApi: 'responses', callResponses })]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const events = expectType(result, 'events').events;
  await collectEvents(events);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'second-key', headers: new Headers(),
  }));
  queueResolution([
    makeCandidate({ upstream: 'up_a', targetApi: 'chat-completions', callChatCompletions: firstCall }),
    makeCandidate({ upstream: 'up_b', targetApi: 'chat-completions', callChatCompletions: secondCall }),
  ]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  // The narrowed candidate list exists exactly so a transient upstream
  // failure (5xx/429/network) on one entry rolls over to the next. The
  // second candidate's success is the request's final answer.
  expectType(result, 'events');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 1);
});

test('generate is a routing no-op for a bare user-text request (degenerate path)', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueResolution([
    makeCandidate({ upstream: 'up_a', targetApi: 'chat-completions', callChatCompletions }),
    makeCandidate({ upstream: 'up_b', targetApi: 'chat-completions', callChatCompletions }),
  ]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const events = expectType(result, 'events').events;
  await collectEvents(events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate renders model-missing as a Google RPC 404 when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'unknown-model',
    headers: new Headers(),
  });

  const upstreamError = expectType(result, 'api-error');
  assertEquals(upstreamError.status, 404);
  const body = JSON.parse(new TextDecoder().decode(upstreamError.body));
  assertEquals(body.error.code, 404);
  assertEquals(body.error.status, 'NOT_FOUND');
  assert(typeof body.error.message === 'string' && body.error.message.includes('unknown-model'));
});

test('generate filters out candidates whose endpoints do not satisfy the gemini-generate preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callChatCompletions = vi.fn();
  // geminiGenerateTarget prefers chat-completions > messages > responses;
  // an endpoints-only `completions` candidate matches none and is filtered.
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} }, callChatCompletions })]);

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'wrong-endpoint-model',
    headers: new Headers(),
  });

  const upstreamError = expectType(result, 'api-error');
  assertEquals(upstreamError.status, 400);
  const body = JSON.parse(new TextDecoder().decode(upstreamError.body));
  assertEquals(body.error.code, 400);
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  // Defense-in-depth: even though `pick` would also throw on this candidate's
  // endpoints, the spy pins that the filter happens BEFORE pick is reached,
  // not after a fallback. Sibling tests in messages/responses/chat-completions
  // serve_test.ts mirror this assertion for the same reason.
  assertEquals(callChatCompletions.mock.calls.length, 0);
});

test('countTokens translates Gemini to Messages count_tokens and returns the Gemini envelope', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 17 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueResolution([makeCandidate({ targetApi: 'messages', callMessagesCountTokens })]);

  const result = await geminiServe.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const plain = expectType(result, 'plain');
  assertEquals(plain.status, 200);
  const body = JSON.parse(new TextDecoder().decode(plain.body));
  assertEquals(body, { totalTokens: 17 });
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

test('countTokens renders a Google RPC NOT_FOUND when no Messages-capable candidate exists', async () => {
  installRepo();
  queueResolution([]);

  const result = await geminiServe.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'no-messages-model',
    headers: new Headers(),
  });

  const upstreamError = expectType(result, 'api-error');
  assertEquals(upstreamError.status, 404);
  const body = JSON.parse(new TextDecoder().decode(upstreamError.body));
  assertEquals(body.error.code, 404);
  assertEquals(body.error.status, 'NOT_FOUND');
  assert(typeof body.error.message === 'string' && body.error.message.includes('no-messages-model is not'));
});

test('countTokens filters out candidates whose endpoints do not satisfy the gemini-countTokens preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn();
  // geminiCountTokensTarget = chatTargetPicker(['messages']); a candidate
  // exposing only chatCompletions matches none and is filtered out.
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { chatCompletions: {} }, callMessagesCountTokens })]);

  const result = await geminiServe.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'wrong-endpoint-model',
    headers: new Headers(),
  });

  const upstreamError = expectType(result, 'api-error');
  assertEquals(upstreamError.status, 400);
  const body = JSON.parse(new TextDecoder().decode(upstreamError.body));
  assertEquals(body.error.code, 400);
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assert(typeof body.error.message === 'string' && body.error.message.includes('does not support'));
  assertEquals(callMessagesCountTokens.mock.calls.length, 0);
});

test('alias resolution overlays rules onto the target IR at the wire call', async () => {
  installRepo();
  const capturedBodies: Record<string, unknown>[] = [];
  const callChatCompletions = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    capturedBodies.push(body as Record<string, unknown>);
    return { ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'gpt-5.4', headers: new Headers() };
  });
  queueResolution([makeCandidate({ targetApi: 'chat-completions', callChatCompletions })], {
    aliasRules: { reasoning: { effort: 'high', budget_tokens: 1024 }, verbosity: 'low' },
  });

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'gemini-fast',
    headers: new Headers(),
  });
  await collectEvents(expectType(result, 'events').events);

  // The resolver sees the inbound alias id verbatim. Target-id walking
  // happens inside the resolver.
  assertEquals(lastResolveCall.model, 'gemini-fast');
  // Alias rules land on the terminal wire target's native slots — for a
  // Gemini→ChatCompletions traversal that is `reasoning_effort` and
  // `verbosity`. Rules that lack a native CC slot (budget_tokens) drop.
  const observed = capturedBodies[0]!;
  assertEquals(observed.reasoning_effort, 'high');
  assertEquals(observed.verbosity, 'low');
});

test('alias whose targets have no kind-matching binding surfaces as the regular model-missing 404', async () => {
  installRepo();
  queueResolution([], { sawModel: false });

  const result = await geminiServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'gemini-fast',
    headers: new Headers(),
  });

  assertEquals(result.type, 'api-error');
  if (result.type !== 'api-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.message, 'Model gemini-fast is not available on any configured upstream.');
});
