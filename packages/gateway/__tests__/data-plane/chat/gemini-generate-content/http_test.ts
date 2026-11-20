import { Hono } from 'hono';
import { test, vi } from 'vitest';

import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const candidatesQueue: { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { geminiGenerateContentHttp } = await import('../../../../src/data-plane/chat/gemini-generate-content/http.ts');

const API_KEY_ID = 'key_gemini_http_test';

const queueCandidates = (candidates: readonly ModelCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel, failedUpstreams: [] });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: API_KEY_ID,
  userId: 1,
  name: 'http_test',
  key: 'sk-http-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'http_test',
  passwordHash: null,
  isAdmin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

const makeApp = (): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  // Both prefix versions carry the same handler; the Gemini wire API defines
  // the action on the model segment under either one.
  for (const version of ['v1', 'v1beta']) app.post(`/${version}/models/:modelAction{.+}`, geminiGenerateContentHttp);
  return app;
};

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: 'openaiChatCompletions' | 'anthropicMessages' | 'openaiResponses';
  endpoints?: ModelEndpoints;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
  callGeminiGenerateContent?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>>;
  callGeminiGenerateContentCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'openaiChatCompletions';
  // When the test fixes `endpoints` directly, use it verbatim — that lets a
  // test pin a wrong-endpoint shape the picker rejects. Otherwise synthesize
  // a single-endpoint map from `targetApi` so the gemini serve layer's
  // picker (openai-chat-completions first, then messages, then responses) lands on
  // the requested wire.
  const endpoints = overrides.endpoints ?? (targetApi === 'openaiChatCompletions'
    ? { openaiChatCompletions: {} }
    : targetApi === 'anthropicMessages'
      ? { anthropicMessages: {} }
      : { openaiResponses: {} });
  const provider = stubProvider({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessages: overrides.callAnthropicMessages,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
    callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, pipelines: {}, instance: provider,
    },
    model: stubInternalModel({ endpoints }, upstream),
    fetcher: directFetcher,
  };
};

test.each(['generateContent', 'streamGenerateContent'])('POST %s maps a native Google RPC error before responding', async action => {
  installRepo();
  const body = { error: { code: 412, status: 'FAILED_PRECONDITION', message: 'account is not ready' } };
  const callGeminiGenerateContent = vi.fn(async (): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => ({
    ok: false,
    http: Response.json(body, { status: 400, headers: { 'request-id': 'req-google-rpc' } }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent })]);

  const response = await makeApp().request(`/v1beta/models/test-model:${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 412);
  assertEquals(response.headers.get('request-id'), 'req-google-rpc');
  assertEquals(await response.json(), body);
});

test('POST /v1beta/models/:model:countTokens preserves an upstream 204 without a body', async () => {
  installRepo();
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    http: new Response(null, { status: 204, headers: { 'request-id': 'req-no-count' } }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 204);
  assertEquals(response.headers.get('request-id'), 'req-no-count');
  assertEquals(response.body, null);
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  installRepo();
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    http: new Response(JSON.stringify({ total_tokens: 7 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 7 });
});

test('countTokens records the final translation input failure once', async () => {
  const upstreams = ['up_count_first', 'up_count_last'];
  const repo = installRepo();
  const recordFailure = vi.spyOn(repo.performance, 'recordZeroOutputError');
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => {
    throw new Error('Unsupported input must fail before the upstream call');
  });
  const candidates = upstreams.map(upstream => makeCandidate({ upstream, targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens }));
  queueCandidates(candidates);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }] }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { status: string } };
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assertEquals(callAnthropicMessagesCountTokens.mock.calls.length, 0);
  assertEquals(recordFailure.mock.calls.map(([sample]) => sample.upstream), [upstreams.at(-1)]);
  const rows = await repo.performance.listAll();
  assertEquals(rows.map(row => ({ requests: row.requests, errors: row.errorsNoOutput, neutral: row.neutral })), [
    { requests: 1, errors: 1, neutral: 0 },
  ]);
});

test('generateContent retries a translation input failure and records the successful candidate', async () => {
  const repo = installRepo();
  const recordSuccess = vi.spyOn(repo.performance, 'recordNeutral');
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>> => {
    throw new Error('Unsupported input must fail before the upstream call');
  });
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', http: { status: 200, headers: new Headers() },
  }));
  queueCandidates([
    makeCandidate({ upstream: 'up_messages', targetApi: 'anthropicMessages', callAnthropicMessages }),
    makeCandidate({ upstream: 'up_chat', targetApi: 'openaiChatCompletions', callOpenAIChatCompletions }),
  ]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }] }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as { candidates: unknown[] };
  assertEquals(body.candidates.length, 1);
  assertEquals(callAnthropicMessages.mock.calls.length, 0);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 1);
  assertEquals(recordSuccess.mock.calls.map(([sample]) => sample.upstream), ['up_chat']);
  const rows = await repo.performance.listAll();
  assertEquals(rows.map(row => ({ requests: row.requests, errors: row.errorsNoOutput, neutral: row.neutral })), [
    { requests: 1, errors: 0, neutral: 1 },
  ]);
});

test('POST /v1beta/models/models/:model:generateContent accepts the models/ prefix in the path id', async () => {
  installRepo();
  let resolvedModel: string | undefined;
  const callOpenAIChatCompletions = vi.fn(async (model): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    resolvedModel = (model as { id: string }).id;
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', http: { status: 200, headers: new Headers() } };
  });
  queueCandidates([makeCandidate({ callOpenAIChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  // The `models/` prefix is normalised away before reaching candidate enumeration.
  assertEquals(resolvedModel, stubInternalModel().id);
});

const makeNativeGeminiEvents = (): readonly GeminiGenerateContentStreamEvent[] => [
  { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }] },
  {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    modelVersion: 'gemini-3-flash',
  },
];

test('a native Gemini upstream is reached without translation and streams its own frames', async () => {
  installRepo();
  const callGeminiGenerateContent = vi.fn(async (): Promise<ProviderStreamResult<GeminiGenerateContentStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeNativeGeminiEvents()), modelKey: 'gemini-3-flash', http: { status: 200, headers: new Headers({ 'x-goog-request-id': 'r1' }) },
  }));
  queueCandidates([makeCandidate({ endpoints: { geminiGenerateContent: {} }, callGeminiGenerateContent })]);

  const response = await makeApp().request('/v1beta/models/test-model:streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  assertEquals(response.headers.get('x-goog-request-id'), 'r1');
  const text = await response.text();
  // Each upstream chunk is one `data:` event and the wire has no [DONE].
  assertEquals(text.includes(`data: ${JSON.stringify(makeNativeGeminiEvents()[0])}`), true);
  assertEquals(text.includes('"finishReason":"STOP"'), true);
  assertEquals(text.includes('[DONE]'), false);
});
