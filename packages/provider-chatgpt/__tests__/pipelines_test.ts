import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub } from './upstream-state-repo.ts';
import { toChatGPTUpstreamFacts, type ChatGPTUpstreamFacts } from '../src/config.ts';
import { CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../src/constants.ts';
import { chatgptPipelines } from '../src/pipelines.ts';
import * as responsesLite from '../src/responses-lite.ts';
import { createChatGPTService } from '../src/service.ts';
import type { ChatGPTAccessTokenEntry, ChatGPTAccountCredential, ChatGPTQuotaSnapshotEntryMap, ChatGPTUpstreamState } from '../src/state.ts';
import { isManagedStream, run, type RunDone, type RunEvent } from '@floway-dev/pipeline';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { type OpenAIResponsesCompactionItemEx, collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesInputItem, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { directFetcher, getProviderRepo, httpUrl, initProviderRepo, toProviderModelFacts, UpstreamTransportError, type ProviderBaseOutput, type ProviderFrame, type ProviderInput, type ProviderOpenAIResponsesOutput, type ProviderResponsesInput, type UpstreamRecord } from '@floway-dev/provider';
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

// Mirrors what the data-plane refresh hook persists when a fresh token arrives.
const seedFreshAccessToken = (entry: ChatGPTAccessTokenEntry = farFutureAccessToken): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: entry }] });
};

const seedAccountState = (overrides: Partial<ChatGPTAccountCredential>): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, ...overrides }] });
};

const storedAccount = (): ChatGPTAccountCredential =>
  (currentRecord.state as ChatGPTUpstreamState).accounts[0];
const readQuotaEntry = (): ChatGPTQuotaSnapshotEntryMap | null => storedAccount().quotaSnapshot;

const expectPersistenceFailure = (trace: RunEvent[], name: string, message: string): void => {
  const deferred = trace.find(event => event.k === 'deferred' && event.name === name);
  if (deferred?.k !== 'deferred') throw new Error(`expected deferred ${name}`);
  expect(trace).toContainEqual(expect.objectContaining({
    k: 'settled', deferredId: deferred.deferredId, ok: true, value: expect.objectContaining({ persisted: false, error: expect.objectContaining({ message }) }),
  }));
  expect(trace).toContainEqual(expect.objectContaining({ k: 'log', level: 'warn', message: `${name} persistence failed` }));
};

interface RunInput<Payload> {
  upstreamId: string;
  model: ReturnType<typeof stubProviderModel>;
  body: Payload;
  headers: Headers;
  events?: (event: RunEvent) => void;
}

const setup = <Payload>(options: RunInput<Payload>) => ({
  pipelines: chatgptPipelines,
  facts: {
    'provider.model': toProviderModelFacts(structuredClone(options.model)),
    'provider.upstream': toChatGPTUpstreamFacts({ ...makeRecord({ accounts: [activeAccount] }), id: options.upstreamId }),
    'request.http': { method: 'POST', url: httpUrl('http://floway.test'), headers: [...options.headers], body: null },
    'request.payload': options.body,
  } satisfies ProviderInput<ChatGPTUpstreamFacts, Payload>,
  options: { services: { fetcher: () => directFetcher, chatgpt: createChatGPTService() }, finalizationTimeoutMs: 1000, ...(options.events ? { events: options.events } : {}) },
});

type ResponsesBody = ProviderResponsesInput['request.payload'];

const runResponsesAction = async (input: RunInput<ResponsesBody>, action: ProviderResponsesInput['request.action']) => {
  const { pipelines, facts, options } = setup(input);
  const handle = run(pipelines.openaiResponses, { ...facts, 'request.action': action }, options);
  return { ...await handle.result, done: handle.done };
};
const runResponses = (input: RunInput<ResponsesBody>) => runResponsesAction(input, 'generate');
const runCompact = (input: RunInput<ResponsesBody>) => runResponsesAction(input, 'compact');
const runImages = async (input: RunInput<Omit<OpenAIImagesGenerationsPayload, 'model'>>) => {
  const { pipelines, facts, options } = setup(input);
  const handle = run(pipelines.openaiImagesGenerations, facts, options);
  return { ...await handle.result, done: handle.done };
};
const runAlphaSearch = async (input: RunInput<Record<string, unknown>>) => {
  const { pipelines, facts, options } = setup(input);
  const handle = run(pipelines.alphaSearch, facts, options);
  return { ...await handle.result, done: handle.done };
};
const successful = ({ 'response.http': { status } }: ProviderBaseOutput): boolean => status >= 200 && status < 300;
const headersOf = ({ 'response.http': { headers } }: ProviderBaseOutput): Headers =>
  new Headers(headers.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
const release = async (result: ProviderBaseOutput & Partial<ProviderOpenAIResponsesOutput> & { done: Promise<RunDone> }) => {
  const outcome = result['response.openaiResponses'];
  const body = outcome?.kind === 'stream' ? outcome.events : result['response.http'].body;
  if (isManagedStream(body)) await body.close();
  expect(await result.done).toEqual({ ok: true });
};
const responsesEvents = (result: ProviderOpenAIResponsesOutput) => {
  const outcome = result['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('expected a Responses stream');
  return outcome.events;
};

const protocolEvents = async function* (result: ProviderOpenAIResponsesOutput) {
  for await (const frame of responsesEvents(result)) {
    if (frame.type === 'transport-error') throw new Error(frame.error.message);
    yield frame;
  }
};

const inspectResponsesWire = async (input: RunInput<ResponsesBody>) => {
  await release(await runResponses(input));
};

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  const upstreams = createUpstreamStateRepoStub(() => currentRecord, state => {
    currentRecord = { ...currentRecord, state: state as ChatGPTUpstreamState };
  });
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams,
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (status = 200): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\n'));
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

const sseEventsResponse = (events: Record<string, unknown>[]): Response => new Response(
  `${events.map(event => `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`,
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

describe('ChatGPT Responses gates', () => {
  test('refuses non-active stored state with a local 503', async () => {
    seedAccountState({ state: 'session_terminated' });
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(503);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'local' });
    await release(result);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('refuses a deleted upstream before any network request', async () => {
    vi.spyOn(getProviderRepo().upstreams, 'getById').mockResolvedValueOnce(null);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const result = await runResponses({ upstreamId, model, body: { input: [] }, headers: new Headers() });
    expect(result['response.http'].status).toBe(503);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'local' });
    await release(result);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('replaces the same family after a local restriction expires, preserving other families', async () => {
    const until = new Date(Date.now() - 1000).toISOString();
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
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(successful(result)).toBe(true);
    await release(result);
    expect(readQuotaEntry()?.premium.data.primary_used_percent).toBe(42);
    expect(readQuotaEntry()?.premium.data.ratelimited_until).toBeUndefined();
    expect(readQuotaEntry()?.other).toEqual(unrelated);
  });

  test('quota write failures settle as data while the response run completes', async () => {
    seedFreshAccessToken();
    vi.spyOn(getProviderRepo().upstreams, 'saveState').mockRejectedValue(new Error('quota write failed'));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const trace: RunEvent[] = [];
    const result = await runResponses({
      upstreamId,
      model, body: { input: [] }, headers: new Headers(), events: event => { trace.push(event); },
    });
    await release(result);
    expectPersistenceFailure(trace, 'chatgpt-quota', 'quota write failed');
  });
});

describe('ChatGPT terminal output recovery', () => {
  test('restores native compaction before stream and result consumption', async () => {
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
      const result = await runResponses({
        upstreamId, model,
        body: { input: [{ type: 'compaction_trigger' } as unknown as CanonicalOpenAIResponsesInputItem], stream },
        headers: new Headers(),
      });
      if (!successful(result)) throw new Error('expected a successful native compaction stream');
      if (stream) {
        const frames: ProviderFrame<OpenAIResponsesStreamEventEx>[] = [];
        for await (const frame of responsesEvents(result)) frames.push(frame);
        expect(frames[0]).toMatchObject({ event: { response: { output: [], status: 'in_progress' } } });
        expect(frames[3]).toMatchObject({ event: { type: 'response.compaction.compacting', item_id: item.id } });
        expect(frames[4]).toMatchObject({ event: { type: 'response.output_item.done', output_index: 0, item } });
        expect(frames[5]).toMatchObject({ event: { type: 'response.completed', response: { ...terminal, output: [item] } } });
        expect(frames[6]).toEqual({ type: 'done' });
      } else {
        expect(await collectOpenAIResponsesProtocolEventsToResult(protocolEvents(result))).toMatchObject({ ...terminal, output: [item] });
      }
      expect(await result.done).toEqual({ ok: true });
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
        const original = structuredClone(body);
        const headers = new Headers(marker === undefined ? {} : { [CHATGPT_RESPONSES_LITE_HEADER]: marker });
        const call = action === 'generate' ? runResponses : runCompact;
        const result = await call({
          upstreamId,
          model: { ...model, providerData: { useResponsesLite } },
          body, headers,
        });
        if (!successful(result)) throw new Error('expected a successful response');
        const [url, init] = fetchSpy.mock.lastCall!;
        expect(url).toBe(`https://chatgpt.com/backend-api/codex/responses${action === 'compact' ? '/compact' : ''}`);
        const wire = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
        const wireHeaders = new Headers(init?.headers);
        expect(wireHeaders.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(useResponsesLite ? 'true' : null);
        expect(wireHeaders.get('user-agent')).toBe('codex_cli_rs/0.169.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10');
        expect(wireHeaders.get('version')).toBe('0.169.0');
        expect(headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(body).toEqual(original);
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
        if (result['response.openaiResponses'].kind === 'stream') {
          expect(wire.client_metadata).toMatchObject({ retained: { future: true } });
          expect(wire.client_metadata).not.toHaveProperty(CHATGPT_RESPONSES_LITE_CLIENT_METADATA_KEY);
          expect(wire.tool_choice).toBe('auto');
          expect(wire.stream).toBe(true);
          expect(wire.store).toBe(false);
          expect(headersOf(result).get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
          expect(headersOf(result).get('x-upstream-custom')).toBe('retained');
          await release(result);
        } else {
          for (const field of ['stream', 'store', 'client_metadata', 'temperature', 'tool_choice']) expect(wire).not.toHaveProperty(field);
          expect(result['response.http'].body).toBeNull();
          expect(result['response.openaiResponses'].kind).toBe('result');
          expect(await result.done).toEqual({ ok: true });
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
    const result = await runResponses({
      upstreamId, model: liteModel, body, headers: new Headers(),
    });
    if (!successful(result)) throw new Error('expected successful Responses stream');
    expect(headersOf(result).get('content-type')).toBe('text/event-stream');
    expect(headersOf(result).has(CHATGPT_RESPONSES_LITE_HEADER)).toBe(true);
    expect(upstream.headers.get(CHATGPT_RESPONSES_LITE_HEADER)).toBe('true');
    const frames: ProviderFrame<OpenAIResponsesStreamEventEx>[] = [];
    for await (const frame of responsesEvents(result)) frames.push(frame);
    expect(frames[0]).toMatchObject({ type: 'event', event: { item: wireCall } });
    expect(frames[1]).toEqual({ type: 'event', event: future });
    expect(frames[2]).toMatchObject({ type: 'event', event: { item: wireCall } });
    expect(frames[3]).toMatchObject({ type: 'event', event: { response: { ...wireResponse, tools: body.tools, instructions: body.instructions } } });
    expect(frames[4]).toEqual({ type: 'done' });
    expect(await result.done).toEqual({ ok: true });
  });

  test('preserves the complete compact output window around a caller-positioned tools carrier', async () => {
    seedFreshAccessToken();
    const opaque = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' };
    const body: responsesLite.ChatGPTResponsesBody = {
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
    const opts = { upstreamId, model: liteModel, headers: new Headers({ 'thread-id': 'compact-replay-thread' }) };
    const compact = await runCompact({ ...opts, body });
    if (!successful(compact)) throw new Error('expected successful compact response');
    expect(compact['response.openaiResponses']).toMatchObject({ kind: 'result', result: { output: [...sentInput!, opaque] } });
    await release(compact);
  });

  test.each(['generate', 'compact'] as const)('%s reuses prepared bytes and metadata choice across 401 retry', async action => {
    seedFreshAccessToken();
    const selectedModel = { ...liteModel, providerData: { useResponsesLite: true } };
    const encode = vi.spyOn(responsesLite, 'encodeChatGPTResponsesLiteRequest');
    const bodies: string[] = [];
    const headers: Headers[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'at_retry', refresh_token: 'rt_retry', expires_in: 600, id_token: idToken() }));
      bodies.push(await new Response(init?.body).text());
      headers.push(new Headers(init?.headers));
      if (bodies.length === 1) {
        selectedModel.providerData.useResponsesLite = false;
        return errorJson(401, { error: { code: 'expired_token', message: 'expired' } });
      }
      return action === 'generate' ? sseEventsResponse([]) : compactJsonResponse();
    });
    const call = action === 'generate' ? runResponses : runCompact;
    const result = await call({
      upstreamId, model: selectedModel,
      body: { input: [], tools: [tool], instructions: 'Base' }, headers: new Headers(),
    });
    expect(successful(result)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(encode).toHaveBeenCalledTimes(1);
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
    await release(result);
  });

  test.each(['generate', 'compact'] as const)('%s preserves non-OK upstream status and headers with a synthesized protocol error', async action => {
    seedFreshAccessToken();
    for (const status of [400, 429, 503]) {
      for (const marker of [undefined, 'true', 'false']) {
        const upstream = new Response('upstream bytes\nnot necessarily JSON', {
          status, statusText: 'Upstream failure', headers: { 'content-type': 'application/problem+json', 'x-upstream-custom': 'retained', ...(marker === undefined ? {} : { [CHATGPT_RESPONSES_LITE_HEADER]: marker }) },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstream);
        const call = action === 'generate' ? runResponses : runCompact;
        const result = await call({
          upstreamId, model: liteModel, body: { input: [] },
          headers: new Headers({ [CHATGPT_RESPONSES_LITE_HEADER]: 'false' }),
        });
        if (successful(result)) throw new Error('expected upstream error');
        expect(result['response.http'].status).toBe(status);
        expect(headersOf(result).get(CHATGPT_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(headersOf(result).get('content-type')).toBe('application/problem+json');
        expect(result['response.http'].statusText).toBe('Upstream failure');
        expect(result['response.openaiResponses']).toEqual({ kind: 'error', source: 'upstream', error: { error: { type: 'upstream_error', message: 'upstream bytes\nnot necessarily JSON' } } });
        expect(result['response.http'].body).toBeNull();
        expect(await result.done).toEqual({ ok: true });
      }
    }
  });
});

describe('ChatGPT Responses upstream classification', () => {
  test('builds Codex responses headers and metadata from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await inspectResponsesWire({
      upstreamId,
      model,
      body: {
        input: [],
        stream: true,
        client_metadata: { 'x-codex-installation-id': 'downstream-installation' },
      } as unknown as Parameters<typeof runResponses>[0]['body'],
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
      upstreamId, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'stable-session' }),
    } satisfies Parameters<typeof runResponses>[0];

    await inspectResponsesWire(request);
    await inspectResponsesWire({ ...request, headers: new Headers({ 'session-id': 'stable-session' }) });

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

    await inspectResponsesWire({
      upstreamId, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),
    });
    await inspectResponsesWire({
      upstreamId, model,
      body: { input: [], stream: true, prompt_cache_key: 'caller-cache-key' },
      headers: new Headers({ 'session-id': 'cache-session' }),
    });
    await inspectResponsesWire({
      upstreamId, model,
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
    await inspectResponsesWire({
      upstreamId, model,
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
      } as unknown as Parameters<typeof runResponses>[0]['body'],
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
    await inspectResponsesWire({
      upstreamId, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({ tool_namespaces_info: toolNamespacesInfo, thread_source: 'user' }),
        },
      } as unknown as Parameters<typeof runResponses>[0]['body'],
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
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(503);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'upstream' });
    await release(result);
    expect(storedAccount()).toMatchObject({ state: 'session_terminated', state_message: 'session ended', accessToken: null });
  });

  test('access-only 401 preserves the upstream response and does not refresh', async () => {
    seedAccountState({
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: null, refreshedAt: 'now' },
    });
    const upstreamBody = { error: { code: 'token_invalidated', message: 're-import required' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, upstreamBody, { 'x-upstream-marker': 'kept' }));
    vi.spyOn(getProviderRepo().upstreams, 'saveState').mockRejectedValueOnce(new Error('state write failed'));
    const trace: RunEvent[] = [];
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
      events: event => { trace.push(event); },
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) {
      expect(result['response.http'].status).toBe(401);
      expect(headersOf(result).get('x-upstream-marker')).toBe('kept');
      expect(result['response.openaiResponses']).toEqual({ kind: 'error', source: 'upstream', error: upstreamBody });
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await result.done).toEqual({ ok: true });
    expectPersistenceFailure(trace, 'chatgpt-terminal-state', 'state write failed');
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(401);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'upstream' });
    expect(storedAccount()).toMatchObject({ refresh_token: 'rt_v2', accessToken: { token: 'at2' } });
    await release(result);
  });

  test('OAuth session failure returns an upstream error and persists terminal state', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, {
      error: { code: 'invalid_grant', message: 'refresh credential revoked' },
    }));
    const result = await runResponses({ upstreamId, model, body: { input: [] }, headers: new Headers() });
    expect(result['response.http'].status).toBe(503);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'upstream' });
    await release(result);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(storedAccount()).toMatchObject({ state: 'refresh_failed', state_message: 'refresh credential revoked', accessToken: null });
  });

  test.each(['oauth', 'first response', '401 body', 'retry oauth', 'retry response'] as const)(
    '%s transport failure completes with an upstream error',
    async where => {
      if (where !== 'oauth') seedFreshAccessToken();
      const error = new UpstreamTransportError(new Error('socket dropped'));
      const fetch = vi.spyOn(globalThis, 'fetch');
      if (where === '401 body') {
        fetch.mockResolvedValueOnce(new Response(new ReadableStream({ start: controller => controller.error(error) }), { status: 401 }));
      } else {
        if (where === 'retry oauth' || where === 'retry response') {
          fetch.mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token' } }));
        }
        if (where === 'retry response') {
          fetch.mockResolvedValueOnce(errorJson(200, { access_token: 'at_retry', refresh_token: 'rt_retry', expires_in: 600 }));
        }
        fetch.mockRejectedValueOnce(error);
      }

      const result = await runResponses({ upstreamId, model, body: { input: [] }, headers: new Headers() });
      expect(result['response.http']).toMatchObject({ status: 502, body: null, transportError: { message: 'socket dropped' } });
      expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'upstream' });
      await release(result);
      expect(fetch).toHaveBeenCalledTimes(where === 'retry response' ? 3 : where === 'retry oauth' ? 2 : 1);
      expect(storedAccount().state).toBe('active');
    },
  );

  test.each(['generate', 'compact'] as const)('%s invalid 2xx payload completes with an upstream error', async action => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('broken upstream payload', { headers: { 'content-type': 'text/plain' } }));
    const result = await runResponsesAction({ upstreamId, model, body: { input: [] }, headers: new Headers() }, action);
    expect(result['response.http'].status).toBe(502);
    expect(result['response.openaiResponses']).toMatchObject({
      kind: 'error', source: 'upstream', error: { error: { message: expect.stringContaining('broken upstream payload') } },
    });
    await release(result);
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached', resets_in_seconds: 7200 } }, {
      'x-codex-primary-used-percent': '100',
      'x-codex-secondary-used-percent': '35',
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await runResponses({
      upstreamId,
      model, body: { input: [], stream: true }, headers: new Headers(),
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(429);
    expect(result['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'upstream' });
    await release(result);
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBe(new Date(Date.parse(stored!.premium.data.observed_at) + 3600 * 1000).toISOString());
    const blocked = await runResponses({ upstreamId, model, body: { input: [] }, headers: new Headers() });
    expect(blocked['response.http'].status).toBe(429);
    const retryAfter = Number(headersOf(blocked).get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(blocked['response.openaiResponses']).toMatchObject({ kind: 'error', source: 'local' });
    await release(blocked);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});

describe('ChatGPT image generation', () => {
  test('does not replace a meaningful quota snapshot with a headerless image response', async () => {
    const quotaSnapshot: ChatGPTQuotaSnapshotEntryMap = {
      premium: {
        fetchedAt: 1,
        data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'premium', primary_used_percent: 42 },
      },
    };
    seedAccountState({ accessToken: { ...farFutureAccessToken, planType: 'plus' }, quotaSnapshot });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await runImages({
      upstreamId,
      model: imageModel,
      body: { prompt: 'an orange circle' },
      headers: new Headers(),
    });
    expect(result['response.http'].status).toBe(200);
    expect(readQuotaEntry()).toEqual(quotaSnapshot);
    expect(result['response.openaiImagesGenerations']).toEqual({ kind: 'ok' });
    await release(result);
  });

  test('uses a refreshed Free plan before dispatching the image request', async () => {
    seedAccountState({ accessToken: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(200, {
      access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'), expires_in: 600,
    }));
    const result = await runImages({
      upstreamId,
      model: imageModel,
      body: { prompt: 'an orange circle' },
      headers: new Headers(),
    });
    expect(result['response.http'].status).toBe(403);
    await release(result);
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
    const result = await runImages({
      upstreamId,
      model: imageModel,
      body: { prompt: 'an orange circle' },
      headers: new Headers(),
    });
    expect(result['response.http'].status).toBe(403);
    await release(result);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as ChatGPTUpstreamState).accounts[0].accessToken).toEqual(winner);
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

describe('ChatGPT Alpha Search', () => {
  test('posts the search request to the ChatGPT Codex endpoint with selected model and account auth', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      encrypted_output: null,
      output: 'Search result',
      results: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await runAlphaSearch({
      upstreamId,
      model,
      body: { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers({ 'x-codex-turn-metadata': '{"turn_id":"turn-search"}' }),
    });

    expect(result['response.http'].status).toBe(200);
    expect(result['response.modelKey']).toBe('gpt-5.4');
    await release(result);
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
