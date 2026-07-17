import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { isResponsesResponseId } from './items/format.ts';
import type { AuthVars } from '../../../middleware/auth.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { ApiKey, User } from '../../../repo/types.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type FlagId, type ModelCandidate, directFetcher, type ProviderResponsesResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

// Mock the resolver seam so each test hands the http entry exactly the
// provider candidates it wants, optionally with an alias-rules overlay
// attached.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}
const resolutionsQueue: QueuedResolution[] = [];
const lastSeenModel: { value: string | null } = { value: null };
vi.mock('../../providers/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../providers/registry.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async ({ model }: { model: string }) => {
      lastSeenModel.value = model;
      const next = resolutionsQueue.shift();
      if (next === undefined) throw new Error('http_test: no resolution enqueued');
      return next;
    }),
  };
});

const { responsesHttp } = await import('./http.ts');

const API_KEY_ID = 'key_http_test';

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
  enabledFlags?: ReadonlySet<FlagId>;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} };
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
    },
    model: stubInternalModel({
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({
          endpoints,
          enabledFlags: overrides.enabledFlags ?? new Set(),
        }),
      },
    }, upstream),
    fetcher: directFetcher,
  };
};

const completedEvent = (id = 'resp_test'): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number: 0,
  response: makeResponsesResult(id),
});

const queueCompletedResponse = (id = 'resp_test') => {
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents([completedEvent(id)]),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueResolution([makeCandidate({ callResponses })]);
  return callResponses;
};

test('POST /v1/responses streams a successful SSE body', async () => {
  installRepo();
  const callResponses = queueCompletedResponse();

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
  assert(isResponsesResponseId(completedMatch[1]));
  assertEquals(callResponses.mock.calls.length, 1);
});

test('POST /v1/responses canonicalizes and promotes an implicit system message', async () => {
  installRepo();
  let observedBody: Omit<CanonicalResponsesPayload, 'model'> | undefined;
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBody = body as Omit<CanonicalResponsesPayload, 'model'>;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents([completedEvent()]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueResolution([makeCandidate({
    callResponses,
    enabledFlags: new Set(['promote-system-to-developer']),
  })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: 'hello' },
      ],
      store: false,
      stream: true,
    }),
  });

  assertEquals(response.status, 200);
  const responseBody = await response.text();
  const responseId = responseBody.match(/"id":"(resp_[A-Za-z0-9_-]+)"/)?.[1];
  assert(responseId !== undefined && isResponsesResponseId(responseId), 'expected store:false to retain a Floway response id');
  assertEquals(observedBody?.input, [
    { type: 'message', role: 'developer', content: 'rules' },
    { type: 'message', role: 'user', content: 'hello' },
  ]);
});

test('POST /v1/responses rejects a malformed untyped input item', async () => {
  installRepo();
  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: [null] }),
  });

  assertEquals(response.status, 400);
  const body = await response.json() as { error: { message: string; param: string } };
  assertEquals(body.error.message, 'Untyped Responses input items require a valid role and content.');
  assertEquals(body.error.param, 'input[0]');
});

test('POST /v1/responses returns a single JSON body when stream is omitted', async () => {
  installRepo();
  queueCompletedResponse('resp_nonstream');

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as ResponsesResult;
  assert(isResponsesResponseId(body.id), `expected Floway-minted resp_ id, got ${body.id}`);
  assertEquals(body.status, 'completed');
});

test('POST /v1/responses returns 502 when a non-streaming output item cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.responsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello' }),
    });

    assertEquals(response.status, 502);
    const body = await response.json() as { error: { message: string } };
    assertEquals(body.error.message, 'simulated item persistence failure');
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses terminates an SSE stream with error when an output item cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.responsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
    });

    // Streaming headers are already committed, so the protocol error frame is
    // the failure signal; a successful terminal frame must never follow it.
    assertEquals(response.status, 200);
    const body = await response.text();
    assert(body.includes('event: error'));
    assert(body.includes('simulated item persistence failure'));
    assert(!body.includes('event: response.completed'));
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses returns 502 when the response snapshot cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.responsesSnapshots, 'insert').mockRejectedValue(new Error('simulated snapshot persistence failure'));
  try {
    queueCompletedResponse();

    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ model: 'test-model', input: 'hello' }),
    });

    assertEquals(response.status, 502);
    const body = await response.json() as { error: { message: string } };
    assertEquals(body.error.message, 'simulated snapshot persistence failure');
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses/compact returns a non-streaming compaction envelope', async () => {
  const repo = installRepo();
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
  queueResolution([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'test-model',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
      store: false,
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { object: string; id: string; output: Array<{ id: string }> };
  assertEquals(body.object, 'response.compaction');
  assert(isResponsesResponseId(body.id), `expected Floway-minted resp_ id, got ${body.id}`);
  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, body.id), null);
  assertEquals(await repo.responsesItems.lookupMany(API_KEY_ID, body.output.map(item => item.id)), []);
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

const queueCodexAutoReviewCandidate = (
  callResponses: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>,
): void => {
  const candidate = makeCandidate({ callResponses });
  Object.assign(candidate.model, { id: 'gpt-5.4' });
  queueResolution([candidate], { aliasRules: { reasoning: { effort: 'low' } } });
};

test('POST /v1/responses routes a codex-auto-review request through the seeded alias: rewrites the model to gpt-5.4 and stamps reasoning.effort=low', async () => {
  installRepo();
  lastSeenModel.value = null;
  const observedBodies: Omit<CanonicalResponsesPayload, 'model'>[] = [];
  queueCodexAutoReviewCandidate(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBodies.push(body as Omit<CanonicalResponsesPayload, 'model'>);
    return {
      action: 'generate', ok: true,
      events: makeProviderEvents([completedEvent()]),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'codex-auto-review', input: 'hello', stream: true }),
  });

  assertEquals(response.status, 200);
  // The resolver sees the inbound alias id verbatim; target-id walking is
  // internal to `enumerateModelCandidates`.
  assertEquals(lastSeenModel.value, 'codex-auto-review');
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponses to receive a body');
  // The attempt strips `model` from the body — the provider re-stamps it
  // from `candidate.model.id` — so we only verify the rules landed on the
  // IR.
  assertEquals(observed.reasoning?.effort, 'low');
});

test('POST /v1/responses/compact routes a codex-auto-review request through the seeded alias: rewrites the model to gpt-5.4 and stamps reasoning.effort=low (the alias rule overlays the compact body too)', async () => {
  installRepo();
  lastSeenModel.value = null;
  const observedBodies: Omit<CanonicalResponsesPayload, 'model'>[] = [];
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  queueCodexAutoReviewCandidate(async (_model, body, action): Promise<ProviderResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    observedBodies.push(body as Omit<CanonicalResponsesPayload, 'model'>);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key' };
  });

  const response = await makeApp().request('/v1/responses/compact', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model: 'codex-auto-review',
      input: [{ type: 'message', role: 'user', content: 'kept' }],
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      prompt_cache_retention: '24h',
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(lastSeenModel.value, 'codex-auto-review');
  const observed = observedBodies[0];
  if (observed === undefined) throw new Error('expected callResponses to receive a body');
  assertEquals(observed.reasoning?.effort, 'low');
  assertEquals(observed.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  assertEquals(observed.prompt_cache_retention, '24h');
});

test('POST /v1/responses renders the OpenAI-shaped model-unsupported 400 when no candidate matches the responses picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `completions` —
  // responsesTarget (responses > messages > chat-completions) rejects it,
  // leaving zero viable candidates, and with sawModel=true the serve renders
  // model-unsupported as a 400.
  queueResolution([makeCandidate({ endpoints: { completions: {} } })]);

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
