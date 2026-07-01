import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from './constants.ts';
import { callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from './fetch.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexQuotaSnapshotEntry, CodexUpstreamState } from './state.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', openaiDeviceId: '11111111-2222-4333-8444-555555555555', accessToken: null, quotaSnapshot: null };
const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } });

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
});

let currentRecord: UpstreamRecord;

// Mirrors what the data-plane refresh hook persists when a fresh token arrives.
const seedFreshAccessToken = (entry: CodexAccessTokenEntry = farFutureAccessToken): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, accessToken: entry }] });
};

const seedAccountState = (overrides: Partial<CodexAccountCredential>): void => {
  currentRecord = makeRecord({ accounts: [{ ...activeAccount, ...overrides }] });
};

const readQuotaEntry = (): CodexQuotaSnapshotEntry | null =>
  (currentRecord.state as CodexUpstreamState).accounts[0].quotaSnapshot;

// putCodexQuota fires-and-forgets via .catch(() => {}); yield to the task
// queue so the saveState promise resolves before the caller asserts on state.
const flushMicrotasks = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as CodexUpstreamState };
        return { updated: true };
      },
    },
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

const errorJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: new Headers({ 'content-type': 'application/json', ...extraHeaders }) });

describe('callCodexResponses — gates', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const result = await callCodexResponses({
      upstreamId, account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('refuses while rate-limited window is open', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-06-05T00:30:00.000Z'));
    seedAccountState({
      quotaSnapshot: {
        fetchedAt: new Date('2026-06-05T00:00:00.000Z').getTime(),
        data: { observed_at: '2026-06-05T00:00:00.000Z', ratelimited_until: '2026-06-05T01:00:00.000Z' },
      },
    });
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('retry-after')).toBeTruthy();
    }
  });
});

describe('callCodexResponses — token freshness', () => {
  test('refreshes before call when no cached access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const responsesInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(responsesInit.headers).get('authorization')).toBe('Bearer at_new');
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    expect((currentRecord.state as CodexUpstreamState).accounts[0].accessToken?.token).toBe('at_new');
  });

  test('reuses fresh state-cached access token without refreshing', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('authorization')).toBe('Bearer at_kv');
  });

  test('persistTerminalState refresh_failed when /oauth/token returns app_session_terminated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('refresh_failed', expect.stringMatching(/gone/));
  });
});

describe('callCodexResponses — upstream classification', () => {
  test('happy path: 200 → ok:true, quota persisted', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.data.primary_used_percent).toBe(42);
    expect(stored?.data.ratelimited_until).toBeUndefined();
  });

  test('upstream body has store:false and stream:true forced even if caller passes otherwise', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: false as unknown as true, store: true } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-5.4');
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  test('builds Codex responses headers and metadata from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model,
      body: {
        input: [],
        stream: true,
        client_metadata: { 'x-codex-installation-id': 'downstream-installation' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
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

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
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
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'stable-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexResponses>[0];

    await callCodexResponses(request);
    await callCodexResponses({ ...request, headers: new Headers({ 'session-id': 'stable-session' }) });

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

    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'session-a' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
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

    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: 'caller-cache-key' },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: { input: [], stream: true, prompt_cache_key: null },
      headers: new Headers({ 'session-id': 'cache-session' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const injectedBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    const preservedStringBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as Record<string, unknown>;
    const preservedNullBody = JSON.parse((fetchSpy.mock.calls[2][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(injectedBody.prompt_cache_key).toBe('cache-session');
    expect(preservedStringBody.prompt_cache_key).toBe('caller-cache-key');
    expect(preservedNullBody).toHaveProperty('prompt_cache_key', null);
  });

  test('preserves a hyphenated Codex session id for prompt cache', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
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
    await callCodexResponses({
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
    await callCodexResponses({
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
    await callCodexResponses({
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
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    } satisfies Parameters<typeof callCodexResponses>[0];
    await callCodexResponses(turn);
    await callCodexResponses(turn);

    const first = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers).get('session-id');
    const second = new Headers((fetchSpy.mock.calls[1][1] as RequestInit).headers).get('session-id');
    expect(first).not.toBeNull();
    expect(first).not.toMatch(UUID_V7_RE);
    expect(second).toBe(first);
  });

  test('derives distinct session ids when only the instructions differ', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const call = (instructions: string) => callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions,
        input: [{ type: 'message', role: 'user', content: 'hello' }],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
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
    const call = (content: string) => callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        instructions: 'System.',
        input: [{ type: 'message', role: 'user', content }],
        stream: true,
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
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
    await callCodexResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: deviceId },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe(deviceId);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe(deviceId);
  });

  test('prefers a caller-supplied installation id from client_metadata over the account device id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: { ...activeAccount, openaiDeviceId: 'account-device-id' },
      model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-codex-installation-id': 'caller-installation-id' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    const turnMetadata = JSON.parse(headers.get('x-codex-turn-metadata') ?? 'null') as Record<string, unknown>;
    expect(turnMetadata.installation_id).toBe('caller-installation-id');
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>)['x-codex-installation-id']).toBe('caller-installation-id');
  });

  test('passes through caller thread-id and x-client-request-id when distinct from session-id', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
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
    await callCodexResponses({
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
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect((body.client_metadata as Record<string, unknown>).turn_id).toBe('caller-turn');
  });

  test('preserves caller client_metadata extras while keeping identity-mirror keys gateway-owned', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount, model,
      body: {
        input: [], stream: true,
        client_metadata: { 'x-extra-key': 'caller-supplied', session_id: 'caller-override' },
      } as unknown as Parameters<typeof callCodexResponses>[0]['body'],
      headers: new Headers({ 'session-id': 'sess' }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    const clientMetadata = body.client_metadata as Record<string, unknown>;
    // Non-identity extras pass through verbatim.
    expect(clientMetadata['x-extra-key']).toBe('caller-supplied');
    // Identity-mirror keys come from identity (header beats body), so the
    // three surfaces never disagree.
    expect(clientMetadata.session_id).toBe('sess');
    expect(clientMetadata.thread_id).toBe('sess');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).toHaveBeenCalledWith('session_terminated', expect.stringMatching(/session ended/));
  });

  test('401 other → refresh + retry once, then bubble persistent 401', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'still expired' } }));
    const effects = makeEffects();
    const result = await callCodexResponses({
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
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });
});

describe('callCodexResponses — background-write registration', () => {
  // Background state writes (quota snapshot on 2xx/429, access-token put on
  // 401-retry) must reach the runtime's waitUntil slot so workerd does not
  // cancel them the instant the streaming response returns to the client.
  // Without this, freshly-minted Codex tokens and quota snapshots get dropped
  // on the floor and the next request re-mints / re-races the upstream.
  test('2xx persists quota snapshot via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  test('401-retry registers the freshly-minted access-token put via opts.call.waitUntil', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(),
      call: { ...noopUpstreamCallOptions(), waitUntil },
    });
    // Two writes get registered: the freshly-minted access token (401 retry
    // path) and the quota snapshot from the successful second attempt.
    expect(waitUntil).toHaveBeenCalledTimes(2);
  });
});

// Provider-level tests need their own enforcing recorder so they can assert
// the wrap-once contract without depending on the gateway package. The
// `fetcher` honours the third-arg recorder because data-plane POSTs thread
// the recorder through the fetcher rather than wrapping outside.
const enforcingRecorder = () => {
  const wrappedPromises: unknown[] = [];
  let last: number | undefined;
  const record = <T>(promise: Promise<T>): Promise<T> => {
    wrappedPromises.push(promise);
    const startedAt = performance.now();
    return promise.finally(() => { last = performance.now() - startedAt; });
  };
  const fetcher: Fetcher = (url, init, recordUpstreamLatency) => {
    const inner = fetch(url, init);
    return recordUpstreamLatency ? recordUpstreamLatency(inner) : inner;
  };
  return {
    options: {
      fetcher,
      recordUpstreamLatency: record,
      waitUntil: () => {},
      headers: new Headers(),
    },
    invocations: () => wrappedPromises.length,
    durationMs: (): number => {
      if (last === undefined) throw new Error('recorder was never wrapped');
      return last;
    },
  };
};

describe('callCodexResponses — recorder contract', () => {
  test('non-active gate satisfies an enforcing recorder once', async () => {
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId, account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    expect(recorder.durationMs()).toBeGreaterThanOrEqual(0);
  });

  test('rate-limited gate satisfies an enforcing recorder once', async () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-06-05T00:30:00.000Z'));
    seedAccountState({
      quotaSnapshot: {
        fetchedAt: new Date('2026-06-05T00:00:00.000Z').getTime(),
        data: { observed_at: '2026-06-05T00:00:00.000Z', ratelimited_until: '2026-06-05T01:00:00.000Z' },
      },
    });
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    expect(() => recorder.durationMs()).not.toThrow();
  });

  test('refresh-failed gate satisfies an enforcing recorder once', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(400, { error: { code: 'app_session_terminated', message: 'gone' } }));
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
    expect(() => recorder.durationMs()).not.toThrow();
  });

  test('401-then-success: recorder records both fetch attempts; durationMs reflects the second', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { code: 'expired_token', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const recorder = enforcingRecorder();
    const result = await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(true);
    // Both upstream fetches go through `recordUpstreamLatency`; the OAuth
    // refresh in between is provider-internal and must NOT be wrapped.
    expect(recorder.invocations()).toBe(2);
  });
});

// `callCodexResponsesCompact` shares OAuth + quota + 401-retry plumbing with
// `callCodexResponses` (both go through `prepareCodexCall` →
// `dispatchCodexHttpCall` → `refreshAccessTokenForRetry`). The streaming
// suite above pins those shared paths; this block exercises only the
// compact-specific wire contract — endpoint URL, `Accept: application/json`,
// body shape (no `stream`, no `store`), unary JSON decoding — plus the 401
// retry on the unary endpoint to confirm the retry decision is taken from
// the bare response status (no SSE wrap in the path).
const compactJsonResponse = (overrides?: Partial<ResponsesResult>): Response =>
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

describe('callCodexResponsesCompact', () => {
  test('posts to /codex/responses/compact with application/json and no stream/store', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(compactJsonResponse());
    const result = await callCodexResponsesCompact({
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

    const body = JSON.parse(init.body as string);
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
    await callCodexResponsesCompact({
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at2', refresh_token: 'rt_v2', id_token: 'it', expires_in: 600 }), { status: 200 }))
      .mockResolvedValueOnce(compactJsonResponse());
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(effects.persistRefreshTokenRotation).toHaveBeenCalledWith('rt_v2');
    // Both compact requests hit the same URL; the bearer flipped from at_kv to at2.
    expect(fetchSpy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/responses/compact');
    expect(new Headers((fetchSpy.mock.calls[2][1] as RequestInit).headers).get('authorization')).toBe('Bearer at2');
  });

  test('401 token_invalidated → persistTerminalState session_terminated, return synthetic 503', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(401, { error: { code: 'token_invalidated', message: 'session ended' } }));
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
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
      'x-codex-primary-reset-after-seconds': '3600',
      'x-codex-secondary-reset-after-seconds': '7200',
    }));
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushMicrotasks();
    const stored = readQuotaEntry();
    expect(stored?.data.ratelimited_until).toBeTruthy();
  });

  test('5xx passes through verbatim without touching state', async () => {
    seedFreshAccessToken();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(503, { error: 'unavailable' }));
    const effects = makeEffects();
    const result = await callCodexResponsesCompact({
      upstreamId, account: activeAccount, model,
      body: { input: [] }, headers: new Headers(), effects, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(503);
    expect(effects.persistTerminalState).not.toHaveBeenCalled();
    expect(effects.persistRefreshTokenRotation).not.toHaveBeenCalled();
  });

  test('non-active gate satisfies an enforcing recorder once (shared pre-fetch path)', async () => {
    const recorder = enforcingRecorder();
    const result = await callCodexResponsesCompact({
      upstreamId, account: { ...activeAccount, state: 'session_terminated' },
      model, body: { input: [] }, headers: new Headers(), effects: makeEffects(), call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
  });
});
