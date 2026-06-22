import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { CODEX_RESPONSES_ORIGINATOR, CODEX_RESPONSES_USER_AGENT } from './constants.ts';
import { callCodexResponses, type CodexCallEffects } from './fetch.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexQuotaSnapshotEntry, CodexUpstreamState } from './state.ts';
import { initProviderRepo, type Fetcher, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions } from '@floway-dev/test-utils';

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', accessToken: null, quotaSnapshot: null };
const model: UpstreamModel = {
  id: 'gpt-5.4', display_name: 'gpt-5.4', kind: 'chat', limits: {}, endpoints: { responses: {} }, enabledFlags: new Set(),
};

const upstreamId = 'up_a';

const farFutureAccessToken: CodexAccessTokenEntry = {
  token: 'at_kv',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: 'now',
};

const makeRecord = (state: CodexUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'codex',
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

  test('builds CLIProxyAPI-style Codex responses headers from a clean set', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model,
      body: { input: [], stream: true },
      headers: new Headers({
        'cf-connecting-ip': '203.0.113.10',
        forwarded: 'for=203.0.113.10',
        'openai-beta': 'responses=experimental',
        originator: 'downstream-originator',
        session_id: 'downstream-session',
        'user-agent': 'curl/8.7.1',
        version: '1',
        'x-client-request-id': 'req-123',
        'x-codex-beta-features': 'responses_websockets=2026-02-06',
        'x-codex-turn-metadata': 'turn-meta',
        'x-real-ip': '203.0.113.10',
      }),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at_kv');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CODEX_RESPONSES_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CODEX_RESPONSES_USER_AGENT);
    expect(headers.get('accept')).toBe('text/event-stream');
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('session_id')).toBe('downstream-session');
    expect(headers.get('version')).toBe('1');
    expect(headers.get('x-client-request-id')).toBe('req-123');
    expect(headers.get('x-codex-beta-features')).toBe('responses_websockets=2026-02-06');
    expect(headers.get('x-codex-turn-metadata')).toBe('turn-meta');
    expect(headers.get('cf-connecting-ip')).toBeNull();
    expect(headers.get('forwarded')).toBeNull();
    expect(headers.get('openai-beta')).toBeNull();
    expect(headers.get('x-real-ip')).toBeNull();
  });

  test('generates a Codex session id when the downstream request has none', async () => {
    seedFreshAccessToken();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callCodexResponses({
      upstreamId, account: activeAccount,
      model, body: { input: [], stream: true }, headers: new Headers(), effects: makeEffects(), call: noopUpstreamCallOptions(),
    });

    const headers = new Headers((fetchSpy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('session_id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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
