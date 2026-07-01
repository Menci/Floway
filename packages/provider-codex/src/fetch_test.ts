import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callCodexResponses, callCodexResponsesCompact, type CodexCallEffects } from './fetch.ts';
import type { CodexAccessTokenEntry, CodexAccountCredential, CodexQuotaSnapshotEntry, CodexUpstreamState } from './state.ts';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

const makeEffects = (): CodexCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const activeAccount: CodexAccountCredential = { chatgptAccountId: 'acc', refresh_token: 'rt_v1', state: 'active', state_updated_at: '2026-01-01T00:00:00Z', accessToken: null, quotaSnapshot: null };
const model = stubProviderModel({ id: 'gpt-5.4', display_name: 'gpt-5.4', endpoints: { responses: {} } });

const upstreamId = 'up_a';

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
