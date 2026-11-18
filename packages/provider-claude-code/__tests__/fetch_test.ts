import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callClaudeCodeAnthropicMessages } from '../src/fetch.ts';
import type {
  ClaudeCodeAccessTokenEntry,
  ClaudeCodeAccountCredential,
  ClaudeCodeQuotaSnapshotEntry,
  ClaudeCodeUpstreamState,
} from '../src/state.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { initProviderRepo, type AnthropicMessagesUpstreamCallOptions, type UpstreamRecord } from '@floway-dev/provider';
import { noopAnthropicMessagesUpstreamCallOptions as noopUpstreamCallOptions, readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

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
  endpoints: { anthropicMessages: {} },
  providerData: sonnetProviderData,
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
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
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
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...currentRecord, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        currentRecord = { ...currentRecord, state: mutate(currentRecord.state, 1) };
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

describe('callClaudeCodeAnthropicMessages — pre-fetch gates', () => {
  test('non-active account → synthetic 503', async () => {
    seedAccount({ state: 'session_terminated', stateMessage: 'revoked' });
    const result = await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('rejected shared five_hour quota → synthetic 429 with retry-after', async () => {
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
          representativeClaim: 'five_hour',
          overage: null,
          fiveHour: null,
          sevenDay: null,
          raw: {},
        },
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(429);
      expect(result.response.headers.get('retry-after')).toBeTruthy();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Claude Code 2.1.322 maps the per-model seven_day_overage_included claim to 7d_oi.
  // https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.322.tgz
  test.each([false, true])('Fable 429 does not block sibling models (5h headers present: %s)', async includeFiveHour => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const resetSeconds = Math.floor(Date.now() / 1000) + 6 * 24 * 60 * 60;
    const quotaHeaders = {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
      'anthropic-ratelimit-unified-reset': String(resetSeconds),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.62',
      'anthropic-ratelimit-unified-7d-reset': String(resetSeconds),
      'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
      'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
      'anthropic-ratelimit-unified-7d_oi-reset': String(resetSeconds),
      'anthropic-ratelimit-unified-overage-status': 'rejected',
      'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
      'retry-after': String(6 * 24 * 60 * 60),
      ...(includeFiveHour ? { 'anthropic-ratelimit-unified-5h-status': 'allowed' } : {}),
    };
    const fableModel = stubProviderModel({ ...sonnetModel, id: 'public-fable-alias', providerData: { upstreamModelId: 'claude-fable-5-1' } });
    const upstreamBody = { error: { type: 'rate_limit_error', message: 'Fable weekly allowance exhausted' } };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(errorJson(429, upstreamBody, quotaHeaders));
    const pending: Promise<unknown>[] = [];
    const call = { ...noopUpstreamCallOptions(), waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
    const first = await callClaudeCodeAnthropicMessages({ upstreamId, model: fableModel, body: minimalBody, shaped: false, call });
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.response.status).toBe(429);
      expect(first.response.headers.get('retry-after')).toBe(quotaHeaders['retry-after']);
      expect(await first.response.json()).toEqual(upstreamBody);
    }
    await Promise.all(pending);
    expect(readQuotaEntry()).toMatchObject({ modelId: 'claude-fable-5-1', data: { status: 'rejected', representativeClaim: 'seven_day_overage_included' } });

    const again = await callClaudeCodeAnthropicMessages({ upstreamId, model: fableModel, body: minimalBody, shaped: false, call });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.response.status).toBe(429);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    for (const modelId of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
      fetchSpy.mockResolvedValueOnce(sseResponse(200, {}));
      const model = stubProviderModel({ ...sonnetModel, id: modelId, providerData: { upstreamModelId: modelId } });
      expect((await callClaudeCodeAnthropicMessages({ upstreamId, model, body: minimalBody, shaped: false, call })).ok).toBe(true);
      const wireBody = await readJsonRequest(fetchSpy.mock.calls.at(-1)![1] as RequestInit) as AnthropicMessagesPayload;
      expect(wireBody.model).toBe(modelId);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    await Promise.all(pending);
  });
});

describe('callClaudeCodeAnthropicMessages — header surface', () => {
  test('shaped:true forwards the gateway-allowlisted fingerprint and sets Authorization', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel, body: minimalBody,
      shaped: true,
      call: {
        ...noopUpstreamCallOptions(),
        headers: new Headers({
          'user-agent': 'claude-cli/2.1.280 (external, cli)',
          'x-app': 'cli',
          'anthropic-version': '2023-06-01',
          'x-stainless-package-version': '0.112.1',
          'x-claude-code-session-id': 'sess-abc',
          'x-client-request-id': 'req-xyz',
        }),
        anthropicBeta: ['oauth-2025-04-20', 'claude-code-20250219'],
      },
    });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const wireHeaders = new Headers(init.headers);
    expect(wireHeaders.get('authorization')).toBe('Bearer at_cached');
    expect(wireHeaders.get('user-agent')).toBe('claude-cli/2.1.280 (external, cli)');
    expect(wireHeaders.get('x-app')).toBe('cli');
    expect(wireHeaders.get('anthropic-version')).toBe('2023-06-01');
    expect(wireHeaders.get('anthropic-beta')).toBe('oauth-2025-04-20,claude-code-20250219');
    expect(wireHeaders.get('x-stainless-package-version')).toBe('0.112.1');
    expect(wireHeaders.get('x-claude-code-session-id')).toBe('sess-abc');
    expect(wireHeaders.get('x-client-request-id')).toBe('req-xyz');
  });

});

describe('callClaudeCodeAnthropicMessages — wire body', () => {
  test('forces stream:true regardless of caller intent', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel,
      body: { ...minimalBody, stream: false },
      shaped: false, call: noopUpstreamCallOptions(),
    });
    const body = await readJsonRequest(fetchSpy.mock.calls[0]![1] as RequestInit) as AnthropicMessagesPayload;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('callClaudeCodeAnthropicMessages — 401 retry', () => {
  test('cached-token 401 → invalidate, mint fresh, retry once, succeed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'expired' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const result = await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    expect(currentState().accounts[0]!.accessToken?.token).toBe('at_new');
    expect(currentState().accounts[0]!.refreshToken).toBe('rt_v2');
  });

  test('freshly-minted token 401 → no invalidate, surface verbatim', async () => {
    seedAccount();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'still expired' } }));
    const result = await callClaudeCodeAnthropicMessages({
      upstreamId, model: sonnetModel, body: minimalBody, shaped: false, call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});

describe('callClaudeCodeAnthropicMessages — quota persistence', () => {
  test('2xx → registers persist promise via opts.call.waitUntil exactly once', async () => {
    // On Cloudflare Workers the runtime cancels orphan promises the moment
    // the response is sent. The gateway threads `waitUntil` through
    // UpstreamCallOptions so the persist can extend the worker's lifetime;
    // assert we hand the persist promise to it exactly once and that the
    // promise actually mutates state when awaited.
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    const call: AnthropicMessagesUpstreamCallOptions = { ...noopUpstreamCallOptions(), waitUntil };
    const result = await callClaudeCodeAnthropicMessages({
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

// Body-sentinel terminal flips mirror sub2api / CRS detection of a
// permanently disabled or banned org. The gateway still surfaces the
// upstream response verbatim (passthrough discipline); the flip is an
// additional dashboard signal so the operator sees "Org disabled" instead
// of an endless stream of identical 400s/403s the next request would
// produce.
describe('callClaudeCodeAnthropicMessages — terminal sentinel detection', () => {
  test('400 invalid_request_error with "organization has been disabled" → surface verbatim AND flip to refresh_failed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamBody = { error: { type: 'invalid_request_error', message: 'organization has been disabled' } };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorJson(400, upstreamBody));
    const result = await callClaudeCodeAnthropicMessages({
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

});
