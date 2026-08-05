import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { TEST_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { missingRequiredCompactionKeys, missingRequiredResourceKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type CanonicalResponsesPayload, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
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
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
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

const { responsesHttp } = await import('../../../../src/data-plane/chat/responses/http.ts');

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
  void repo.apiKeys.save(buildApiKey());
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
  responsesRetentionSeconds: TEST_RESPONSES_RETENTION_SECONDS,
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
    content: [{ type: 'output_text', text: 'hi', annotations: [] }],
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
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      disabledPublicModelIds: [],
      modelPrefix: null,
      modelsCache: null,
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

const completedEvents = (id = 'resp_test'): ResponsesStreamEvent[] =>
  responsesResultToEvents(makeResponsesResult(id)).map(frame => frame.event);

const queueCompletedResponse = (id = 'resp_test') => {
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents(completedEvents(id)),
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
  // The source boundary mints its own response id; upstream's "resp_test" is discarded.
  const completedMatch = body.match(/"id":"(resp_[A-Za-z0-9_-]+)"/);
  assert(completedMatch !== null, 'expected a source-owned response id in the SSE body');
  assert(completedMatch[1] !== 'resp_test', 'expected the source boundary to replace the upstream response id');
  assertEquals(body.split('data: [DONE]').length - 1, 1);
  assert(body.endsWith('data: [DONE]\n\n'), 'expected the SSE body to terminate on the [DONE] sentinel');
  assertEquals(callResponses.mock.calls.length, 1);
});

test('POST /v1/responses makes a done reasoning item reusable before terminal', async () => {
  installRepo();
  const originalReasoning = {
    type: 'reasoning' as const,
    id: 'rs_upstream',
    summary: [],
    encrypted_content: 'opaque',
  };
  const observedBodies: Array<Omit<CanonicalResponsesPayload, 'model'>> = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  let responseCall = 0;
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBodies.push(body as Omit<CanonicalResponsesPayload, 'model'>);
    responseCall += 1;
    if (responseCall === 1) {
      const inProgress = {
        ...makeResponsesResult('resp_first'),
        status: 'in_progress' as const,
        output: [],
        output_text: '',
      };
      return {
        action: 'generate',
        ok: true,
        events: (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
          yield eventFrame({ type: 'response.created', response: inProgress });
          yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: originalReasoning });
          yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: originalReasoning });
          await firstReleased;
        })(),
        modelKey: 'test-model-key',
        headers: new Headers(),
      };
    }
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents(completedEvents('resp_second')),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  const candidate = makeCandidate({ callResponses });
  queueResolution([candidate]);
  queueResolution([candidate]);

  const firstResponse = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'first', store: true, stream: true }),
  });
  const reader = firstResponse.body?.getReader();
  if (reader === undefined) throw new Error('Expected streaming response body');
  const decoder = new TextDecoder();
  let buffered = '';
  let publicReasoning: typeof originalReasoning | undefined;
  while (publicReasoning === undefined) {
    const next = await reader.read();
    if (next.done) throw new Error('Response ended before output_item.done');
    buffered += decoder.decode(next.value, { stream: true });
    for (const block of buffered.split('\n\n')) {
      if (!block.startsWith('event: response.output_item.done\n')) continue;
      const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      if (data === undefined) throw new Error('output_item.done had no data line');
      const event = JSON.parse(data) as { item: typeof originalReasoning };
      publicReasoning = event.item;
    }
  }
  assertEquals(publicReasoning.id, originalReasoning.id);
  assert(publicReasoning.encrypted_content !== originalReasoning.encrypted_content);
  await reader.cancel();

  try {
    const secondResponse = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        model: 'test-model',
        store: true,
        input: [publicReasoning, { type: 'message', role: 'user', content: 'continue' }],
      }),
    });
    assertEquals(secondResponse.status, 200);
    await secondResponse.json();
    assertEquals(observedBodies[1]?.input[0], originalReasoning);
  } finally {
    releaseFirst();
  }
});

test('POST /v1/responses canonicalizes an implicit system message and rewrites it to developer', async () => {
  installRepo();
  let observedBody: Omit<CanonicalResponsesPayload, 'model'> | undefined;
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBody = body as Omit<CanonicalResponsesPayload, 'model'>;
    return {
      action: 'generate',
      ok: true,
      events: makeProviderEvents(completedEvents()),
      modelKey: 'test-model-key',
      headers: new Headers(),
    };
  });
  queueResolution([makeCandidate({
    callResponses,
    enabledFlags: new Set(['rewrite-system-to-developer']),
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
  assert(responseId !== undefined, 'expected store:false response id');
  assert(responseId !== 'resp_test', 'expected the source boundary to replace the upstream response id');
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
  assert(body.id.length > 0 && body.id !== 'resp_nonstream', 'expected the source boundary to replace the upstream response id');
  assertEquals(body.status, 'completed');
});

test('POST /v1/responses answers a translated-shape upstream with a complete response resource', async () => {
  installRepo();
  queueCompletedResponse('resp_complete');

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello' }),
  });

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(missingRequiredResourceKeys(body), []);
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
    assert(!body.includes('event: response.output_item.done'));
    assert(!body.includes('event: response.completed'));
    assert(!body.includes('[DONE]'), 'expected a failed stream to end on the error frame, not the sentinel');
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

// One compact turn against a stubbed candidate. The upstream result is
// returned so a test can compare the answered body against what the upstream
// actually sent. Token counts are part of the default because every real
// compaction is a turn a model ran; a test that wants the reported-nothing
// case passes `usage: null`.
const compactTurn = async (
  upstream: Partial<ResponsesResult> = {},
  requestFields: Record<string, unknown> = {},
): Promise<{ upstream: ResponsesResult; response: Response }> => {
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    ...upstream,
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
      ...requestFields,
    }),
  });
  return { upstream: compactionResult, response };
};

test('POST /v1/responses/compact returns a non-streaming compaction body', async () => {
  const repo = installRepo();
  const { response } = await compactTurn();

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { object: string; id: string; output: Array<{ id: string }> };
  assertEquals(body.object, 'response.compaction');
  assert(body.id.length > 0 && body.id !== 'resp_test', 'expected the source boundary to replace the upstream response id');
  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, body.id, 0), null);
  assertEquals(await repo.responsesItems.lookupMany(API_KEY_ID, body.output.map(item => item.id), 0), []);
});

test('POST /v1/responses/compact answers the compaction resource, not the response resource', async () => {
  installRepo();
  const { upstream, response } = await compactTurn(
    { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
    { temperature: 0.3 },
  );

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(missingRequiredCompactionKeys(body), []);
  assertEquals(typeof body.created_at, 'number');
  assertEquals(body.usage, {
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  });
  assertEquals(responseOnlyKeysAdded(upstream, body), []);
});

test('POST /v1/responses/compact reports the failure when the upstream reported no usage', async () => {
  installRepo();
  const { response } = await compactTurn({ usage: null });

  assertEquals(response.status, 502);
  const body = await response.json() as { error: { type: string; message: string } };
  assertEquals(body.error.type, 'internal_error');
  assert(
    body.error.message.includes('reported no token usage'),
    `expected the missing-usage condition to be named, got ${body.error.message}`,
  );
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

test('POST /v1/responses and /v1/responses/compact reject a body without `model` with the OpenAI missing-parameter 400', async () => {
  installRepo();

  for (const path of ['/v1/responses', '/v1/responses/compact']) {
    const response = await makeApp().request(path, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ input: 'hello' }),
    });

    assertEquals(response.status, 400);
    const body = await response.json() as { error: { message: string; type: string; param: string; code: string } };
    assertEquals(body.error, {
      message: "Missing required parameter: 'model'.",
      type: 'invalid_request_error',
      param: 'model',
      code: 'missing_required_parameter',
    });
  }
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
      events: makeProviderEvents(completedEvents()),
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
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
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

test('POST /v1/responses/compact answers a body that states no status, as a native compact upstream sends', async () => {
  installRepo();
  const { response } = await compactTurn({ status: undefined as unknown as ResponsesResult['status'] });

  assertEquals(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assertEquals(body.object, 'response.compaction');
  assertEquals(missingRequiredCompactionKeys(body), []);
  assertEquals((body.output as Array<{ type: string }>).map(item => item.type), ['compaction']);
});

test('POST /v1/responses nests a mid-stream failure under `error` so an SDK stream reader throws on it, then follows it with response.failed', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame(completedEvents()[0]!);
      throw new Error('upstream exploded mid-stream');
    })(),
    modelKey: 'test-model-key',
    headers: new Headers(),
  }));
  queueResolution([makeCandidate({ callResponses })]);

  const response = await makeApp().request('/v1/responses', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: 'test-model', input: 'hello', stream: true }),
  });

  const body = await response.text();
  const chunk = body.split('\n\n').find(part => part.startsWith('event: error'));
  assert(chunk !== undefined, `expected an error frame in ${body}`);
  const data = JSON.parse(chunk.slice(chunk.indexOf('data: ') + 'data: '.length)) as {
    type: string;
    error?: { message?: unknown };
    message?: unknown;
  };
  assertEquals(data.type, 'error');
  assertEquals(data.error?.message, 'upstream exploded mid-stream');
  assert(data.message === undefined, 'expected the payload to sit under `error`, not at the top level');

  const failedChunk = body.split('\n\n').find(part => part.startsWith('event: response.failed'));
  assert(failedChunk !== undefined, `expected a response.failed frame in ${body}`);
  const failed = JSON.parse(failedChunk.slice(failedChunk.indexOf('data: ') + 'data: '.length)) as {
    response: { status: string; id: string; error: { message: string } };
  };
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error.message, 'upstream exploded mid-stream');
  const created = JSON.parse(
    body.split('\n\n').find(part => part.startsWith('event: response.created'))!.split('data: ')[1]!,
  ) as { response: { id: string } };
  assertEquals(failed.response.id, created.response.id);
});
