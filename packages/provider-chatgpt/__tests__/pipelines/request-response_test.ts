import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub, type UpstreamStateRepoStub } from '../upstream-state-repo.ts';
import { chatgptPipelineRequests, runChatGPTPipeline } from './run.ts';
import { toChatGPTUpstream } from '../../src/config.ts';
import { CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../../src/constants.ts';
import { chatgptPipelines } from '../../src/pipelines/index.ts';
import type { ChatGPTResponsesBody } from '../../src/pipelines/openai-responses/responses-lite.ts';
import { MAX_CHATGPT_OUTPUT_INDICES } from '../../src/pipelines/openai-responses/responses-output.ts';
import { createChatGPTService, type ChatGPTService } from '../../src/service.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTAccountCredential, ChatGPTQuotaSnapshotEntryMap, ChatGPTUpstreamState } from '../../src/state.ts';
import { getHeader, type HttpRequestFact } from '@floway-dev/http';
import { Secret } from '@floway-dev/pipeline';
import type { OpenAIResponsesCompactionItemEx, CanonicalOpenAIResponsesInputItem, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, toProviderModelFact, type FlagId, type UpstreamRecord } from '@floway-dev/provider';
import { readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

const activeAccount: ChatGPTAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null };
const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } });
const liteModel = stubProviderModel({ id: 'future-lite-model', endpoints: { openaiResponses: {} }, providerData: { useResponsesLite: true } });
const imageModel = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });

const upstreamId = 'up_a';
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const farFutureAccessToken: ChatGPTAccessTokenEntry = {
  token: 'at_kv',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

const makeRecord = (state: ChatGPTUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'chatgpt',
  name: 'ChatGPT',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', chatgptAccountId: 'acc', chatgptUserId: 'usr', planType: 'plus' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

let currentRecord: UpstreamRecord;
let service: ChatGPTService;
let repo: UpstreamStateRepoStub;
const { openaiResponses, openaiResponsesCompact, openaiImagesGenerations, alphaSearch, openaiImagesEdits } = chatgptPipelineRequests(() => toChatGPTUpstream(currentRecord), () => service);

// Mirrors what the data-plane refresh hook persists when a fresh token arrives.
const seedFreshAccessToken = (entry: ChatGPTAccessTokenEntry = farFutureAccessToken): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: entry }] });
};

const seedAccountState = (overrides: Partial<ChatGPTAccountCredential>): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, ...overrides }] });
};

const readQuotaEntry = (): ChatGPTQuotaSnapshotEntryMap | null =>
  (currentRecord.state as ChatGPTUpstreamState).accounts[0].quotaSnapshot;

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  service = createChatGPTService();
  repo = createUpstreamStateRepoStub(() => currentRecord, state => {
    currentRecord = { ...currentRecord, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: repo }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (status = 200): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`));
      c.close();
    },
  }),
  {
    status,
    headers: new Headers({
      'content-type': 'text/event-stream',
      'x-codex-active-limit': 'premium',
      'x-codex-plan-type': 'plus',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    }),
  },
);

const completedEvent = {
  type: 'response.completed',
  response: { id: 'resp_test', object: 'response', model: model.id, status: 'completed', output: [], error: null, incomplete_details: null },
};

const sseEventsResponse = (events: Record<string, unknown>[]): Response => new Response(
  `${(events.length === 0 ? [completedEvent] : events).map(event => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
  { headers: { 'content-type': 'text/event-stream', [CHATGPT_RESPONSES_LITE_HEADER]: 'true', 'x-upstream-custom': 'retained' } },
);

const errorJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: new Headers({ 'content-type': 'application/json', ...extraHeaders }) });

const idToken = (planType = 'plus'): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({
    email: 'a@b.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc',
      chatgpt_user_id: 'usr',
      chatgpt_plan_type: planType,
    },
  })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

describe('openaiResponses — gates', () => {
  test('refuses non-active state with synthetic 503', async () => {
    seedAccountState({ state: 'session_terminated' });
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') expect(result.http.status).toBe(503);
  });

  test('replaces the same family after success despite a future cached restriction, preserving other families', async () => {
    const until = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString();
    const unrelated = { fetchedAt: 1, data: { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'other', primary_used_percent: 100, ratelimited_until: until } };
    seedAccountState({
      accessToken: farFutureAccessToken,
      quotaSnapshot: {
        premium: {
          fetchedAt: new Date('2026-06-05T00:00:00.000Z').getTime(),
          data: { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', primary_used_percent: 100, primary_reset_after_at: until, ratelimited_until: until },
        },
        other: unrelated,
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).not.toBe('error');
    await Promise.all(result.detached);
    expect(readQuotaEntry()?.premium.data.primary_used_percent).toBe(42);
    expect(readQuotaEntry()?.premium.data.ratelimited_until).toBeUndefined();
    expect(readQuotaEntry()?.other).toEqual(unrelated);
  });
});

test('prepares Standard instructions and drops only the unsupported parameters', async () => {
  seedFreshAccessToken();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'message', role: 'developer', content: 'base instructions' },
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'message', role: 'developer', content: 'inline instructions' },
  ];
  const unsupported = {
    temperature: 0.6,
    max_output_tokens: 300,
    top_p: 0.8,
    frequency_penalty: 0.1,
    presence_penalty: 0.2,
    user: 'caller',
    metadata: { trace_id: 'trace' },
    prompt_cache_retention: '24h',
    safety_identifier: 'caller',
    stream_options: { include_obfuscation: true, include_usage: true },
  };
  const answer = await openaiResponses({
    model, headers: new Headers(), body: {
      input, ...unsupported, service_tier: 'future',
    },
  });
  expect(answer.outcome.kind).toBe('stream');
  const body = await readJsonRequest(fetchSpy.mock.calls[0]?.[1] as RequestInit);
  expect(body).toMatchObject({ input, instructions: "You're a helpful assistant.", service_tier: 'future' });
  for (const field of Object.keys(unsupported)) expect(body).not.toHaveProperty(field);
});

test('preserves caller-positioned Lite instructions and tool items', async () => {
  seedFreshAccessToken();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
  const input: CanonicalOpenAIResponsesInputItem[] = [
    { type: 'additional_tools', role: 'developer', tools: [] },
    {
      type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Caller base instructions' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] },
    },
  ];
  const answer = await openaiResponses({ model: liteModel, headers: new Headers(), body: { input } });
  expect(answer.outcome.kind).toBe('stream');
  const body = await readJsonRequest(fetchSpy.mock.calls[0]?.[1] as RequestInit);
  expect(body).toMatchObject({ input });
  expect(body).not.toHaveProperty('instructions');
});

test.each([
  { flags: [], expected: { reasoning: { effort: 'none' } }, omitted: ['thinking', 'enable_thinking'] },
  { flags: ['vendor-deepseek'], expected: { thinking: { type: 'disabled' } }, omitted: ['reasoning', 'enable_thinking'] },
  { flags: ['vendor-qwen'], expected: { enable_thinking: false }, omitted: ['reasoning', 'thinking'] },
  { flags: ['vendor-deepseek', 'vendor-qwen'], expected: { thinking: { type: 'disabled' } }, omitted: ['reasoning', 'enable_thinking'] },
] as const)('uses the enabled Responses vendor dialect for $flags', async ({ flags, expected, omitted }) => {
  seedFreshAccessToken();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
  const answer = await openaiResponses({
    model: { ...model, enabledFlags: new Set<FlagId>(flags) },
    headers: new Headers(),
    body: { input: [], reasoning: { effort: 'none' } },
  });
  expect(answer.outcome.kind).toBe('stream');
  const body = await readJsonRequest(fetchSpy.mock.calls[0]?.[1] as RequestInit);
  expect(body).toMatchObject(expected);
  for (const field of omitted) expect(body).not.toHaveProperty(field);
});

test('preserves Lite reasoning context after vendor reasoning normalization', async () => {
  seedFreshAccessToken();
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
  const answer = await openaiResponses({
    model: { ...liteModel, enabledFlags: new Set<FlagId>(['vendor-qwen']) },
    headers: new Headers(),
    body: { input: [], reasoning: { effort: 'none' } },
  });
  expect(answer.outcome.kind).toBe('stream');
  const body = await readJsonRequest(fetchSpy.mock.calls[0]?.[1] as RequestInit);
  expect(body).toMatchObject({ enable_thinking: false, reasoning: { context: 'all_turns' } });
  expect(body).not.toHaveProperty('reasoning.effort');
});

test('resolves Compact turn identity before handing off accepted caller metadata', async () => {
  seedFreshAccessToken();
  let identity: unknown;
  let transmitted: unknown;
  const { running } = runChatGPTPipeline(chatgptPipelines.openaiResponsesCompact, {
    'provider.upstream': toChatGPTUpstream(currentRecord),
    'provider.model': toProviderModelFact(model),
    'request.http': {
      url: 'https://floway.test', method: 'POST', headers: [
        ['x-codex-turn-metadata', JSON.stringify({
          session_id: 'caller-session', thread_source: 'caller', tool_namespaces_info: { excluded: true },
        })],
      ], body: null,
    },
    'request.openaiResponsesCompact': { model: model.id, input: [] },
  }, service, {
    fetcher: async (_url, init) => {
      const metadata = new Headers(init.headers).get('x-codex-turn-metadata');
      if (metadata === null) throw new Error('Expected Compact turn metadata');
      transmitted = JSON.parse(metadata);
      return { response: compactJsonResponse() };
    },
    events(event) {
      if (event.type === 'stage.entered' && event.name === 'openaiResponsesCompact.parse-response') {
        identity = event.facts['request.chatgptResponsesIdentity'];
      }
    },
  });
  await expect(running.result).resolves.toMatchObject({ 'response.openaiResponsesCompact': { kind: 'result' } });
  await running.done;
  expect(identity).toMatchObject({ sessionId: 'caller-session', callerTurnMetadata: { thread_source: 'caller' } });
  expect(identity).not.toHaveProperty('callerTurnMetadata.session_id');
  expect(identity).not.toHaveProperty('callerTurnMetadata.tool_namespaces_info');
  expect(transmitted).toMatchObject({ session_id: 'caller-session', thread_source: 'caller', installation_id: activeAccount.openaiDeviceId });
  expect(transmitted).not.toHaveProperty('tool_namespaces_info');
});

test('completes Responses at the protocol terminal while the HTTP source remains open', async () => {
  seedFreshAccessToken();
  const sourceAborted = Promise.withResolvers<void>();
  const { running, controller } = runChatGPTPipeline(chatgptPipelines.openaiResponses, {
    'provider.upstream': toChatGPTUpstream(currentRecord),
    'provider.model': toProviderModelFact(model),
    'request.http': { url: 'https://floway.test', method: 'POST', headers: [], body: null },
    'request.openaiResponses': { model: model.id, input: [] },
  }, service, {
    fetcher: async (_url, { signal }) => ({
      response: new Response(new ReadableStream<Uint8Array>({
        start(body) {
          body.enqueue(new TextEncoder().encode(`event: response.completed\ndata: ${JSON.stringify(completedEvent)}\n\n`));
          signal?.addEventListener('abort', () => {
            sourceAborted.resolve();
            body.error(signal.reason);
          }, { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    }),
  });
  const outcome = (await running.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected Responses stream');
  try {
    const items = await Array.fromAsync(running.read(outcome.stream));
    expect(items.at(-1)).toMatchObject({ ok: true, value: completedEvent });
    await running.done;
    expect(controller.signal.aborted).toBe(false);
  } finally {
    controller.abort();
  }
  await sourceAborted.promise;
});

test('panics on output index overflow while the HTTP source is still live', async () => {
  seedFreshAccessToken();
  const sourceAborted = Promise.withResolvers<void>();
  let aborted = false;
  const { running, controller } = runChatGPTPipeline(chatgptPipelines.openaiResponses, {
    'provider.upstream': toChatGPTUpstream(currentRecord),
    'provider.model': toProviderModelFact(model),
    'request.http': { url: 'https://floway.test', method: 'POST', headers: [], body: null },
    'request.openaiResponses': { model: model.id, input: [] },
  }, service, {
    fetcher: async (_url, { signal }) => ({
      response: new Response(new ReadableStream<Uint8Array>({
        start(body) {
          const utf8 = new TextEncoder();
          for (let index = 0; index <= MAX_CHATGPT_OUTPUT_INDICES; index++) {
            const event = { type: 'response.output_item.added', output_index: index, item: { id: `item-${index}`, type: 'reasoning', summary: [] } };
            body.enqueue(utf8.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          signal?.addEventListener('abort', () => {
            aborted = true;
            sourceAborted.resolve();
            body.error(signal.reason);
          }, { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    }),
  });
  const outcome = (await running.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected Responses stream');
  try {
    await Promise.all([
      expect(Array.fromAsync(running.read(outcome.stream))).rejects.toThrow(`exceeds ${MAX_CHATGPT_OUTPUT_INDICES} indices`),
      expect(running.done).rejects.toBeInstanceOf(RangeError),
    ]);
    expect(aborted).toBe(false);
  } finally {
    controller.abort();
  }
  await sourceAborted.promise;
});

test('publishes the wire credential only as a Secret and completes before quota persistence', async () => {
  seedFreshAccessToken();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let persisted = false;
  let terminalFacts: Record<string, unknown> | undefined;
  const { running, detached } = runChatGPTPipeline(chatgptPipelines.openaiResponsesCompact, {
    'provider.upstream': toChatGPTUpstream(currentRecord),
    'provider.model': toProviderModelFact(model),
    'request.http': {
      url: 'https://floway.test', method: 'POST', headers: [
        ['authorization', Secret.from('Bearer client-secret')], ['cookie', Secret.from('client-secret')],
      ], body: null,
    },
    'request.openaiResponsesCompact': { model: model.id, input: [] },
  }, {
    ...service, quotaObservation: () => async () => {
      started.resolve();
      await release.promise;
      persisted = true;
    },
  }, {
    fetcher: async (_url, init) => {
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer at_kv');
      return { response: compactJsonResponse() };
    },
    events(event) {
      if (event.type !== 'stage.entered' || event.name !== 'http') return;
      terminalFacts = event.facts;
    },
  });
  await started.promise;
  try {
    await expect(running.result).resolves.toMatchObject({ 'response.openaiResponsesCompact': { kind: 'result' } });
    await running.done;
    expect(terminalFacts).toBeDefined();
    expect(terminalFacts).not.toHaveProperty('request.chatgptResponsesIdentity');
    const request = terminalFacts?.['request.http'] as HttpRequestFact;
    const bearer = getHeader(request.headers, 'authorization');
    expect(bearer).toBeInstanceOf(Secret);
    expect(JSON.stringify(bearer)).not.toContain('at_kv');
    expect(getHeader(request.headers, 'cookie')).toBeUndefined();
    expect(detached).toHaveLength(1);
    expect(persisted).toBe(false);
  } finally {
    release.resolve();
  }
  await Promise.all(detached);
  expect(persisted).toBe(true);
});

test('relays a protocol stream error from the Responses parser', async () => {
  seedFreshAccessToken();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('event: response.created\ndata: {\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const result = await openaiResponses({ model, headers: new Headers(), body: { input: [] } });
  expect(result.events).toEqual([{ ok: false, error: { kind: 'protocol', cause: expect.any(Error) } }]);
});

test('preserves repeated upstream header lines and the parsed error body', async () => {
  seedFreshAccessToken();
  const error = { error: { code: 'expired_token', message: 'expired' } };
  const headers = [
    ['content-type', 'application/json'], ['set-cookie', 'first=a'], ['set-cookie', 'second=b'],
  ] as const;
  const { running } = runChatGPTPipeline(chatgptPipelines.openaiResponsesCompact, {
    'provider.upstream': toChatGPTUpstream(currentRecord),
    'provider.model': toProviderModelFact(model),
    'request.http': { url: 'https://floway.test', method: 'POST', headers: [], body: null },
    'request.openaiResponsesCompact': { model: model.id, input: [] },
  }, service, {
    fetcher: async url => ({
      response: url.endsWith('/oauth/token')
        ? Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 600 })
        : Object.assign(Response.json(error, { status: 401 }), { headerLines: headers }),
    }),
  });
  await expect(running.result).resolves.toEqual({
    'response.http': { status: 401, statusText: '', headers, body: null },
    'response.openaiResponsesCompact': { kind: 'error', source: 'upstream', error },
  });
  await running.done;
});

describe('ChatGPT terminal output recovery', () => {
  test('restores native compaction even when the client requests a scalar response', async () => {
    const item: OpenAIResponsesCompactionItemEx = {
      type: 'compaction', id: 'cmp_native', encrypted_content: 'OPAQUE_NATIVE_BLOB',
      metadata: { turn_id: 'turn_native' }, internal_chat_message_metadata_passthrough: { turn_id: 'turn_native' },
    };
    const terminal: OpenAIResponsesResultEx = {
      id: 'resp_native', object: 'response', model: model.id, status: 'completed', output: [],
      error: null, incomplete_details: null, usage: { input_tokens: 15, output_tokens: 25, total_tokens: 40 },
    };
    for (const stream of [true, false]) {
      seedFreshAccessToken();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseEventsResponse([
        { type: 'response.created', response: { ...terminal, status: 'in_progress' } },
        { type: 'response.in_progress', response: { ...terminal, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.compaction.compacting', item_id: item.id, output_index: 0 },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: terminal },
      ]));
      const result = await openaiResponses({
        model,
        body: { input: [{ type: 'compaction_trigger' } as unknown as CanonicalOpenAIResponsesInputItem], stream },
        headers: new Headers(),
      });
      const { events } = result;
      expect(events).toHaveLength(6);
      expect(events?.[0]).toMatchObject({ ok: true, value: { response: { output: [], status: 'in_progress' } } });
      expect(events?.[3]).toMatchObject({ ok: true, value: { type: 'response.compaction.compacting', item_id: item.id } });
      expect(events?.[4]).toMatchObject({ ok: true, value: { type: 'response.output_item.done', output_index: 0, item } });
      expect(events?.[5]).toMatchObject({ ok: true, value: { type: 'response.completed', response: { ...terminal, output: [item] } } });
      fetchSpy.mockRestore();
    }
  });
});

describe('Codex Responses wire selection', () => {
  const tool = { type: 'function' as const, name: 'lookup', parameters: { type: 'object' } };

  test.each([true, false])('catalog flag %s alone selects generate and compact wire formats', async useResponsesLite => {
    seedFreshAccessToken();
    for (const action of ['generate', 'compact'] as const) {
      for (const marker of ['true', 'false', undefined]) {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => action === 'generate' ? sseEventsResponse([]) : compactJsonResponse());
        const body = {
          input: [
            { type: 'message' as const, role: 'user' as const, content: [{ type: 'input_audio' as const, audio_url: 'data:audio/wav;base64,YQ==' }] },
            { type: 'function_call_output' as const, call_id: 'audio', output: [{ type: 'input_audio' as const, file_id: 'file-audio' }] },
            // The CLI emits this only with its opt-in reasoning_effort_override feature.
            // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/reasoning_effort.rs#L16-L85
            { type: 'configuration_update', reasoning: { effort: 'disabled' } } as unknown as CanonicalOpenAIResponsesInputItem,
          ],
          instructions: 'Base', tools: [tool], parallel_tool_calls: true,
          reasoning: { effort: 'future_effort', context: 'current_turn' },
          tool_choice: 'auto' as const,
          text: { verbosity: 'high' as const },
          service_tier: 'ultrafast',
          client_metadata: { [CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY]: marker, retained: { future: true } },
          temperature: 0.5,
        };
        const original = JSON.stringify(body);
        const headers = new Headers(marker === undefined ? {} : { [CHATGPT_RESPONSES_LITE_HEADER]: marker });
        const call = action === 'generate' ? openaiResponses : openaiResponsesCompact;
        const result = await call({
          model: { ...model, providerData: { useResponsesLite } },
          body, headers,
        });
        if (result.outcome.kind === 'error') throw new Error('expected a successful response');
        const [url, init] = fetchSpy.mock.lastCall!;
        expect(url).toBe(`https://chatgpt.com/backend-api/codex/responses${action === 'compact' ? '/compact' : ''}`);
        const wire = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
        const wireHeaders = new Headers(init?.headers);
        expect(wireHeaders.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(useResponsesLite ? 'true' : null);
        expect(wireHeaders.get('user-agent')).toBe('codex_cli_rs/0.169.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10');
        expect(wireHeaders.get('version')).toBe('0.169.0');
        expect(headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(JSON.stringify(body)).toBe(original);
        expect(wire.text).toEqual(body.text);
        expect(wire.service_tier).toBe('ultrafast');
        if (useResponsesLite) {
          expect(wire).not.toHaveProperty('tools');
          expect(wire).not.toHaveProperty('instructions');
          expect(wire.input).toEqual([
            { type: 'additional_tools', role: 'developer', id: expect.stringMatching(/^at_/), tools: [{ type: 'namespace', name: 'functions', description: '', tools: [tool] }] },
            { type: 'message', role: 'developer', id: expect.stringMatching(/^msg_/), content: [{ type: 'input_text', text: 'Base' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['model.base_instructions'] } },
            ...body.input,
          ]);
          expect(wire.parallel_tool_calls).toBe(false);
          expect(wire.reasoning).toEqual({ effort: 'future_effort', context: 'all_turns' });
        } else {
          expect(wire.tools).toEqual(body.tools);
          expect(wire.instructions).toBe(body.instructions);
          expect(wire.input).toEqual(body.input);
          expect(wire.parallel_tool_calls).toBe(true);
          expect(wire.reasoning).toEqual(body.reasoning);
        }
        if ('events' in result) {
          expect(wire.client_metadata).toMatchObject({ retained: { future: true } });
          expect(wire.client_metadata).not.toHaveProperty(CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY);
          expect(wire.tool_choice).toBe('auto');
          expect(wire.stream).toBe(true);
          expect(wire.store).toBe(false);
          expect(result.http?.headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
          expect(result.http?.headers.get('x-upstream-custom')).toBe('retained');
          expect(result.events).toContainEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ type: 'response.completed' }) }));
        } else {
          for (const field of ['stream', 'store', 'client_metadata', 'temperature', 'tool_choice']) expect(wire).not.toHaveProperty(field);
          expect(result).not.toHaveProperty('headers');
        }
      }
    }
  });

  test('projects moved top-level fields while preserving upstream calls through the stream', async () => {
    seedFreshAccessToken();
    const wireCall = { type: 'function_call' as const, id: 'fc_1', call_id: 'call_1', name: 'lookup', namespace: 'functions', arguments: '{}', status: 'completed' as const, future: 'retained' };
    const opaque = { type: 'reasoning', id: 'rs_opaque', summary: [], encrypted_content: 'opaque+encrypted==' };
    const future = { type: 'response.future', data: { retained: true }, sequence_number: 1 };
    const wireResponse = {
      id: 'resp_1', object: 'response', model: liteModel.id, status: 'completed', error: null, incomplete_details: null,
      output: [wireCall, opaque], instructions: null, tools: [], parallel_tool_calls: false,
      reasoning: { effort: 'medium', summary: 'detailed', context: 'all_turns', mode: 'future_mode' },
      service_tier: 'future_tier', tool_choice: 'auto', future: 'retained',
    };
    const upstream = sseEventsResponse([
      { type: 'response.output_item.added', output_index: 0, item: wireCall },
      future,
      { type: 'response.output_item.done', output_index: 0, item: wireCall },
      { type: 'response.completed', response: wireResponse },
    ]);
    upstream.headers.delete('content-type');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(upstream);
    const body = { input: [], instructions: 'Base', tools: [tool], parallel_tool_calls: true, reasoning: { effort: 'low', context: 'current_turn' }, stream: true };
    const result = await openaiResponses({
      model: liteModel, body, headers: new Headers(),
    });
    if (result.events === undefined) throw new Error('expected successful Responses stream');
    expect(result.http?.headers.get('content-type')).toBe('text/event-stream');
    expect(result.http?.headers.has(CHATGPT_RESPONSES_LITE_HEADER)).toBe(true);
    expect(upstream.headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    const { events } = result;
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ ok: true, value: { item: wireCall } });
    expect(events[1]).toEqual({ ok: true, value: future });
    expect(events[2]).toMatchObject({ ok: true, value: { item: wireCall } });
    expect(events[3]).toMatchObject({ ok: true, value: { response: { ...wireResponse, tools: body.tools, instructions: body.instructions } } });
  });

  test('preserves the complete compact output window around a caller-positioned tools carrier', async () => {
    seedFreshAccessToken();
    const opaque = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' };
    const body: ChatGPTResponsesBody = {
      instructions: 'Old instructions',
      tools: [tool],
      input: [
        { type: 'additional_tools' as const, role: 'developer' as const, id: 'at_caller', tools: [{ type: 'custom' as const, name: 'patch' }] },
        { type: 'message', role: 'user', content: 'Continue' },
      ],
    };
    let sentInput: unknown[] | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const wire = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
      sentInput = wire.input as unknown[];
      expect(new Headers(init?.headers).get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
      expect(String(url)).toContain('/compact');
      return Response.json({ id: 'cmp_resource', object: 'response.compaction', output: [...wire.input as unknown[], opaque] });
    });
    const opts = { model: liteModel, headers: new Headers({ 'thread-id': 'compact-replay-thread' }) };
    const compact = await openaiResponsesCompact({ ...opts, body });
    if (compact.outcome.kind !== 'result') throw new Error('expected successful compact response');
    expect(compact.outcome.result.output).toEqual([...sentInput!, opaque]);
  });

  test.each(['generate', 'compact'] as const)('%s reuses prepared bytes and metadata choice across 401 retry', async action => {
    seedFreshAccessToken();
    const selectedModel = { ...liteModel, providerData: { useResponsesLite: true } };
    const bodies: string[] = [];
    const headers: Headers[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'at_retry', refresh_token: 'rt_retry', expires_in: 600, id_token: idToken() }));
      bodies.push(await new Response(init?.body).text());
      headers.push(new Headers(init?.headers));
      if (bodies.length === 1) {
        return errorJson(401, { error: { code: 'expired_token', message: 'expired' } });
      }
      return action === 'generate' ? sseEventsResponse([]) : compactJsonResponse();
    });
    const call = action === 'generate' ? openaiResponses : openaiResponsesCompact;
    const result = await call({
      model: selectedModel,
      body: { input: [], tools: [tool], instructions: 'Base' }, headers: new Headers(),
    });
    expect(result.outcome.kind).not.toBe('error');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).input[0].id).toMatch(/^at_/);
    expect(headers[0]!.get('thread-id')).toMatch(UUID_V7_RE);
    expect(headers[0]!.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    expect(headers[1]!.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    expect(headers[0]!.get('authorization')).toBe('Bearer at_kv');
    expect(headers[1]!.get('authorization')).toBe('Bearer at_retry');
    headers.forEach(header => header.delete('authorization'));
    expect([...headers[1]!]).toEqual([...headers[0]!]);
  });

  test.each(['generate', 'compact'] as const)('%s returns non-OK upstream Responses unchanged, including Lite markers', async action => {
    seedFreshAccessToken();
    for (const status of [400, 429, 503]) {
      for (const marker of [undefined, 'true', 'false']) {
        const upstream = new Response('upstream bytes\nnot necessarily JSON', {
          status, statusText: 'Upstream failure', headers: { 'content-type': 'application/problem+json', 'x-upstream-custom': 'retained', ...(marker === undefined ? {} : { [CHATGPT_RESPONSES_LITE_HEADER]: marker }) },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstream);
        const call = action === 'generate' ? openaiResponses : openaiResponsesCompact;
        const result = await call({
          model: liteModel, body: { input: [] },
          headers: new Headers({ [CHATGPT_RESPONSES_LITE_HEADER]: 'false' }),
        });
        if (result.outcome.kind !== 'error') throw new Error('expected upstream error');
        expect(result.http.status).toBe(status);
        expect(result.http.headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(result.http.headers.get('content-type')).toBe('application/problem+json');
        expect(result.http.statusText).toBe('Upstream failure');
        expect(result.outcome.error).toEqual({ error: { type: 'api_error', message: 'upstream bytes\nnot necessarily JSON' } });
      }
    }
  });
});

describe('openaiResponses — upstream classification', () => {
  test('builds Codex responses headers and metadata from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await openaiResponses({
      model,
      body: {
        input: [],
        stream: true,
        client_metadata: { 'x-codex-installation-id': 'downstream-installation' },
      } as unknown as Parameters<typeof openaiResponses>[0]['body'],
      headers: new Headers({
        'cf-connecting-ip': '203.0.113.10',
        forwarded: 'for=203.0.113.10',
        'openai-beta': 'responses=experimental',
        originator: 'downstream-originator',
        'session-id': 'downstream-session',
        'user-agent': 'curl/8.7.1',
        version: '1',
        'x-client-request-id': 'req-123',
        'x-codex-beta-features': 'responses_websockets=2026-02-06',
        'x-codex-turn-metadata': 'turn-meta',
        'x-codex-window-id': 'downstream-window',
        'x-real-ip': '203.0.113.10',
      }),

    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CHATGPT_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CHATGPT_USER_AGENT);
    expect(headers.get('version')).toBe(CHATGPT_CLI_VERSION);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('session-id')).toBe('downstream-session');
    // Caller-supplied identity fields pass through; noise headers (cf-*,
    // forwarded, x-real-ip, openai-beta, x-codex-beta-features) are dropped.
    expect(headers.get('x-client-request-id')).toBe('req-123');
    expect(headers.get('thread-id')).toBe('downstream-session');
    expect(headers.get('x-codex-beta-features')).toBeNull();
    expect(headers.get('x-codex-window-id')).toBe('downstream-window');
    const turnMetadataJson = headers.get('x-codex-turn-metadata');
    const turnMetadata = JSON.parse(turnMetadataJson ?? 'null') as Record<string, unknown>;
    expect(turnMetadata).toEqual({
      installation_id: 'downstream-installation',
      session_id: 'downstream-session',
      thread_id: 'downstream-session',
      turn_id: expect.stringMatching(UUID_V7_RE),
      window_id: 'downstream-window',
      request_kind: 'turn',
    });
    expect(headers.get('cf-connecting-ip')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('openai-beta')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('downstream-session');
    expect(body.client_metadata).toEqual({
      'x-codex-installation-id': 'downstream-installation',
      session_id: turnMetadata.session_id,
      thread_id: turnMetadata.thread_id,
      'x-codex-window-id': turnMetadata.window_id,
      turn_id: turnMetadata.turn_id,
      'x-codex-turn-metadata': turnMetadataJson,
    });
  });

  test('synthesized Codex identity keeps supplied session and fallback window stable while rotating turn ids', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());
    const request = {
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'stable-session' }),

    } satisfies Parameters<typeof openaiResponses>[0];

    await openaiResponses(request);
    await openaiResponses({ ...request, headers: new Headers({ 'session-id': 'stable-session' }) });

    const firstHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('x-codex-window-id')).toBe('stable-session:0');
    expect(secondHeaders.get('x-codex-window-id')).toBe('stable-session:0');
    expect(firstHeaders.get('x-codex-turn-metadata')).not.toBe(secondHeaders.get('x-codex-turn-metadata'));
    expect(firstHeaders.get('x-client-request-id')).toBe('stable-session');
    expect(secondHeaders.get('x-client-request-id')).toBe('stable-session');
    const firstMetadata = JSON.parse(firstHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const secondMetadata = JSON.parse(secondHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(firstMetadata.installation_id).toBe(secondMetadata.installation_id);
    expect(secondMetadata).toMatchObject({ session_id: 'stable-session', thread_id: 'stable-session', window_id: 'stable-session:0' });
    expect(firstMetadata.turn_id).not.toBe(secondMetadata.turn_id);
  });

  test('injects prompt_cache_key only when caller leaves it absent', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());

    await openaiResponses({
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),

    });
    await openaiResponses({
      model,
      body: { input: [], stream: true, prompt_cache_key: 'caller-cache-key' },
      headers: new Headers({ 'session-id': 'cache-session' }),

    });
    await openaiResponses({
      model,
      body: { input: [], stream: true, prompt_cache_key: null },
      headers: new Headers({ 'session-id': 'cache-session' }),

    });

    const injectedBody = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const preservedStringBody = await readJsonRequest(fetchSpy.mock.calls[1][1] as RequestInit) as Record<string, unknown>;
    const preservedNullBody = await readJsonRequest(fetchSpy.mock.calls[2][1] as RequestInit) as Record<string, unknown>;
    expect(injectedBody.prompt_cache_key).toBe('cache-session');
    expect(preservedStringBody.prompt_cache_key).toBe('caller-cache-key');
    expect(preservedNullBody).toHaveProperty('prompt_cache_key', null);
  });

  test('reads the turn-metadata blob from the body before the header', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await openaiResponses({
      model,
      body: {
        input: [], stream: true,
        client_metadata: {
          session_id: 'body-session',
          'x-codex-window-id': 'thread-1:2',
          'x-codex-turn-metadata': JSON.stringify({
            window_id: 'thread-1:2',
            request_kind: 'compaction',
            compaction: { trigger: 'auto', reason: 'context_limit' },
            turn_started_at_unix_ms: 1700000000002,
          }),
        },
      } as unknown as Parameters<typeof openaiResponses>[0]['body'],
      // A WebSocket upgrade's headers are frozen for the life of the socket,
      // so they carry the connection's first turn, not this one.
      headers: new Headers({
        'session-id': 'header-session',
        'x-codex-window-id': 'thread-1:0',
        'x-codex-turn-metadata': JSON.stringify({
          window_id: 'thread-1:0',
          request_kind: 'turn',
          turn_started_at_unix_ms: 1700000000000,
        }),
      }),

    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.request_kind).toBe('compaction');
    expect(turnMetadata.compaction).toEqual({ trigger: 'auto', reason: 'context_limit' });
    expect(turnMetadata.turn_started_at_unix_ms).toBe(1700000000002);
    expect(turnMetadata.session_id).toBe('body-session');
    // The window advances on every auto-compaction and the advanced value
    // reaches us in the body alone.
    expect(turnMetadata.window_id).toBe('thread-1:2');
    expect(headers.get('x-codex-window-id')).toBe('thread-1:2');
  });

  test('keeps the unbounded tool inventory in the body blob and out of the header blob', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const toolNamespacesInfo = { namespaces: [{ name: 'shell', tools: ['exec'] }] };
    await openaiResponses({
      model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({ tool_namespaces_info: toolNamespacesInfo, thread_source: 'user' }),
        },
      } as unknown as Parameters<typeof openaiResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'sess' }),

    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const headerMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(headerMetadata.tool_namespaces_info).toBeUndefined();
    expect(headerMetadata.thread_source).toBe('user');

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const bodyMetadata = JSON.parse(
      (body.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
    ) as Record<string, unknown>;
    expect(bodyMetadata.tool_namespaces_info).toEqual(toolNamespacesInfo);
    expect(bodyMetadata.thread_source).toBe('user');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') expect(result.http.status).toBe(503);
    expect((currentRecord.state as ChatGPTUpstreamState).accounts[0].state).toBe('session_terminated');
  });

  test('access-only 401 preserves the upstream response and does not refresh', async () => {
    seedAccountState({
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: null, refreshedAt: 'now' },
    });
    const upstreamBody = { error: { code: 'token_invalidated', message: 're-import required' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, upstreamBody, { 'x-upstream-marker': 'kept' }));
    repo.saveState.mockRejectedValueOnce(new Error('state write failed'));
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') {
      expect(result.http.status).toBe(401);
      expect(result.http.headers.get('x-upstream-marker')).toBe('kept');
      expect(result.outcome.error).toEqual(upstreamBody);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.detached).toHaveLength(1);
    await Promise.all(result.detached);
    expect(repo.saveState).toHaveBeenCalledOnce();
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') expect(result.http.status).toBe(401);
    expect((currentRecord.state as ChatGPTUpstreamState).accounts[0].refresh_token).toBe('rt_v2');
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached', resets_in_seconds: 7200 } }, {
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '35',
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await openaiResponses({
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(result.outcome.kind).toBe('error');
    if (result.outcome.kind === 'error') expect(result.http.status).toBe(429);
    await Promise.all(result.detached);
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBe(new Date(Date.parse(stored!.premium.data.observed_at) + 3600 * 1000).toISOString());
  });

});

describe('openaiImagesGenerations', () => {
  test('does not replace a meaningful quota snapshot with a headerless image response', async () => {
    const quotaSnapshot: ChatGPTQuotaSnapshotEntryMap = {
      premium: {
        fetchedAt: 1,
        data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'premium', primary_used_percent: 42 },
      },
    };
    seedAccountState({ accessToken: { ...farFutureAccessToken, planType: 'plus' }, quotaSnapshot });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const result = await openaiImagesGenerations({
      model: imageModel,
      body: { model: imageModel.id, prompt: 'an orange circle' },
      headers: new Headers(),
      waitUntil,
    });
    expect(result.http.status).toBe(200);
    expect(readQuotaEntry()).toEqual(quotaSnapshot);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test('uses a refreshed Free plan before dispatching the image request', async () => {
    seedAccountState({ accessToken: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(200, {
      access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'), expires_in: 600,
    }));
    const result = await openaiImagesGenerations({
      model: imageModel,
      body: { model: imageModel.id, prompt: 'an orange circle' },
      headers: new Headers(),
    });
    expect(result.http.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/oauth/token');
  });

  test('does not invalidate a sibling token that won before the 401 was handled', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, token: 'at_failed', planType: 'plus' });
    const winner: ChatGPTAccessTokenEntry = {
      token: 'at_winner',
      expiresAt: farFutureAccessToken.expiresAt,
      refreshedAt: '2026-08-10T00:00:02.000Z',
      planType: 'free',
      planObservedAt: '2026-08-10T00:00:02.000Z',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      seedAccountState({ refresh_token: 'rt_winner', accessToken: winner });
      return errorJson(401, { error: { code: 'expired_token', message: 'expired' } });
    });
    const result = await openaiImagesGenerations({
      model: imageModel,
      body: { model: imageModel.id, prompt: 'an orange circle' },
      headers: new Headers(),
    });
    expect(result.http.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as ChatGPTUpstreamState).accounts[0].accessToken).toEqual(winner);
  });
});

test('serializes image edits uploads as JSON data URLs and reads the image SSE response', async () => {
  seedFreshAccessToken();
  const event = { type: 'image_edit.completed', b64_json: 'ZWRpdA==' };
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const result = await openaiImagesEdits({
    model: imageModel, headers: new Headers({ originator: 'chatgpt_cca' }), body: {
      images: [{ type: 'upload', file: { name: 'image.png', mediaType: 'image/png', bytes: new TextEncoder().encode('image') } }],
      parameters: { prompt: 'make it blue', stream: true },
    },
  });
  expect(result.http.status).toBe(200);
  expect(result.events).toEqual([{ ok: true, value: event }]);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
  expect(new Headers(init?.headers).get('originator')).toBe('chatgpt_cca');
  expect(await readJsonRequest(init as RequestInit)).toEqual({
    prompt: 'make it blue', stream: true, images: [{ image_url: 'data:image/png;base64,aW1hZ2U=' }], model: 'gpt-image-2',
  });
});

const compactJsonResponse = (): Response =>
  new Response(JSON.stringify({
    id: 'resp_x',
    object: 'response.compaction',
    model: 'gpt-5.4',
    status: 'completed',
    output: [{ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' }],
    usage: { input_tokens: 550, output_tokens: 167, total_tokens: 717 },
  }), {
    status: 200,
    headers: new Headers({
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    }),
  });

describe('alphaSearch', () => {
  test('posts the search request to the ChatGPT Codex endpoint with selected model and account auth', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      encrypted_output: null,
      output: 'Search result',
      results: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await alphaSearch({

      model,
      body: { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers({ 'x-codex-turn-metadata': '{"turn_id":"turn-search"}' }),

    });

    expect(result.http.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/alpha/search');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('x-codex-turn-metadata')).toBe('{"turn_id":"turn-search"}');
    expect(await readJsonRequest(init)).toMatchObject({
      id: 'search-session',
      model: 'gpt-5.4',
      commands: { search_query: [{ q: 'Floway' }] },
    });
  });
});
