import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS } from './test-policy.ts';
import { missingRequiredCompactionKeys, responseOnlyKeysAdded } from './test-required-resource-keys.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { type AliasRules, doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiResponsesResultToEvents, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, assertStringIncludes, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { type FlagId, type ModelCandidate, directFetcher, type UpstreamOpenAIResponsesResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/upstream';

// Mock the resolver seam so each test hands the http entry exactly the
// provider candidates it wants, optionally with an alias-rules overlay
// attached.
interface QueuedResolution {
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
}
const resolutionsQueue: QueuedResolution[] = [];
const lastSeenModel: { value: string | null } = { value: null };
vi.mock('../../../../src/data-plane/upstreams/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/upstreams/resolution.ts')>();
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

const { openaiResponsesHttp } = await import('../../../../src/data-plane/chat/openai-responses/http.ts');

const API_KEY_ID = 'key_http_test';

const queueResolution = (
  candidates: readonly ModelCandidate[],
  aliasRules?: AliasRules,
): void => {
  resolutionsQueue.push({
    candidates: aliasRules !== undefined ? candidates.map(c => ({ ...c, rules: aliasRules })) : candidates,
    sawModel: candidates.length > 0,
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
  randomizeUpstreams: false,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
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
  // Stamp the authenticated key onto every request so the http entry sees the
  // same value the real auth middleware would set.
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  app.post('/v1/responses', openaiResponsesHttp.generate);
  app.post('/v1/responses/compact', openaiResponsesHttp.compact);
  return app;
};

const makeOpenAIResponsesResult = (id = 'resp_test'): OpenAIResponsesResultEx => ({
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
  error: null,
  incomplete_details: null,
});

const makeProviderEvents = async function* (events: readonly OpenAIResponsesStreamEventEx[]): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  enabledFlags?: ReadonlySet<FlagId>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamOpenAIResponsesResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
  const instance = stubUpstream({
    callOpenAIResponses: overrides.callOpenAIResponses,
  });
  return {
    upstream: {
      upstreamId: upstream,
      kind: 'custom',
      name: upstream,
      inboundHeaderAllowlist: [],
      instance,
    },
    model: stubUpstreamModel({
      endpoints,
      enabledFlags: overrides.enabledFlags ?? new Set(),
    }),
    fetcher: directFetcher,
  };
};

const completedEvents = (id = 'resp_test'): OpenAIResponsesStreamEventEx[] =>
  openaiResponsesResultToEvents(makeOpenAIResponsesResult(id)).map(frame => frame.event);

const queueCompletedResponse = (id = 'resp_test') => {
  const callOpenAIResponses = vi.fn(async (): Promise<UpstreamOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProviderEvents(completedEvents(id)),
    modelKey: 'test-model-key',
    http: { status: 200, headers: new Headers() },
  }));
  queueResolution([makeCandidate({ callOpenAIResponses })]);
  return callOpenAIResponses;
};

test('Responses Lite input items keep their position and metadata across HTTP continuation', async () => {
  installRepo();
  const input = [
    { type: 'additional_tools', role: 'developer', id: 'at_lite', tools: [{ type: 'namespace', name: 'functions', description: '', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }] },
    { type: 'message', role: 'developer', id: 'msg_base', content: [{ type: 'input_text', text: 'Caller base instructions' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
    { type: 'message', role: 'user', content: 'First turn' },
  ];
  const bodies: Array<Omit<CanonicalOpenAIResponsesPayload, 'model'>> = [];
  const candidate = makeCandidate({
    endpoints: { openaiResponses: {} },
    callOpenAIResponses: async (_model, body) => {
      bodies.push(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>);
      return { action: 'generate', ok: true, events: makeProviderEvents(completedEvents(`resp_lite_${bodies.length}`)), modelKey: 'test-model-key' };
    },
  });
  const send = async (body: Record<string, unknown>): Promise<OpenAIResponsesResultEx> => {
    queueResolution([candidate]);
    const response = await makeApp().request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-openai-internal-codex-responses-lite': 'true' },
      body: JSON.stringify({ model: 'test-model', store: true, ...body }),
    });
    assertEquals(response.status, 200);
    return await response.json() as OpenAIResponsesResultEx;
  };

  const first = await send({ input });
  await send({ previous_response_id: first.id, input: [{ role: 'user', content: 'Second turn' }] });

  assertEquals(bodies[0]?.input, input);
  assertEquals(bodies[0]?.tools, undefined);
  assertEquals(bodies[0]?.instructions, undefined);
  assertEquals(bodies[1]?.input.slice(0, input.length), input);
  assertEquals(bodies[1]?.tools, undefined);
  assertEquals(bodies[1]?.instructions, undefined);
});

test('POST /v1/responses streams a successful SSE body', async () => {
  installRepo();
  const callOpenAIResponses = queueCompletedResponse();

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
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('POST /v1/responses terminates an SSE stream with error when an output item cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.openaiResponsesItems, 'insertMany').mockRejectedValue(new Error('simulated item persistence failure'));
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
    assert(body.endsWith('data: [DONE]\n\n'), 'expected the failed stream to end with the transport sentinel');
  } finally {
    persistence.mockRestore();
  }
});

test('POST /v1/responses returns 502 when the response snapshot cannot be persisted', async () => {
  const repo = installRepo();
  const persistence = vi.spyOn(repo.openaiResponsesSnapshots, 'insert').mockRejectedValue(new Error('simulated snapshot persistence failure'));
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
  upstream: Partial<OpenAIResponsesResultEx> = {},
  requestFields: Record<string, unknown> = {},
  http = { status: 200, headers: new Headers() },
): Promise<{ upstream: OpenAIResponsesResultEx; response: Response }> => {
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: OpenAIResponsesResultEx = {
    ...makeOpenAIResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as OpenAIResponsesResultEx['output'],
    usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    ...upstream,
  };
  const callOpenAIResponses = vi.fn(async (_model: unknown, _body: unknown, action: OpenAIResponsesAction): Promise<UpstreamOpenAIResponsesResult> => {
    if (action !== 'compact') throw new Error(`expected compact, got ${action}`);
    return { action: 'compact', ok: true, result: compactionResult, modelKey: 'test-model-key', http };
  });
  queueResolution([makeCandidate({ callOpenAIResponses })]);

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
  assertStringIncludes(body.error.message, 'no token usage');
});
