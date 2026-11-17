import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
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
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
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

const { geminiGenerateContentServe } = await import('../../../../src/data-plane/chat/gemini-generate-content/serve.ts');

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

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeOpenAIChatCompletionsEvents = (text = 'hi'): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: { content: text }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: 'openaiChatCompletions' | 'anthropicMessages' | 'openaiResponses';
  endpoints?: ModelEndpoints;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
  callGeminiGenerateContent?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'openaiChatCompletions';
  // The gemini serve layer picks the target from model.endpoints (openai-chat-completions
  // first, then messages, then responses). Narrow endpoints to the target this
  // test wants so the gemini serve layer picks the expected target via
  // geminiGenerateContentGenerateTarget.canServe. An explicit `endpoints` override beats the
  // default `targetApi`-derived map, for tests that need a candidate whose
  // endpoints satisfy none of the target preferences.
  const endpoints = overrides.endpoints ?? (targetApi === 'openaiChatCompletions'
    ? { openaiChatCompletions: {} }
    : targetApi === 'anthropicMessages'
      ? { anthropicMessages: {} }
      : { openaiResponses: {} });
  const provider = stubProvider({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
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

test('generate falls through to the next candidate when the first yields an upstream error', async () => {
  installRepo();
  const payload = makePayload({
    contents: [{
      role: 'user',
      parts: [{ text: 'hello', thought: true, thoughtSignature: 'opaque-signature' }],
    }],
  });
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: new Headers({ 'content-type': 'application/json' }),
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'second-key', headers: new Headers(),
  }));
  queueResolution([
    makeCandidate({ upstream: 'up_a', targetApi: 'openaiChatCompletions', callOpenAIChatCompletions: firstCall }),
    makeCandidate({ upstream: 'up_b', targetApi: 'openaiChatCompletions', callOpenAIChatCompletions: secondCall }),
  ]);

  const result = await geminiGenerateContentServe.generate({
    payload,
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
  assertEquals(payload.contents?.[0]?.parts, [{
    text: 'hello',
    thought: true,
    thoughtSignature: 'opaque-signature',
  }]);
});

test('generate renders model-missing as a Google RPC 404 when no candidates are available', async () => {
  installRepo();
  queueResolution([]);

  const result = await geminiGenerateContentServe.generate({
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

test('generate filters out candidates whose endpoints do not satisfy the gemini-generate-content-generate preference and renders model-unsupported as a 400', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn();
  // geminiGenerateContentGenerateTarget prefers openai-chat-completions > messages > responses;
  // an endpoints-only `openaiCompletions` candidate matches none and is filtered.
  queueResolution([makeCandidate({ upstream: 'up_x', endpoints: { openaiCompletions: {} }, callOpenAIChatCompletions })]);

  const result = await geminiGenerateContentServe.generate({
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
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 0);
});

test('alias resolution overlays rules onto the target IR at the wire call', async () => {
  installRepo();
  const capturedBodies: Record<string, unknown>[] = [];
  const callOpenAIChatCompletions = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    capturedBodies.push(body as Record<string, unknown>);
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'gpt-5.4', headers: new Headers() };
  });
  queueResolution([makeCandidate({ targetApi: 'openaiChatCompletions', callOpenAIChatCompletions })], {
    aliasRules: { reasoning: { effort: 'high', budget_tokens: 1024 }, verbosity: 'low' },
  });

  const result = await geminiGenerateContentServe.generate({
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
  // Gemini generateContent→OpenAI Chat Completions traversal that is `reasoning_effort` and
  // `verbosity`. Rules that lack a native CC slot (budget_tokens) drop.
  const observed = capturedBodies[0]!;
  assertEquals(observed.reasoning_effort, 'high');
  assertEquals(observed.verbosity, 'low');
});

test('generate prefers a native Gemini candidate over a translated one', async () => {
  installRepo();
  const callGeminiGenerateContent = vi.fn(async (): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'native' }] }, finishReason: 'STOP' }] },
    ]),
    modelKey: 'k',
    headers: new Headers(),
  }));
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueResolution([
    makeCandidate({ endpoints: { geminiGenerateContent: {}, openaiChatCompletions: {} }, callGeminiGenerateContent, callOpenAIChatCompletions }),
  ]);

  const result = await geminiGenerateContentServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });

  const events = await collectEvents(expectType(result, 'events').events);
  assertEquals(events, [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'native' }] }, finishReason: 'STOP' }] },
  ]);
  assertEquals(callGeminiGenerateContent.mock.calls.length, 1);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 0);
});

test('a native candidate keeps a foreign signature verbatim', async () => {
  installRepo();
  let observed: GeminiGenerateContentPayload | undefined;
  const callGeminiGenerateContent = vi.fn(async (_model, body): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => {
    observed = structuredClone(body as GeminiGenerateContentPayload);
    return {
      ok: true,
      events: makeProtocolFrames([
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
      ]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });
  const payload = makePayload({
    contents: [
      { role: 'user', parts: [{ text: 'draw' }] },
      { role: 'model', parts: [{ text: 'done', thoughtSignature: 'client-owned-signature' }] },
    ],
  });
  queueResolution([makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent })]);

  const result = await geminiGenerateContentServe.generate({
    payload,
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });
  await collectEvents(expectType(result, 'events').events);

  // Affinity selection runs for native candidates too. A signature the gateway
  // never minted belongs to the client's upstream, so it is carried through
  // unchanged instead of being stripped or re-wrapped.
  assertEquals(observed, payload);
  assertEquals(observed?.contents[1].parts?.[0].thoughtSignature, 'client-owned-signature');
});
