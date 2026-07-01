import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { createStoredResponsesItemId, isStoredResponseId } from './items/format.ts';
import type { AuthVars } from '../../../middleware/auth.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ApiKey, StoredResponsesItem, User } from '../../../repo/types.ts';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderResponsesResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

// Mock the candidates seam so each test hands the http entry exactly the
// provider candidates it wants. Mirrors the pattern from serve_test.ts.
const candidatesQueue: { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
const seenModels: string[] = [];
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async (args: { model: string }) => {
      seenModels.push(args.model);
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { responsesHttp } = await import('./http.ts');

const API_KEY_ID = 'key_http_test';

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
  // Stamp the authenticated key onto every request so the http entry sees the
  // same value the real auth middleware would set.
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  app.post('/v1/responses', responsesHttp.generate);
  app.post('/v1/responses/compact', responsesHttp.compact);
  return app;
};

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

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callResponses: overrides.callResponses,
  });
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
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

const completedEvent = (id = 'resp_test'): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number: 0,
  response: makeResponsesResult(id),
});

test('POST /v1/responses streams a successful SSE body', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent()]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const body = await response.text();
  assert(body.includes('event: response.completed'));
  // Wrap layer mints its own response id; upstream's "resp_test" is discarded.
  const completedMatch = body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/);
  assert(completedMatch !== null, 'expected a Floway-minted resp_ id in the SSE body');
  assert(isStoredResponseId(completedMatch[1]));
  assertEquals(callResponses.mock.calls.length, 1);
});

test('POST /v1/responses returns a single JSON body when stream is omitted', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent('resp_nonstream')]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as ResponsesResult;
  assert(isStoredResponseId(body.id), `expected Floway-minted resp_ id, got ${body.id}`);
  assertEquals(body.status, 'completed');
});

test('POST /v1/responses/compact returns a non-streaming compaction envelope', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponses = vi.fn(async (_model: unknown, _body: unknown, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { object: string; id: string };
  assertEquals(body.object, 'response.compaction');
  assert(isStoredResponseId(body.id), `expected Floway-minted resp_ id, got ${body.id}`);
});

test('POST /v1/responses with an unresolvable previous_response_id renders the verbatim 400 envelope', async () => {
  installRepo();

  // No candidates need to be queued — the entry rejects before routing runs.
  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      previous_response_id: 'resp_missing',
      input: [{ type: 'message', role: 'user', content: 'follow up' }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; type: string; param: string; code: string } };
  assertEquals(body.error.message, "Previous response with id 'resp_missing' not found.");
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.param, 'previous_response_id');
  assertEquals(body.error.code, 'previous_response_not_found');
});

test('POST /v1/responses renders a routing-unavailable 400 when a forcing item names an absent upstream', async () => {
  const repo = installRepo();
  // A stored item pinned to `up_forcing` makes the input force-route to that
  // upstream; queueing a candidate for a different upstream produces the
  // routing-unavailable failure that the http entry must surface verbatim.
  const id = createStoredResponsesItemId('compaction');
  const row: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([row]);
  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'item_reference', id }],
    }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string } };
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('POST /v1/responses rewrites the codex-auto-review alias before routing', async () => {
  installRepo();
  seenModels.length = 0;
  const observedBodies: { reasoning?: { effort?: string } }[] = [];
  const callResponses = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderResponsesResult> => {
    observedBodies.push(body as { reasoning?: { effort?: string } });
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([completedEvent()]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'codex-auto-review', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(seenModels, ['gpt-5.4']);
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponses to receive a body');
  assertEquals(observed.reasoning?.effort, 'low');
});

test('POST /v1/responses/compact rewrites the codex-auto-review alias to gpt-5.4 with no reasoning field', async () => {
  installRepo();
  seenModels.length = 0;
  const observedBodies: { reasoning?: unknown }[] = [];
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponses = vi.fn(async (_model: unknown, body: unknown, action: ResponsesAction): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    observedBodies.push(body as { reasoning?: unknown });
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });
  queueCandidates([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'codex-auto-review',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(seenModels, ['gpt-5.4']);
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponses to receive a body');
  assertEquals(observed.reasoning, undefined);
});

test('POST /v1/responses renders the OpenAI-shaped model-unsupported 400 when no candidate matches the responses picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `completions` —
  // responsesTarget (responses > messages > chat-completions) rejects it,
  // leaving zero viable candidates, and with sawModel=true the serve renders
  // model-unsupported as a 400.
  queueCandidates([makeCandidate({ endpoints: { completions: {} } })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'wrong-endpoint-model', input: 'hello' }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assert(body.error.message.includes('does not support'));
});
