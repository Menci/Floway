import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUpstreamStateRepoStub } from './upstream-state-repo.ts';
import { CODEX_CLI_VERSION, CODEX_ORIGINATOR, CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY, CODEX_RESPONSES_LITE_HEADER, CODEX_USER_AGENT } from '../src/constants.ts';
import { callCodexAlphaSearch, callCodexOpenAIImagesGenerations, callCodexOpenAIResponses, callCodexOpenAIResponsesCompact, type CodexCallEffects } from '../src/fetch.ts';
import * as responsesLite from '../src/responses-lite.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexQuotaSnapshotEntryMap, CodexUpstreamState } from '../src/state.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, type OpenAIResponsesInputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null };
const accessOnlyAccount: CodexAccountCredential = { ...activeAccount, refresh_token: null };
const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { openaiResponses: {} } });
const liteModel = stubProviderModel({ id: 'future-lite-model', endpoints: { openaiResponses: {} }, providerData: { useResponsesLite: true } });
const imageModel = stubProviderModel({ id: 'gpt-image-2', display_name: 'GPT-Image-2', kind: 'image', endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} } });

const upstreamId = 'up_a';
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const farFutureAccessToken: CodexAccessTokenEntry = {
  token: 'at_kv',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'codex',
  name: 'Codex',
  enabled: true,
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
const seedFreshAccessToken = (entry: CodexAccessTokenEntry = farFutureAccessToken): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: entry }] });
};

const seedAccountState = (overrides: Partial<CodexAccountCredential>): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, ...overrides }] });
};

const readQuotaEntry = (): CodexQuotaSnapshotEntryMap | null =>
  (currentRecord.state as CodexUpstreamState).accounts[0].quotaSnapshot;

// putCodexQuota fires-and-forgets via .catch(() => {}); yield to the task
// queue so the saveState promise resolves before the caller asserts on state.
const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: createUpstreamStateRepoStub(() => currentRecord, state => {
      currentRecord = { ...currentRecord, state: state as CodexUpstreamState };
    }),
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
  { headers: { 'content-type': 'text/event-stream', [CODEX_RESPONSES_LITE_HEADER]: 'true', 'x-upstream-custom': 'retained' } },
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

const idTokenWithoutPlan = (): string => [
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {} })).toString('base64url'),
  Buffer.from('signature').toString('base64url'),
].join('.');

describe('callCodexOpenAIResponses — gates', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const result = await callCodexOpenAIResponses({
      upstreamId, account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });
  test('continues to upstream when a cached rate-limited quota snapshot is still open', async () => {
    seedAccountState({
      accessToken: farFutureAccessToken,
      quotaSnapshot: {
        premium: {
          fetchedAt: new Date('2026-06-05T00:00:00.000Z').getTime(),
          data: { observed_at: '2026-06-05T00:00:00.000Z', active_limit: 'premium', ratelimited_until: '2026-06-05T01:00:00.000Z' },
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('callCodexOpenAIResponses — token freshness', () => {
  test('refreshes before call when no cached access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const effects = makeEffects();
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const openaiResponsesInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(openaiResponsesInit.headers).get('authorization')).toBe('Bearer at_new');
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.token).toBe('at_new');
  });

  test('reuses fresh state-cached access token without refreshing', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_kv');
  });

  test('uses an unknown-expiry access-only token until upstream rejection', async () => {
    seedAccountState({
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: null, refreshedAt: 'now' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexOpenAIResponses({
      upstreamId, account: accessOnlyAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_only');
  });

  test('rejects a known-expired access-only token before calling upstream', async () => {
    seedAccountState({
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: Date.now() - 1, refreshedAt: 'now' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await callCodexOpenAIResponses({
      upstreamId, account: accessOnlyAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/expired.*re-import/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('persistTerminalState refresh_failed when /oauth/token returns app_session_terminated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('refresh_failed', expect.stringMatching(/gone/));
  });
});

describe('Codex private Responses wire selection', () => {
  const tool = { type: 'function' as const, name: 'lookup', parameters: { type: 'object' } };

  test.each([true, false, undefined])('catalog flag %s alone selects generate and compact wire formats', async useResponsesLite => {
    seedFreshAccessToken();
    for (const action of ['generate', 'compact'] as const) {
      for (const marker of ['true', 'false', undefined]) {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => action === 'generate' ? sseEventsResponse([]) : compactJsonResponse());
        const body = {
          input: [
            { type: 'message' as const, role: 'user' as const, content: 'hello' },
            // The CLI emits this only with its opt-in reasoning_effort_override feature.
            // https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/session/reasoning_effort.rs#L16-L85
            { type: 'configuration_update', reasoning: { effort: 'disabled' } } as unknown as OpenAIResponsesInputItem,
          ],
          instructions: 'Base', tools: [tool], parallel_tool_calls: true,
          reasoning: { effort: 'future_effort', context: 'current_turn' },
          tool_choice: 'auto' as const,
          text: { verbosity: 'high' as const },
          service_tier: 'future_tier',
          client_metadata: { [CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY]: marker, retained: { future: true } },
          temperature: 0.5,
        };
        const original = structuredClone(body);
        const headers = new Headers(marker === undefined ? {} : { [CODEX_RESPONSES_LITE_HEADER]: marker });
        const call = action === 'generate' ? callCodexOpenAIResponses : callCodexOpenAIResponsesCompact;
        const result = await call({
          upstreamId, account: activeAccount,
          model: { ...model, providerData: useResponsesLite === undefined ? undefined : { useResponsesLite } },
          body, headers, effects: makeEffects(), call: noopUpstreamCallOptions(),
        });
        if (!result.ok) throw new Error('expected a successful response');
        const [url, init] = fetchSpy.mock.lastCall!;
        expect(url).toBe(`https://chatgpt.com/backend-api/codex/responses${action === 'compact' ? '/compact' : ''}`);
        const wire = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
        const wireHeaders = new Headers(init?.headers);
        expect(wireHeaders.get(CODEX_RESPONSES_LITE_HEADER)).toBe(useResponsesLite ? 'true' : null);
        expect(wireHeaders.get('user-agent')).toBe('codex_cli_rs/0.154.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10');
        expect(wireHeaders.get('version')).toBe('0.154.0');
        expect(headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(body).toEqual(original);
        expect(wire.text).toEqual(body.text);
        expect(wire.service_tier).toBe('future_tier');
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
          expect(wire.client_metadata).not.toHaveProperty(CODEX_RESPONSES_LITE_CLIENT_METADATA_KEY);
          expect(wire.tool_choice).toBe('auto');
          expect(wire.stream).toBe(true);
          expect(wire.store).toBe(false);
          expect(result.headers?.get(CODEX_RESPONSES_LITE_HEADER)).toBeNull();
          expect(result.headers?.get('x-upstream-custom')).toBe('retained');
          for await (const _frame of result.events) { /* Drain the actual parser. */ }
        } else {
          for (const field of ['stream', 'store', 'client_metadata', 'temperature', 'tool_choice']) expect(wire).not.toHaveProperty(field);
          expect(result).not.toHaveProperty('headers');
        }
      }
    }
  });

  test.each(['generate', 'compact'] as const)('%s rejects malformed model data and identity collisions before any fetch', async action => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const call = action === 'generate' ? callCodexOpenAIResponses : callCodexOpenAIResponsesCompact;
    const opts = { upstreamId, account: activeAccount, body: { input: [] }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions() };
    await expect(call({ ...opts, model: { ...model, providerData: { useResponsesLite: 'false' } } })).rejects.toThrow('useResponsesLite is not a boolean');
    await expect(call({
      ...opts, model: liteModel,
      body: {
        input: [], tools: [tool, { type: 'namespace', name: 'functions', description: '', tools: [tool] }],
      },
    })).rejects.toThrow('cannot preserve distinct callable identities');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test.each([true, false])('restores known calls and echoes before streaming=%s consumption and preserves future data', async stream => {
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
    const body = { input: [], instructions: 'Base', tools: [tool], parallel_tool_calls: true, reasoning: { effort: 'low', context: 'current_turn' }, stream };
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model: liteModel, body, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    if (!result.ok) throw new Error('expected successful Responses stream');
    expect(result.headers?.get('content-type')).toBe('text/event-stream');
    expect(result.headers?.has(CODEX_RESPONSES_LITE_HEADER)).toBe(false);
    expect(upstream.headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe('true');
    const expectedCall = { ...wireCall } as Record<string, unknown>;
    delete expectedCall.namespace;
    if (stream) {
      const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
      for await (const frame of result.events) frames.push(frame);
      expect(frames[0]).toMatchObject({ type: 'event', event: { item: expectedCall } });
      expect(frames[1]).toEqual({ type: 'event', event: future });
      expect(frames[2]).toMatchObject({ type: 'event', event: { item: expectedCall } });
      expect(frames[3]).toMatchObject({
        type: 'event',
        event: {
          response: {
            ...wireResponse, output: [expectedCall, opaque], instructions: body.instructions, tools: body.tools,
            parallel_tool_calls: false, reasoning: wireResponse.reasoning,
          },
        },
      });
      expect(frames[4]).toEqual({ type: 'done' });
    } else {
      const collected = await collectOpenAIResponsesProtocolEventsToResult(result.events);
      expect(collected).toMatchObject({
        ...wireResponse, output: [expectedCall, opaque], instructions: body.instructions, tools: body.tools,
        parallel_tool_calls: false, reasoning: wireResponse.reasoning,
      });
    }
  });

  test.each([true, false])('keeps effective settings through native SSE with omitted preferences=%s', async omitted => {
    for (const useResponsesLite of [true, false]) {
      seedFreshAccessToken();
      const reasoning = { effort: 'medium', summary: 'detailed', context: 'all_turns', mode: 'future_mode' };
      const resource: OpenAIResponsesResult = {
        id: 'resp_effective', object: 'response', model: model.id, status: 'completed', output: [], error: null, incomplete_details: null,
        parallel_tool_calls: false, reasoning,
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(sseEventsResponse([
        { type: 'response.created', response: { ...resource, status: 'in_progress' } },
        { type: 'response.completed', response: resource },
      ]));
      const requested = { effort: 'low', context: 'current_turn' };
      const result = await callCodexOpenAIResponses({
        upstreamId, account: activeAccount, model: { ...model, providerData: { useResponsesLite } },
        body: { input: [], ...(omitted ? {} : { reasoning: requested, parallel_tool_calls: true }) },
        headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
      });
      if (!result.ok) throw new Error('expected a successful response');
      const wire = await readJsonRequest(fetchSpy.mock.lastCall![1] as RequestInit) as Record<string, unknown>;
      expect(wire.reasoning).toEqual(useResponsesLite ? { ...(omitted ? {} : requested), context: 'all_turns' } : omitted ? undefined : requested);
      let resources = 0;
      for await (const frame of result.events) {
        if (frame.type !== 'event' || (frame.event.type !== 'response.created' && frame.event.type !== 'response.completed')) continue;
        resources++;
        expect(frame.event.response).toMatchObject({ reasoning, parallel_tool_calls: false });
      }
      expect(resources).toBe(2);
    }
  });

  test.each(['top-level', 'input', 'mixed'] as const)('restores echoed compact %s prefixes before the next real provider dispatch', async source => {
    seedFreshAccessToken();
    const opaque = { type: 'compaction', id: 'cmp_item', encrypted_content: 'opaque+encrypted==' };
    const body: responsesLite.CodexResponsesBody = {
      instructions: 'Old instructions',
      ...(source === 'input' ? {} : { tools: [tool] }),
      input: [
        ...(source === 'top-level' ? [] : [{ type: 'additional_tools' as const, role: 'developer' as const, id: 'at_caller', tools: [{ type: 'custom' as const, name: 'patch' }] }]),
        { type: 'message', role: 'user', content: 'Continue' },
      ],
    };
    const wires: Record<string, unknown>[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const wire = await readJsonRequest(init as RequestInit) as Record<string, unknown>;
      wires.push(wire);
      expect(new Headers(init?.headers).get(CODEX_RESPONSES_LITE_HEADER)).toBe('true');
      if (String(url).endsWith('/compact')) {
        // This exact generated-prefix echo is a stipulated backend fixture.
        return Response.json({ id: 'cmp_resource', object: 'response.compaction', output: [...wire.input as unknown[], opaque] });
      }
      return sseEventsResponse([]);
    });
    const opts = { upstreamId, account: activeAccount, model: liteModel, headers: new Headers({ 'thread-id': 'compact-replay-thread' }), effects: makeEffects(), call: noopUpstreamCallOptions() };
    const compact = await callCodexOpenAIResponsesCompact({ ...opts, body });
    if (!compact.ok) throw new Error('expected successful compact response');
    expect(compact.result.output).toEqual([...body.input, opaque]);
    const replay = await callCodexOpenAIResponses({
      ...opts, body: { ...body, instructions: 'New instructions', input: compact.result.output as OpenAIResponsesInputItem[] },
    });
    if (!replay.ok) throw new Error('expected successful replay');
    for await (const _frame of replay.events) { /* Drain the actual parser. */ }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(wires[1]!.input).toEqual([
      (wires[0]!.input as unknown[])[0],
      expect.objectContaining({ type: 'message', content: [{ type: 'input_text', text: 'New instructions' }] }),
      ...body.input.filter(item => item.type !== 'additional_tools'), opaque,
    ]);
  });

  test('repairs compact function/custom identities without touching opaque output', async () => {
    seedFreshAccessToken();
    const opaque = { type: 'compaction', id: 'cmp_original', encrypted_content: 'opaque+encrypted==' };
    const upstream = {
      id: 'cmp_1', object: 'response.compaction',
      output: [
        { type: 'function_call', name: 'patch', namespace: 'functions', call_id: 'c1', arguments: 'apply', status: 'completed' }, opaque,
      ],
      future: { retained: true },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(upstream), { headers: { [CODEX_RESPONSES_LITE_HEADER]: 'true' } }));
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model: liteModel,
      body: { input: [], tools: [{ type: 'custom', name: 'patch' }] }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    if (!result.ok) throw new Error('expected successful compact response');
    expect(result.result).toEqual({
      ...upstream,
      output: [
        { type: 'custom_tool_call', name: 'patch', call_id: 'c1', input: 'apply', status: 'completed' }, opaque,
      ],
    });
  });

  test.each(['generate', 'compact'] as const)('%s reuses prepared bytes, metadata choice, identities and inverse map across 401 retry', async action => {
    seedFreshAccessToken();
    const selectedModel = { ...liteModel, providerData: { useResponsesLite: true } };
    const encode = vi.spyOn(responsesLite, 'encodeCodexResponsesLiteRequest');
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
    const call = action === 'generate' ? callCodexOpenAIResponses : callCodexOpenAIResponsesCompact;
    const result = await call({
      upstreamId, account: activeAccount, model: selectedModel,
      body: { input: [], tools: [tool], instructions: 'Base' }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0]!).input[0].id).toMatch(/^at_/);
    expect(headers[0]!.get('thread-id')).toMatch(UUID_V7_RE);
    expect(headers[0]!.get(CODEX_RESPONSES_LITE_HEADER)).toBe('true');
    expect(headers[1]!.get(CODEX_RESPONSES_LITE_HEADER)).toBe('true');
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
          status, statusText: 'Upstream failure', headers: { 'content-type': 'application/problem+json', 'x-upstream-custom': 'retained', ...(marker === undefined ? {} : { [CODEX_RESPONSES_LITE_HEADER]: marker }) },
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(upstream);
        const call = action === 'generate' ? callCodexOpenAIResponses : callCodexOpenAIResponsesCompact;
        const result = await call({
          upstreamId, account: activeAccount, model: liteModel, body: { input: [] },
          headers: new Headers({ [CODEX_RESPONSES_LITE_HEADER]: 'false' }), effects: makeEffects(), call: noopUpstreamCallOptions(),
        });
        if (result.ok) throw new Error('expected upstream error');
        expect(result.response).toBe(upstream);
        expect(result.response.headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe(marker ?? null);
        expect(result.response.headers.get('content-type')).toBe('application/problem+json');
        expect(result.response.statusText).toBe('Upstream failure');
        expect(await result.response.text()).toBe('upstream bytes\nnot necessarily JSON');
      }
    }
  });
});

describe('callCodexOpenAIResponses — upstream classification', () => {
  test('happy path: 200 → ok:true, quota persisted', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.primary_used_percent).toBe(42);
    expect(stored?.premium.data.ratelimited_until).toBeUndefined();
  });

  test('upstream body has store:false and stream:true forced even if caller passes otherwise', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: false as unknown as true, store: true } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test('builds Codex responses headers and metadata from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model,
      body: {
        input: [],
        stream: true,
        client_metadata: { 'x-codex-installation-id': 'downstream-installation' },
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
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
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CODEX_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CODEX_USER_AGENT);
    expect(headers.get('version')).toBe(CODEX_CLI_VERSION);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('session-id')).toBe('downstream-session');
    expect(headers.get('session_id')).toBeNull();
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
    // 'turn-meta' is not valid JSON; the unparseable blob is dropped and we
    // synthesize from identity instead.
    expect(headers.get('x-codex-turn-metadata')).not.toBe('turn-meta');
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

  test('omits the account header when the account ID is unknown', async () => {
    const account = { ...accessOnlyAccount, chatgptAccountId: null };
    seedAccountState({
      chatgptAccountId: null,
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: null, refreshedAt: 'now' },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexOpenAIResponses({
      upstreamId,
      account,
      model,
      body: { input: [], stream: true },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at_only');
    expect(headers.get('chatgpt-account-id')).toBeNull();
  });

  test('synthesized Codex identity keeps supplied session and fallback window stable while rotating turn ids', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());
    const request = {
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'stable-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexOpenAIResponses>[0];

    await callCodexOpenAIResponses(request);
    await callCodexOpenAIResponses({ ...request, headers: new Headers({ 'session-id': 'stable-session' }) });

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
    expect(firstMetadata.session_id).toBe('stable-session');
    expect(secondMetadata.session_id).toBe('stable-session');
    expect(firstMetadata.thread_id).toBe('stable-session');
    expect(secondMetadata.thread_id).toBe('stable-session');
    expect(firstMetadata.window_id).toBe('stable-session:0');
    expect(secondMetadata.window_id).toBe('stable-session:0');
    expect(firstMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(secondMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(firstMetadata.turn_id).not.toBe(secondMetadata.turn_id);
  });

  test('different sessions produce different synthesized window and turn metadata', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());

    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'session-a' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'session-b' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const firstHeaders = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('x-codex-window-id')).not.toBe(secondHeaders.get('x-codex-window-id'));
    expect(firstHeaders.get('x-codex-turn-metadata')).not.toBe(secondHeaders.get('x-codex-turn-metadata'));
    const firstMetadata = JSON.parse(firstHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    const secondMetadata = JSON.parse(secondHeaders.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(firstMetadata.installation_id).toBe(secondMetadata.installation_id);
    expect(firstMetadata.session_id).toBe('session-a');
    expect(secondMetadata.session_id).toBe('session-b');
    expect(firstMetadata.window_id).toBe('session-a:0');
    expect(secondMetadata.window_id).toBe('session-b:0');
    expect(firstMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(secondMetadata.turn_id).toMatch(UUID_V7_RE);
    expect(firstMetadata.turn_id).not.toBe(secondMetadata.turn_id);
    expect(firstMetadata.request_kind).toBe('turn');
    expect(secondMetadata.request_kind).toBe('turn');
  });

  test('injects prompt_cache_key only when caller leaves it absent', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => sseResponse());

    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: 'caller-cache-key' },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: null },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const injectedBody = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const preservedStringBody = await readJsonRequest(fetchSpy.mock.calls[1][1] as RequestInit) as Record<string, unknown>;
    const preservedNullBody = await readJsonRequest(fetchSpy.mock.calls[2][1] as RequestInit) as Record<string, unknown>;
    expect(injectedBody.prompt_cache_key).toBe('cache-session');
    expect(preservedStringBody.prompt_cache_key).toBe('caller-cache-key');
    expect(preservedNullBody).toHaveProperty('prompt_cache_key', null);
  });

  test('preserves a hyphenated Codex session id for prompt cache', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('cache-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('canonicalizes downstream session_id to the Codex session-id header', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ session_id: 'alias-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('alias-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('prefers downstream session-id over session_id when both are provided', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'canonical-session', session_id: 'alias-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('canonical-session');
    expect(headers.get('session_id')).toBeNull();
  });

  test('generates a Codex session id when the downstream request has none', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toMatch(UUID_V7_RE);
    expect(headers.get('thread-id')).toBe(headers.get('session-id'));
    expect(headers.get('session_id')).toBeNull();
  });

  test('derives the same session id across turns of a stateless conversation', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const turn = {
      upstreamId, account: activeAccount, model,
      body: {
        instructions: 'You are helpful.',
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexOpenAIResponses>[0];
    await callCodexOpenAIResponses(turn);
    await callCodexOpenAIResponses(turn);

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBeNull();
    expect(first).not.toMatch(UUID_V7_RE);
    expect(second).toBe(first);
  });

  test('derives distinct session ids when only the instructions differ', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const call = (instructions: string) => callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await call('You are a pirate.');
    await call('You are a scientist.');

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBe(second);
  });

  test('derives distinct session ids when only the first user message differs', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const call = (content: string) => callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions: 'System.',
        input: [{ type: 'message', role: 'user', content }],
        stream: true,
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await call('topic A');
    await call('topic B');

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBe(second);
  });

  test('uses account.openaiDeviceId as the installation id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const deviceId = '22222222-3333-4444-9555-666666666666';
    await callCodexOpenAIResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: deviceId },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe(deviceId);
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe(deviceId);
  });

  test('prefers a caller-supplied installation id from client_metadata over the account device id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: 'account-device-id' },
      model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-codex-installation-id': 'caller-installation-id' },
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe('caller-installation-id');
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe('caller-installation-id');
  });

  test('passes through caller thread-id and x-client-request-id when distinct from session-id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({
        'session-id': 'sess',
        'thread-id': 'parent-thread',
        'x-client-request-id': 'req-xyz',
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('sess');
    expect(headers.get('thread-id')).toBe('parent-thread');
    expect(headers.get('x-client-request-id')).toBe('req-xyz');
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.session_id).toBe('sess');
    expect(turnMetadata.thread_id).toBe('parent-thread');
  });

  test('merges caller-supplied x-codex-turn-metadata extras over the synthesized blob', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({
        'session-id': 'sess',
        'x-codex-turn-metadata': JSON.stringify({
          turn_started_at_unix_ms: 1700000000000,
          thread_source: 'user',
          parent_thread_id: 'parent-thread',
          turn_id: 'caller-turn',
        }),
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.session_id).toBe('sess');
    expect(turnMetadata.turn_started_at_unix_ms).toBe(1700000000000);
    expect(turnMetadata.thread_source).toBe('user');
    expect(turnMetadata.parent_thread_id).toBe('parent-thread');
    expect(turnMetadata.turn_id).toBe('caller-turn');
    expect(turnMetadata.request_kind).toBe('turn');
    // turn_id propagates to body's client_metadata as well so the three
    // surfaces (header turn_metadata, body client_metadata, body
    // client_metadata.x-codex-turn-metadata) stay consistent.
    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>).turn_id).toBe('caller-turn');
  });

  test('reads the turn-metadata blob from the body before the header', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
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
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
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
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
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
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: {
          'x-codex-turn-metadata': JSON.stringify({ tool_namespaces_info: toolNamespacesInfo, thread_source: 'user' }),
        },
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'sess' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
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

  test('preserves caller client_metadata extras while keeping identity-mirror keys gateway-owned', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-extra-key': 'caller-supplied', session_id: '   ' },
      } as unknown as Parameters<typeof callCodexOpenAIResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'header-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const body = await readJsonRequest(fetchSpy.mock.calls[0][1] as RequestInit) as Record<string, unknown>;
    const clientMetadata = body.client_metadata as Record<string, unknown>;
    // Non-identity extras pass through verbatim.
    expect(clientMetadata['x-extra-key']).toBe('caller-supplied');
    // A mirrored key identity could not absorb — a blank `session_id` resolves
    // to nothing, so identity falls back to the header — still comes from
    // identity instead of being spread over it.
    expect(clientMetadata.session_id).toBe('header-session');
    expect(clientMetadata.thread_id).toBe('header-session');
    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session-id')).toBe('header-session');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('access-only 401 preserves the upstream response and does not refresh', async () => {
    seedAccountState({
      refresh_token: null,
      accessToken: { token: 'at_only', expiresAt: null, refreshedAt: 'now' },
    });
    const upstreamBody = { error: { code: 'token_invalidated', message: 're-import required' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, upstreamBody, { 'x-upstream-marker': 'kept' }));
    const persistTerminalState = vi.fn(async () => { throw new Error('state write failed'); });
    const result = await callCodexOpenAIResponses({
      upstreamId, account: accessOnlyAccount,
      model, body: { input: [], stream: true }, headers: new Headers(),
      effects: { ...makeEffects(), persistTerminalState }, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get('x-upstream-marker')).toBe('kept');
      expect(await result.response.json()).toEqual(upstreamBody);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(persistTerminalState).toHaveBeenCalledWith('session_terminated', 're-import required');
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached', resets_in_seconds: 7200 } }, {
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });

  test('retains a newly observed plan when the 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free'), expires_in: 600 }))
      .mockResolvedValueOnce(sseResponse(401))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan(), expires_in: 600 }))
      .mockResolvedValueOnce(sseResponse());
    const result = await callCodexOpenAIResponses({
      upstreamId, account: activeAccount, model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });
});

describe('callCodexOpenAIResponses — background-write registration', () => {
  // Background state writes (quota snapshot on 2xx/429, access-token put on
  // 401-retry) must reach the runtime's waitUntil slot so workerd does not
  // cancel them the instant the streaming response returns to the client.
  // Without this, freshly-minted Codex tokens and quota snapshots get dropped
  // on the floor and the next request re-mints / re-races the upstream.
  test('2xx persists quota snapshot via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  test('401-retry persists the fresh access token before returning', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexOpenAIResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    // The access-token write is awaited because its CAS result carries the
    // effective plan; only the successful retry's quota write is backgrounded.
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.token).toBe('at2');
  });
});

describe('callCodexOpenAIImagesGenerations', () => {
  test('does not replace a meaningful quota snapshot with a headerless image response', async () => {
    const quotaSnapshot: CodexQuotaSnapshotEntryMap = {
      premium: {
        fetchedAt: 1,
        data: { observed_at: '2026-01-01T00:00:00Z', active_limit: 'premium', primary_used_percent: 42 },
      },
    };
    seedAccountState({ accessToken: { ...farFutureAccessToken, planType: 'plus' }, quotaSnapshot });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(result.response.status).toBe(200);
    expect(readQuotaEntry()).toEqual(quotaSnapshot);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test('keeps image turn identity and originator stable across a 401 refresh retry', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('plus'), expires_in: 600 }))
      .mockResolvedValueOnce(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers({ originator: 'chatgpt_cca' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    const imageCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'));
    expect(imageCalls).toHaveLength(2);
    const firstHeaders = new Headers((imageCalls[0][1] as RequestInit).headers);
    const secondHeaders = new Headers((imageCalls[1][1] as RequestInit).headers);
    expect(firstHeaders.get('originator')).toBe('chatgpt_cca');
    expect(secondHeaders.get('originator')).toBe('chatgpt_cca');
    for (const headers of [firstHeaders, secondHeaders]) {
      expect(headers.get('version')).toBe(CODEX_CLI_VERSION);
      expect(headers.get('user-agent')).toBe(CODEX_USER_AGENT);
    }
    expect(firstHeaders.get('x-codex-image-turn-id')).toMatch(UUID_V7_RE);
    expect(secondHeaders.get('x-codex-image-turn-id')).toBe(firstHeaders.get('x-codex-image-turn-id'));
  });

  test('uses a refreshed Free plan before dispatching the image request', async () => {
    seedAccountState({ accessToken: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(200, {
      access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'), expires_in: 600,
    }));
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/oauth/token');
  });

  test('stops a 401 retry when the refreshed plan becomes Free', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, {
        access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken('free'), expires_in: 600,
      }));
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'))).toHaveLength(1);
  });

  test('does not invalidate a sibling token that won before the 401 was handled', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, token: 'at_failed', planType: 'plus' });
    const winner: CodexAccessTokenEntry = {
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
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: { ...activeAccount, accessToken: { ...farFutureAccessToken, token: 'at_failed', planType: 'plus' } },
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'plus',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(403);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken).toEqual(winner);
  });

  test('keeps the latest known plan when a retry refresh omits the plan claim', async () => {
    seedFreshAccessToken({ ...farFutureAccessToken, planType: 'plus' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, {
        access_token: 'at2', refresh_token: 'rt_v2', id_token: idTokenWithoutPlan(), expires_in: 600,
      }))
      .mockResolvedValueOnce(errorJson(200, { created: 1, data: [{ b64_json: 'aW1hZ2U=' }] }));
    const result = await callCodexOpenAIImagesGenerations({
      upstreamId,
      account: (currentRecord.state as CodexUpstreamState).accounts[0],
      model: imageModel,
      body: { prompt: 'an orange circle' },
      fallbackPlanType: 'free',
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes('/images/generations'))).toHaveLength(2);
    await flushMicrotasks();
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('plus');
  });
});

// `callCodexOpenAIResponsesCompact` shares OAuth + quota + 401-retry plumbing with
// `callCodexOpenAIResponses` (both go through `prepareCodexCall` →
// `dispatchCodexHttpCall` → `refreshAccessTokenForRetry`). The streaming
// suite above pins those shared paths; this block exercises only the
// compact-specific wire contract — endpoint URL, `Accept: application/json`,
// body shape (no `stream`, no `store`), unary JSON decoding — plus the 401
// retry on the unary endpoint to confirm the retry decision is taken from
// the bare response status (no SSE wrap in the path).
const compactJsonResponse = (overrides?: Partial<OpenAIResponsesResult>): Response =>
  new Response(JSON.stringify({
    id: 'resp_x',
    object: 'response.compaction',
    model: 'gpt-5.4',
    status: 'completed',
    output: [{ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' }],
    usage: { input_tokens: 550, output_tokens: 167, total_tokens: 717 },
    ...overrides,
  }), {
    status: 200,
    headers: new Headers({
      'content-type': 'application/json',
      'x-codex-primary-used-percent': '42',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-after-seconds': '18000',
    }),
  });

describe('callCodexOpenAIResponsesCompact', () => {
  test('posts to /codex/responses/compact with application/json and no stream/store', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [{ type: 'message', role: 'user', content: 'hello' }] },
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer at_kv');

    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.4');
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: 'hello' }]);
    expect(body.stream).toBeUndefined();
    expect(body.store).toBeUndefined();

    expect(result.result.object).toBe('response.compaction');
    expect(result.result.output[0]).toMatchObject({ id: 'cmp_x', type: 'compaction', encrypted_content: 'FULL_BLOB' });
  });

  test('2xx persists quota snapshot via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  test('401 other → refresh + retry once on the compact endpoint, succeed', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: idToken(), expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(compactJsonResponse());
    const effects = makeEffects();
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    // Both compact requests hit the same URL; the bearer flipped from at_kv to at2.
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(new Headers((fetchSpy.mock.calls[2][1] as RequestInit).headers).get('authorization')).toBe('Bearer at2');
  });

  test('retains a newly observed plan when the compact 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free'), expires_in: 600 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan(), expires_in: 600 }))
      .mockResolvedValueOnce(compactJsonResponse());
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId,
      account: activeAccount,
      model,
      body: { input: [], instructions: 'compact' },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return synthetic 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('429 → quota with ratelimited_until, return upstream 429', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'usage_limit_reached', message: 'cap reached' } }, {
      'x-codex-active-limit': 'premium',
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.premium.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through verbatim without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexOpenAIResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });

});

describe('callCodexAlphaSearch', () => {
  test('posts the search request to the ChatGPT Codex endpoint with selected model and account auth', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      encrypted_output: null,
      output: 'Search result',
      results: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      model,
      body: { id: 'search-session', commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers({ 'x-codex-turn-metadata': '{"turn_id":"turn-search"}' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    expect(result.response.status).toBe(200);
    expect(result.modelKey).toBe('gpt-5.4');
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

  test('retains a newly observed plan when the search 401 refresh omits it', async () => {
    seedAccountState({ accessToken: null });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at1', refresh_token: 'rt1', id_token: idToken('free'), expires_in: 600 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(errorJson(200, { access_token: 'at2', refresh_token: 'rt2', id_token: idTokenWithoutPlan(), expires_in: 600 }))
      .mockResolvedValueOnce(errorJson(200, { encrypted_output: null, output: 'Search result', results: [] }));
    const result = await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      model,
      body: { commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.response.status).toBe(200);
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.planType).toBe('free');
  });

  test('normalizes a missing request id and omits absent turn metadata', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ output: 'Search result' }), { status: 200 }));

    await callCodexAlphaSearch({
      upstreamId,
      account: activeAccount,
      model,
      body: { commands: { search_query: [{ q: 'Floway' }] } },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    const body = await readJsonRequest(init) as Record<string, unknown>;
    expect(headers.has('x-codex-turn-metadata')).toBe(false);
    expect(typeof body.id).toBe('string');
    expect(headers.get('session-id')).toBe(body.id);
    expect(headers.get('thread-id')).toBe(body.id);
    expect(headers.get('x-client-request-id')).toBe(body.id);
  });
});
