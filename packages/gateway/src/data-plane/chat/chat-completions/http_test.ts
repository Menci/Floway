import { type Context, Hono } from 'hono';
import { test, vi } from 'vitest';

import type { AuthVars } from '../../../middleware/auth.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ApiKey, User } from '../../../repo/types.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ProviderCandidate, directFetcher, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
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

const { chatCompletionsHttp } = await import('./http.ts');

const API_KEY_ID = 'key_chat_completions_http_test';

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

const makeApp = (middleware?: (c: Context) => void): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    middleware?.(c);
    await next();
  });
  app.post('/v1/chat/completions', chatCompletionsHttp.generate);
  return app;
};

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({ callChatCompletions: overrides.callChatCompletions });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, provider, supportsResponsesItemReference: true,
    },
    model: stubUpstreamModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}),
    fetcher: directFetcher,
  };
};

test('POST /v1/chat/completions streams a successful SSE body', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('chatcmpl_http'));
  assert(body.includes('[DONE]'));
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('POST /v1/chat/completions returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { choices: Array<{ message: { role: string; content: string } }> };
  assertEquals(body.choices[0].message.role, 'assistant');
  assertEquals(body.choices[0].message.content, 'hi');
});

test('POST /v1/chat/completions omits the usage-only chunk unless stream_options.include_usage is set', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  const body = await response.text();
  // The usage-only chunk has empty choices array; absence verifies the filter.
  assert(!body.includes('"choices":[]'));
});

test('POST /v1/chat/completions emits the usage-only chunk when stream_options.include_usage is true', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 200);
  const body = await response.text();
  assert(body.includes('"choices":[]'));
  assert(body.includes('"prompt_tokens":4'));
});

// The http entry MUST NOT mutate any non-auth Hono context slot — caller
// intent (stream_options.include_usage, etc.) belongs in the request-scoped
// locals the entry threads through serve, never in middleware-visible
// context-slot smuggling.
test('POST /v1/chat/completions does not write any non-auth Hono context slot', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callChatCompletions })]);

  const knownAuthKeys = new Set(['apiKey', 'user']);
  const observedKeys: string[] = [];

  const app = makeApp(c => {
    const originalSet = c.set.bind(c);
    c.set = ((key: string, value: unknown) => {
      observedKeys.push(key);
      return originalSet(key, value);
    }) as typeof c.set;
  });

  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 200);
  await response.text();

  const unexpectedKeys = observedKeys.filter(key => !knownAuthKeys.has(key));
  assertEquals(unexpectedKeys, []);
});

test('POST /v1/chat/completions renders the OpenAI-shaped model-unsupported 400 when no candidate matches the chat-completions picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `completions` —
  // the chatCompletionsTarget picker rejects it (its preference list is
  // `chat-completions` > `messages` > `responses`), leaving zero viable
  // candidates, and with sawModel=true the serve renders model-unsupported
  // as a 400.
  queueCandidates([makeCandidate({ endpoints: { completions: {} } })]);

  const response = await makeApp().request('/v1/chat/completions', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'wrong-endpoint-model', messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { error: { message: string; type: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assert(body.error.message.includes('does not support'));
});
