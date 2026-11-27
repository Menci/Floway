import { afterEach, test, vi } from 'vitest';

import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { type ModelCandidate, decodeResponseBody, directFetcher, type UpstreamCallResult, type UpstreamStreamResult, type UpstreamCallOptions } from '@floway-dev/upstream';

// Mock the resolver seam so each test hands the serve exactly the model
// candidates it wants, optionally with an alias-rules overlay attached.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
}
const resolutionsQueue: QueuedResolution[] = [];
const lastResolveCall: { model?: string } = {};
vi.mock('../../../../src/data-plane/upstreams/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/upstreams/resolution.ts')>();
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
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamCallResult>;
  callGeminiGenerateContent?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>>;
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
  const instance = stubUpstream({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
  });
  return {
    upstream: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      instance,
    },
    model: stubUpstreamModel({ endpoints }),
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
  assertEquals(upstreamError.http.status, 400);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 0);
});

test('alias resolution overlays rules onto the target IR at the wire call', async () => {
  installRepo();
  const capturedBodies: Record<string, unknown>[] = [];
  const callOpenAIChatCompletions = vi.fn(async (_model: unknown, body: unknown): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    capturedBodies.push(body as Record<string, unknown>);
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'gpt-5.4', http: { status: 200, headers: new Headers() } };
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
  const callGeminiGenerateContent = vi.fn(async (): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => ({
    ok: true,
    events: makeProtocolFrames([
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'native' }] }, finishReason: 'STOP' }] },
    ]),
    modelKey: 'k',
    http: { status: 200, headers: new Headers() },
  }));
  const callOpenAIChatCompletions = vi.fn(async (): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', http: { status: 200, headers: new Headers() },
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
  const callGeminiGenerateContent = vi.fn(async (_model, body): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => {
    observed = structuredClone(body as GeminiGenerateContentPayload);
    return {
      ok: true,
      events: makeProtocolFrames([
        { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
      ]),
      modelKey: 'k',
      http: { status: 200, headers: new Headers() },
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

test('generate normalizes terminal native failures after candidate exhaustion and fails over raw failures first', async () => {
  installRepo();
  const fail504 = async (): Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>> => ({
    ok: false,
    modelKey: 'k',
    http: new Response('<html>504 Gateway Timeout</html>', {
      status: 504,
      headers: new Headers({ 'content-type': 'text/html' }),
    }),
  });

  // Exhausted failure is normalized to Google RPC JSON with status 500.
  queueResolution([makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent: fail504 })]);
  const failed = await geminiGenerateContentServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });
  const apiError = expectType(failed, 'api-error');
  assertEquals(apiError.http.status, 500);
  assertEquals(JSON.parse(decodeResponseBody(apiError.body)), {
    error: { code: 500, message: '<html>504 Gateway Timeout</html>', status: 'INTERNAL' },
  });

  // Failover advances past raw failure to a healthy second candidate.
  queueResolution([
    makeCandidate({ upstream: 'up_1', endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent: fail504 }),
    makeCandidate({
      upstream: 'up_2',
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContent: async () => ({
        ok: true,
        events: makeProtocolFrames([{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }] }]),
        modelKey: 'k',
        http: { status: 200, headers: new Headers() },
      }),
    }),
  ]);
  const recovered = await geminiGenerateContentServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    model: 'test-model',
    headers: new Headers(),
  });
  const events = await collectEvents(expectType(recovered, 'events').events);
  assertEquals(events, [{ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'recovered' }] }, finishReason: 'STOP' }] }]);
});
