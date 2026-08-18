import { Hono } from 'hono';
import { test, vi } from 'vitest';

import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

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

const { anthropicMessagesHttp } = await import('../../../../src/data-plane/chat/anthropic-messages/http.ts');

const API_KEY_ID = 'key_messages_http_test';

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
  upstreamIds: null,
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
  app.post('/v1/messages', anthropicMessagesHttp.generate);
  app.post('/v1/messages/count_tokens', anthropicMessagesHttp.countTokens);
  return app;
};

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_http',
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
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callAnthropicMessages: overrides.callAnthropicMessages,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
    },
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

test('POST /v1/messages streams a successful SSE body', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callAnthropicMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('event: message_start'));
  assert(body.includes('event: message_stop'));
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
});

test('POST /v1/messages returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callAnthropicMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { role: string; content: unknown };
  assertEquals(body.role, 'assistant');
});

test('POST /v1/messages answers the Claude Code model-validation probe without calling the upstream', async () => {
  const repo = installRepo();
  const callAnthropicMessages = vi.fn((): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    throw new Error('the probe reached the upstream');
  });
  queueCandidates([makeCandidate({ callAnthropicMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.226 (external, cli)' }),
    body: JSON.stringify({
      model: 'test-model',
      max_tokens: 1,
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
      metadata: { user_id: 'user_0_account__session_0' },
    }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as { model: string; stop_reason: string; usage: { input_tokens: number; output_tokens: number } };
  assertEquals(body.model, 'test-model');
  assertEquals(body.stop_reason, 'max_tokens');
  assertEquals(body.usage.input_tokens, 0);
  assertEquals(body.usage.output_tokens, 0);
  assertEquals(callAnthropicMessages.mock.calls.length, 0);

  // The turn is recorded as served, at zero cost, and contributes no latency
  // sample — there was no upstream call to measure.
  await flushBackground();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.requests, 1);
  assertEquals(usage[0]?.metrics, []);
  assertEquals(await repo.performance.listAll(), []);
});

test('POST /v1/messages rejects body anthropic_beta with a 400 before routing', async () => {
  installRepo();
  // No candidates queued — the http entry rejects before reaching the serve.
  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      max_tokens: 32,
      anthropic_beta: ['something'],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { param: string; type: string } };
  assertEquals(body.error.param, 'anthropic_beta');
  assertEquals(body.error.type, 'invalid_request_error');
});

test('POST /v1/messages/count_tokens proxies the upstream measurement body', async () => {
  const repo = installRepo();
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 99 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1/messages/count_tokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as { input_tokens: number };
  assertEquals(body.input_tokens, 99);
  assertEquals(callAnthropicMessagesCountTokens.mock.calls.length, 1);

  // A measurement goes through settlement like every other run. It names no billed entity —
  // nothing here is billable today — but the row is written, because "count_tokens is exempt
  // from billing" would hard-code today's commercial arrangement into the architecture. An
  // upstream that began charging would provide a non-empty set and nothing else would change.
  await flushBackground();
  assertEquals(await repo.usage.listAll(), []);
  // No latency to report either: nothing dialled an upstream on a path that measures.
  assertEquals(await repo.performance.listAll(), []);
});

test('POST /v1/messages forwards upstream response headers end-to-end (streaming) and strips hop-by-hop / cookies', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-remaining': '99',
    'request-id': 'req_e2e_stream',
    'openai-version': '2024-10-21',
    'connection': 'close',
    'set-cookie': 'session=secret',
  });
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  queueCandidates([makeCandidate({ callAnthropicMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(response.headers.get('anthropic-ratelimit-unified-remaining'), '99');
  assertEquals(response.headers.get('request-id'), 'req_e2e_stream');
  assertEquals(response.headers.get('openai-version'), '2024-10-21');
  // hop-by-hop and cookies are stripped. `connection` is special-cased
  // because Hono's streamSSE writer sets its own `keep-alive`; assert
  // upstream's distinctive `close` did not survive instead of asserting
  // absence.
  assert(response.headers.get('connection') !== 'close');
  assertEquals(response.headers.get('set-cookie'), null);
  await response.text();
});

test('POST /v1/messages forwards upstream response headers end-to-end (non-streaming)', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'cf-ray': 'cf_ray_e2e',
  });
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  queueCandidates([makeCandidate({ callAnthropicMessages })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(response.headers.get('cf-ray'), 'cf_ray_e2e');
});

test('POST /v1/messages renders the Anthropic-shaped model-unsupported 400 when no candidate matches the messages-generate picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `completions` —
  // anthropicMessagesGenerateTarget (messages > responses > chat-completions) rejects
  // it, leaving zero viable candidates, and with sawModel=true the serve
  // renders model-unsupported as a 400.
  queueCandidates([makeCandidate({ endpoints: { openaiCompletions: {} } })]);

  const response = await makeApp().request('/v1/messages', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'wrong-endpoint-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { type: string; error: { type: string; message: string }; request_id: string };
  assertEquals(body.type, 'error');
  assertEquals(body.error.type, 'invalid_request_error');
  assert(body.error.message.includes('does not support'));
});
