import { Hono } from 'hono';
import { test, vi } from 'vitest';

import type { AuthVars } from '../../../middleware/auth.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ApiKey, User } from '../../../repo/types.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ProviderCandidate, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

const candidatesQueue: { readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { geminiHttp } = await import('./http.ts');

const API_KEY_ID = 'key_gemini_http_test';

const queueCandidates = (candidates: readonly ProviderCandidate[], sawModel = candidates.length > 0): void => {
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
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'http_test',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  canViewGlobalTelemetry: false,
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
  app.post('/v1beta/models/:modelAction{.+}', geminiHttp);
  return app;
};

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: 'chat-completions' | 'messages' | 'responses';
  endpoints?: ModelEndpoints;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'chat-completions';
  // When the test fixes `endpoints` directly, use it verbatim — that lets a
  // test pin a wrong-endpoint shape the picker rejects. Otherwise synthesize
  // a single-endpoint map from `targetApi` so the gemini serve layer's
  // picker (chat-completions first, then messages, then responses) lands on
  // the requested wire.
  const endpoints = overrides.endpoints ?? (targetApi === 'chat-completions'
    ? { chatCompletions: {} }
    : targetApi === 'messages'
      ? { messages: {} }
      : { responses: {} });
  const provider = stubProvider({
    callChatCompletions: overrides.callChatCompletions,
    callMessages: overrides.callMessages,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, provider, supportsResponsesItemReference: true,
    },
    model: stubUpstreamModel({ endpoints }),
    fetcher: directFetcher,
  };
};

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_http_m', type: 'message', role: 'assistant', content: [],
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

test('POST /v1beta/models/:model:generateContent returns a single JSON body for non-stream generate', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:streamGenerateContent streams a Gemini SSE body', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const text = await response.text();
  assert(text.length > 0);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens returns the Gemini totalTokens envelope', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 23 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 23 });
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ total_tokens: 7 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessagesCountTokens })]);

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

test('POST /v1beta/models/:model:generateContent translates through Messages target end to end', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ targetApi: 'messages', callMessages })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:unknownAction returns a Google RPC 404 envelope', async () => {
  installRepo();
  // No candidates queued — the action parser short-circuits before routing.
  const response = await makeApp().request('/v1beta/models/test-model:unknownAction', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: '{}',
  });

  assertEquals(response.status, 404);
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 404);
  assertEquals(body.error.status, 'NOT_FOUND');
  assert(body.error.message.includes('Unknown Gemini model action'));
});

test('POST /v1beta/models/models/:model:generateContent accepts the models/ prefix in the path id', async () => {
  installRepo();
  let resolvedModel: string | undefined;
  const callChatCompletions = vi.fn(async (model): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => {
    resolvedModel = (model as { id: string }).id;
    return { ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers() };
  });
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  // The `models/` prefix is normalised away before reaching candidate enumeration.
  assertEquals(resolvedModel, stubUpstreamModel().id);
});

test('POST /v1beta/models/:model:generateContent renders the Gemini-shaped model-unsupported 400 when no candidate matches the gemini-generate picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `completions` —
  // geminiGenerateTarget (chat-completions > messages > responses) rejects
  // it, leaving zero viable candidates, and with sawModel=true the serve
  // renders model-unsupported as a 400.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { completions: {} } })]);

  const response = await makeApp().request('/v1beta/models/wrong-endpoint-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 400);
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assert(body.error.message.includes('does not support'));
});
