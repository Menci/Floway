import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callClaudeCodeMessages, detectHaikuProbe } from './fetch.ts';
import { CLAUDE_CODE_HEADERS_HAIKU, CLAUDE_CODE_HEADERS_SONNET_OPUS } from './headers.ts';
import type {
  ClaudeCodeAccessTokenEntry,
  ClaudeCodeAccountCredential,
  ClaudeCodeQuotaSnapshotEntry,
  ClaudeCodeUpstreamState,
} from './state.ts';
import { initProviderRepo, type Fetcher, type UpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

const upstreamId = 'up_cc';

const activeAccount: ClaudeCodeAccountCredential = {
  accountUuid: 'acc-1',
  tokenKind: 'oauth',
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: null,
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};

const sonnetProviderData = { upstreamModelId: 'claude-sonnet-4-5-20250929' };
const sonnetModel = stubProviderModel({
  id: 'claude-sonnet-4-5',
  display_name: 'Sonnet',
  endpoints: { messages: {} },
  providerData: sonnetProviderData,
});

const haikuProviderData = { upstreamModelId: 'claude-haiku-4-5-20251001' };
const haikuModel = stubProviderModel({
  id: 'claude-haiku-4-5',
  display_name: 'Haiku',
  endpoints: { messages: {} },
  providerData: haikuProviderData,
});

const freshAccessTokenEntry: ClaudeCodeAccessTokenEntry = {
  token: 'at_cached',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: new Date(Date.now() - 60 * 1000).toISOString(),
};

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'claude-code',
  name: 'CC',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

let currentRecord: UpstreamRecord;

// `UpstreamRecord.state` is typed `unknown` at the provider boundary; tests
// only ever seed it as ClaudeCodeUpstreamState, so this helper centralises
// the cast instead of repeating it at every assertion site.
const currentState = (): ClaudeCodeUpstreamState =>
  currentRecord.state as ClaudeCodeUpstreamState;

const seedAccount = (overrides: Partial<ClaudeCodeAccountCredential> = {}): void => {
  // Tests pass overrides that may flip state to a terminal value with the
  // matching stateMessage; the spread merges into a valid discriminated-union
  // shape, but TS can't narrow that through Partial<...> so cast to bridge.
  const account = { ...activeAccount, ...overrides } as ClaudeCodeAccountCredential;
  currentRecord = makeRecord({ accounts: [account] });
};

const readQuotaEntry = (): ClaudeCodeQuotaSnapshotEntry | null =>
  currentState().accounts[0]!.quotaSnapshot;

// Yield to the queue so the .catch chain from fireAndForgetPersist completes
// before assertions inspect the persisted state.
const flushAsyncQueue = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  seedAccount();
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as ClaudeCodeUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseResponse = (status = 200, extraHeaders: Record<string, string> = {}): Response => new Response(
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n'));
      c.close();
    },
  }),
  {
    status,
    headers: {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '1781805000',
      'anthropic-ratelimit-unified-5h-utilization': '0.0',
      ...extraHeaders,
    },
  },
);

const errorJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });

const minimalBody = { max_tokens: 16, messages: [{ role: 'user' as const, content: 'hi' }] };

describe('detectHaikuProbe', () => {
  test('true only when model contains "haiku" and max_tokens is exactly 1', () => {
    expect(detectHaikuProbe({ model: 'claude-haiku-4-5-20251001', max_tokens: 1 })).toBe(true);
    expect(detectHaikuProbe({ model: 'claude-haiku-4-5-20251001', max_tokens: 2 })).toBe(false);
    expect(detectHaikuProbe({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1 })).toBe(false);
    expect(detectHaikuProbe({ max_tokens: 1 })).toBe(false);
  });
});

describe('callClaudeCodeMessages — pre-fetch gates', () => {
  test('non-active account → synthetic 503', async () => {
    seedAccount({ state: 'session_terminated', stateMessage: 'revoked' });
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('rejected quota status → synthetic 429 with retry-after', async () => {
    const resetIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedAccount({
      accessToken: freshAccessTokenEntry,
      quotaSnapshot: {
        fetchedAt: Date.now(),
        data: {
          status: 'rejected',
          reset: resetIso,
          fallbackAvailable: null,
          fallbackPercentage: null,
          representativeClaim: null,
          overage: null,
          fiveHour: null,
          sevenDay: null,
          raw: {},
        },
      },
    });
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('retry-after')).toBeTruthy();
    }
  });
});

describe('callClaudeCodeMessages — header surface', () => {
  test('shaped:true forwards inbound client headers through the whitelist and swaps Authorization', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: true,
      call: {
        ...noopUpstreamCallOptions(),
        headers: new Headers({
          'user-agent': 'claude-cli/2.1.181 (external, cli)',
          'x-app': 'cli',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
          'x-stainless-package-version': '0.94.0',
          'x-claude-code-session-id': 'sess-abc',
          'x-client-request-id': 'req-xyz',
          // Authorization is dropped by the whitelist; ours replaces it.
          authorization: 'Bearer client-side-token',
          // Not on the whitelist; must not reach the wire.
          'x-leaky-debug': 'should-be-dropped',
        }),
      },
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
    expect(wireHeaders.get('user-agent')).toBe('claude-cli/2.1.181 (external, cli)');
    expect(wireHeaders.get('x-app')).toBe('cli');
    expect(wireHeaders.get('anthropic-version')).toBe('2023-06-01');
    expect(wireHeaders.get('anthropic-beta')).toBe('oauth-2025-04-20,claude-code-20250219');
    expect(wireHeaders.get('x-stainless-package-version')).toBe('0.94.0');
    expect(wireHeaders.get('x-claude-code-session-id')).toBe('sess-abc');
    expect(wireHeaders.get('x-client-request-id')).toBe('req-xyz');
    expect(wireHeaders.get('x-leaky-debug')).toBeNull();
  });

  test('shaped:true defaults Content-Type to application/json when the inbound omits it', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: true,
      call: { ...noopUpstreamCallOptions(), headers: new Headers({ 'user-agent': 'claude-cli/2.1.181' }) },
    });
    const wireHeaders = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(wireHeaders.get('content-type')).toBe('application/json');
  });

  test('shaped:true forwards inbound Content-Type verbatim when present', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: true,
      call: {
        ...noopUpstreamCallOptions(),
        headers: new Headers({ 'user-agent': 'claude-cli/2.1.181', 'content-type': 'application/json; charset=utf-8' }),
      },
    });
    const wireHeaders = new Headers((fetchSpy.mock.calls[0]![1] as RequestInit).headers);
    expect(wireHeaders.get('content-type')).toBe('application/json; charset=utf-8');
  });

  test('shaped:true with empty headers passes through minimal content-type + authorization (no inbound fingerprint to forward)', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: true,
      call: noopUpstreamCallOptions(),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
    expect(wireHeaders.get('content-type')).toBe('application/json');
    // No allowlisted inbound headers were present, so nothing else carries through.
    expect(wireHeaders.get('x-stainless-lang')).toBeNull();
    expect(wireHeaders.get('anthropic-beta')).toBeNull();
  });

  test('shaped:false on sonnet replaces headers with pinned sonnet/opus set', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: false, call: noopUpstreamCallOptions(),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
    expect(wireHeaders.get('user-agent')).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS['User-Agent']);
    expect(wireHeaders.get('anthropic-beta')).toBe(CLAUDE_CODE_HEADERS_SONNET_OPUS['anthropic-beta']);
  });

  test('shaped:false on haiku uses the leaner haiku header set', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: haikuModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get('anthropic-beta')).toBe(CLAUDE_CODE_HEADERS_HAIKU['anthropic-beta']);
  });
});

describe('callClaudeCodeMessages — wire body', () => {
  test('forces stream:true regardless of caller intent', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel,
      body: { ...minimalBody, stream: false },
      shaped: false, call: noopUpstreamCallOptions(),
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
  });

  test('targets /v1/messages?beta=true', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.anthropic.com/v1/messages?beta=true');
  });
});

describe('callClaudeCodeMessages — 401 retry', () => {
  test('cached-token 401 → invalidate, mint fresh, retry once, succeed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(currentState().accounts[0]!.accessToken?.token).toBe('at_new');
    expect(currentState().accounts[0]!.refreshToken).toBe('rt_v2');
  });

  test('second 401 after retry → surface verbatim 401, no further retries', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'still expired' } }));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  test('freshly-minted token 401 → no invalidate, surface verbatim', async () => {
    seedAccount();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'still expired' } }));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe('callClaudeCodeMessages — quota persistence', () => {
  test('2xx → parses and persists quota snapshot from response headers', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(200, {
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-reset': '1782039600',
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
    }));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    await flushAsyncQueue();
    const stored = readQuotaEntry();
    expect(stored).not.toBeNull();
    const data = stored!.data as { status?: string; sevenDay?: { utilization?: number } };
    expect(data.status).toBe('allowed');
    expect(data.sevenDay?.utilization).toBe(0.5);
  });

  test('429 also persists quota snapshot (rate-limit window captured)', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(429, { error: { type: 'rate_limit_error', message: 'slow down' } }, {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-reset': '1781805000',
      'retry-after': '60',
    }));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(429);
    await flushAsyncQueue();
    const stored = readQuotaEntry();
    const data = stored!.data as { status?: string };
    expect(data.status).toBe('rejected');
  });

  test('2xx → registers persist promise via opts.call.waitUntil exactly once', async () => {
    // On Cloudflare Workers the runtime cancels orphan promises the moment
    // the response is sent. The gateway threads `waitUntil` through
    // UpstreamCallOptions so the persist can extend the worker's lifetime;
    // assert we hand the persist promise to it exactly once and that the
    // promise actually mutates state when awaited.
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const call: UpstreamCallOptions = { ...noopUpstreamCallOptions(), waitUntil };
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call,
    });
    expect(result.ok).toBe(true);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    const handed = waitUntil.mock.calls[0]![0];
    expect(handed).toBeInstanceOf(Promise);
    await expect(handed).resolves.toBeUndefined();
    const stored = readQuotaEntry();
    expect(stored).not.toBeNull();
  });
});

const enforcingRecorder = () => {
  const wrappedPromises: unknown[] = [];
  const record = <T>(promise: Promise<T>): Promise<T> => {
    wrappedPromises.push(promise);
    return promise;
  };
  const fetcher: Fetcher = (url, init, recorder) => {
    const inner = fetch(url, init);
    return recorder ? recorder(inner) : inner;
  };
  const options: UpstreamCallOptions = { ...noopUpstreamCallOptions(), fetcher, recordUpstreamLatency: record };
  return { options, invocations: () => wrappedPromises.length };
};

describe('callClaudeCodeMessages — recorder contract', () => {
  test('non-active gate wraps exactly one synthetic response', async () => {
    seedAccount({ state: 'refresh_failed', stateMessage: 'gone' });
    const recorder = enforcingRecorder();
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: recorder.options,
    });
    expect(result.ok).toBe(false);
    expect(recorder.invocations()).toBe(1);
  });

  test('happy path wraps exactly one upstream fetch', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const recorder = enforcingRecorder();
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: recorder.options,
    });
    expect(result.ok).toBe(true);
    expect(recorder.invocations()).toBe(1);
  });

  test('401-then-success wraps both upstream attempts (OAuth refresh is provider-internal)', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const recorder = enforcingRecorder();
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: recorder.options,
    });
    expect(result.ok).toBe(true);
    expect(recorder.invocations()).toBe(2);
  });
});

// Body-sentinel terminal flips mirror sub2api / CRS detection of a
// permanently disabled or banned org. The gateway still surfaces the
// upstream response verbatim (passthrough discipline); the flip is an
// additional dashboard signal so the operator sees "Org disabled" instead
// of an endless stream of identical 400s/403s the next request would
// produce.
describe('callClaudeCodeMessages — terminal sentinel detection', () => {
  test('400 invalid_request_error with "organization has been disabled" → surface verbatim AND flip to refresh_failed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamBody = { error: { type: 'invalid_request_error', message: 'organization has been disabled' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(400, upstreamBody));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      // Verbatim body still reaches the caller — the response body must be
      // readable after the provider call returned (we cloned for detection).
      expect(await result.response.json()).toEqual(upstreamBody);
    }
    await flushAsyncQueue();
    const account = currentState().accounts[0]!;
    expect(account.state).toBe('refresh_failed');
    expect(account.stateMessage).toMatch(/Organization disabled by Anthropic/);
    expect(account.stateMessage).toMatch(/organization has been disabled/);
    expect(account.accessToken).toBeNull();
  });

  test('403 permission_error with banned-org sentinel → surface verbatim AND flip to refresh_failed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamBody = {
      error: {
        type: 'permission_error',
        message: 'OAuth authentication is currently not allowed for this organization',
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(403, upstreamBody));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual(upstreamBody);
    }
    await flushAsyncQueue();
    const account = currentState().accounts[0]!;
    expect(account.state).toBe('refresh_failed');
    expect(account.stateMessage).toMatch(/Organization banned from OAuth by Anthropic/);
    expect(account.accessToken).toBeNull();
  });

  test('400 invalid_request_error with unrelated message → surface verbatim, NO terminal flip', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamBody = { error: { type: 'invalid_request_error', message: 'max_tokens: must be at most 8192' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(400, upstreamBody));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual(upstreamBody);
    }
    await flushAsyncQueue();
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('403 permission_error with unrelated message → surface verbatim, NO terminal flip', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamBody = { error: { type: 'permission_error', message: 'unrelated' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(403, upstreamBody));
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual(upstreamBody);
    }
    await flushAsyncQueue();
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('400 with non-JSON body → surface verbatim, NO terminal flip (defensive parse)', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not json at all', { status: 400, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await callClaudeCodeMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.text()).toBe('not json at all');
    }
    await flushAsyncQueue();
    expect(currentState().accounts[0]!.state).toBe('active');
  });
});
