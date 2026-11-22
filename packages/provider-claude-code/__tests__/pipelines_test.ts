import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createClaudeCodePipelines } from '../src/pipelines.ts';
import type {
  ClaudeCodeAccessTokenEntry,
  ClaudeCodeAccountCredential,
  ClaudeCodeQuotaSnapshotEntry,
  ClaudeCodeUpstreamState,
} from '../src/state.ts';
import { isManagedStream, isSecret, run, type ManagedStream, type RunDone, type RunEvent, type Bytes } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { directFetcher, initProviderRepo, readHttpBody, toProviderModelFacts, type Fetcher, type HeaderEntry, type HttpRequestFacts, type ProviderAnthropicInput, type ProviderHttpOutput, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';
import { readJsonRequest, stubProviderModel } from '@floway-dev/test-utils';

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
let writeError: Error | undefined;

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

beforeEach(() => {
  vi.useRealTimers();
  writeError = undefined;
  seedAccount();
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...currentRecord, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        if (writeError !== undefined) throw writeError;
        currentRecord = { ...currentRecord, state: mutate(currentRecord.state, 1) };
      },
    },
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

interface RunMessagesInput {
  readonly model?: ProviderModel;
  readonly body?: ProviderAnthropicInput['request.payload'];
  readonly headers?: readonly HeaderEntry[];
  readonly anthropicBeta?: readonly string[];
  readonly fetcher?: Fetcher;
  readonly events?: (event: RunEvent) => void;
  readonly signal?: AbortSignal;
}

const runMessages = async ({
  model = sonnetModel, body = minimalBody, headers = [], anthropicBeta = [], fetcher = directFetcher, events, signal,
}: RunMessagesInput = {}) => {
  const { anthropicMessages } = createClaudeCodePipelines(upstreamId);
  const handle = run(anthropicMessages, {
    'provider.model': toProviderModelFacts(model),
    'request.payload': body,
    'request.headers': headers,
    'request.anthropicBeta': anthropicBeta,
  }, {
    services: { fetcher: () => fetcher },
    finalizationTimeoutMs: 2000,
    ...(events === undefined ? {} : { events }),
    ...(signal === undefined ? {} : { signal }),
  });
  return { ...await handle.result, done: handle.done };
};
const successful = ({ 'response.http': { status } }: ProviderHttpOutput): boolean => status >= 200 && status < 300;
const headersOf = ({ 'response.http': { headers } }: ProviderHttpOutput): Headers =>
  new Headers(headers.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
const jsonOf = async (result: ProviderHttpOutput): Promise<unknown> => JSON.parse((await readHttpBody(result['response.http'].body)).utf8());
const streamOf = (result: ProviderHttpOutput): ManagedStream<Bytes> => {
  const body = result['response.http'].body;
  if (!isManagedStream(body)) throw new Error('expected a streaming HTTP body');
  return body;
};
const release = async (result: ProviderHttpOutput & { done: Promise<RunDone>; 'response.events'?: unknown }) => {
  const body = result['response.events'] ?? result['response.http'].body;
  if (isManagedStream(body)) await body.close();
  expect(await result.done).toEqual({ ok: true });
};

describe('Claude Code pre-fetch gates', () => {
  test('non-active account → synthetic 503', async () => {
    seedAccount({ state: 'session_terminated', stateMessage: 'revoked' });
    const result = await runMessages({
      model: sonnetModel, body: minimalBody,
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(503);
    await release(result);
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
    const result = await runMessages({
      model: sonnetModel, body: minimalBody,
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) {
      expect(result['response.http'].status).toBe(429);
      expect(headersOf(result).get('retry-after')).toBeTruthy();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    await release(result);
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
    const first = await runMessages({ model: fableModel, body: minimalBody });
    expect(successful(first)).toBe(false);
    if (!successful(first)) {
      expect(first['response.http'].status).toBe(429);
      expect(headersOf(first).get('retry-after')).toBe(quotaHeaders['retry-after']);
      expect(await jsonOf(first)).toEqual(upstreamBody);
    }
    expect(await first['response.claudeCode.quota']?.promise).toEqual({ persisted: true });
    expect(await first.done).toEqual({ ok: true });
    expect(readQuotaEntry()).toMatchObject({ modelId: 'claude-fable-5-1', data: { status: 'rejected', representativeClaim: 'seven_day_overage_included' } });

    const again = await runMessages({ model: fableModel, body: minimalBody });
    expect(successful(again)).toBe(false);
    if (!successful(again)) expect(again['response.http'].status).toBe(429);
    await release(again);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    for (const modelId of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
      fetchSpy.mockResolvedValueOnce(sseResponse(200, {}));
      const model = stubProviderModel({ ...sonnetModel, id: modelId, providerData: { upstreamModelId: modelId } });
      const sibling = await runMessages({ model, body: minimalBody });
      expect(successful(sibling)).toBe(true);
      await release(sibling);
      const wireBody = await readJsonRequest(fetchSpy.mock.calls.at(-1)![1] as RequestInit) as AnthropicMessagesPayload;
      expect(wireBody.model).toBe(modelId);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

describe('Claude Code header surface', () => {
  test('a shaped request forwards the gateway-allowlisted fingerprint and sets Authorization', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await runMessages({
      model: sonnetModel,
      body: {
        ...minimalBody,
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        metadata: { user_id: JSON.stringify({ device_id: 'device', session_id: 'session' }) },
      },
      headers: [...new Headers({
        'user-agent': 'claude-cli/2.1.280 (external, cli)',
        'x-app': 'cli',
        'anthropic-version': '2023-06-01',
        'x-stainless-package-version': '0.112.1',
        'x-claude-code-session-id': 'sess-abc',
        'x-client-request-id': 'req-xyz',
      })],
      anthropicBeta: ['oauth-2025-04-20', 'claude-code-20250219'],
    });
    await release(result);
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

describe('Claude Code wire body', () => {
  test('forces stream:true regardless of caller intent', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await runMessages({ model: sonnetModel, body: { ...minimalBody, stream: false } });
    await release(result);
    const body = await readJsonRequest(fetchSpy.mock.calls[0]![1] as RequestInit) as AnthropicMessagesPayload;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
  });
});

describe('Claude Code 401 retry', () => {
  test('cached-token 401 → invalidate, mint fresh, retry once, succeed', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const cancelRejectedBody = vi.fn();
    const firstBody = new ReadableStream<Uint8Array>({ cancel: cancelRejectedBody }, { highWaterMark: 0 });
    const fetcher = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(firstBody, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(sseResponse());
    const result = await runMessages({
      model: sonnetModel, body: minimalBody,
    });
    expect(successful(result)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(cancelRejectedBody).toHaveBeenCalledOnce();
    expect(currentState().accounts[0]!.accessToken?.token).toBe('at_new');
    expect(currentState().accounts[0]!.refreshToken).toBe('rt_v2');
    await release(result);
  });

  test('freshly-minted token 401 → no invalidate, surface verbatim', async () => {
    seedAccount();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'at_new', refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }), { status: 200 }))
      .mockResolvedValueOnce(errorJson(401, { error: { type: 'authentication_error', message: 'still expired' } }));
    const result = await runMessages({
      model: sonnetModel, body: minimalBody,
    });
    expect(successful(result)).toBe(false);
    if (!successful(result)) expect(result['response.http'].status).toBe(401);
    expect(await jsonOf(result)).toEqual({ error: { type: 'authentication_error', message: 'still expired' } });
    expect(await result.done).toEqual({ ok: true });
  });
});

describe('Claude Code quota persistence', () => {
  test('2xx exposes a quota persistence deferred', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await runMessages({ model: sonnetModel, body: minimalBody });
    expect(successful(result)).toBe(true);
    expect(await result['response.claudeCode.quota']?.promise).toEqual({ persisted: true });
    expect(readQuotaEntry()).toMatchObject({
      modelId: sonnetProviderData.upstreamModelId,
      data: { status: 'allowed', fiveHour: { status: 'allowed', utilization: 0 } },
    });
    await release(result);
  });
});

// Body-sentinel terminal flips mirror sub2api / CRS detection of a
// permanently disabled or banned org. The gateway still surfaces the
// upstream response verbatim (passthrough discipline); the flip is an
// additional dashboard signal so the operator sees "Org disabled" instead
// of an endless stream of identical 400s/403s the next request would
// produce.
describe('Claude Code terminal sentinel detection', () => {
  test.each([
    [400, 'invalid_request_error', 'organization has been disabled', 'org_disabled_400_sentinel'],
    [403, 'permission_error', 'OAuth authentication is currently not allowed', 'org_banned_403_sentinel'],
  ] as const)('preserves a %s response verbatim and flips the account on a terminal sentinel', async (status, type, message, reason) => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const trace: RunEvent[] = [];
    const body = { error: { type, message }, padding: 'x'.repeat(1200) };
    const result = await runMessages({ fetcher: async () => errorJson(status, body), events: event => { trace.push(event); } });

    expect(result['response.http'].status).toBe(status);
    expect(await jsonOf(result)).toEqual(body);
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ persisted: true });
    expect(await result.done).toEqual({ ok: true });
    expect(currentState().accounts[0]).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining(message), accessToken: null });
    expect(trace).toContainEqual(expect.objectContaining({ k: 'log', message: 'claude_code_terminal_sentinel_detected', fields: expect.objectContaining({ reason }) }));
  });

  test('forwards the first bytes of a 400 before the remaining bytes arrive', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const gate = Promise.withResolvers<void>();
    const prefix = '{"error":{"type":"invalid_request_error","message":"organization has been disabled"';
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(prefix)); },
      async pull(controller) {
        await gate.promise;
        controller.enqueue(encoder.encode('}}'));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const result = await runMessages({ fetcher: async () => new Response(source, { status: 400 }) });
    const reader = streamOf(result)[Symbol.asyncIterator]();
    const first = await reader.next();
    expect(first.done).toBe(false);
    expect(first.value?.utf8()).toBe(prefix);
    expect(currentState().accounts[0]!.state).toBe('active');
    gate.resolve();
    expect((await reader.next()).value?.utf8()).toBe('}}');
    expect((await reader.next()).done).toBe(true);
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ persisted: true });
    expect(await result.done).toEqual({ ok: true });
  });

  test('reports an observer-side read failure when the caller closes an unread 400', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamError = new Error('upstream body failed');
    const trace: RunEvent[] = [];
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(upstreamError); },
    });
    const result = await runMessages({
      fetcher: async () => new Response(source, { status: 400 }),
      events: event => { trace.push(event); },
    });
    expect(result['response.http'].status).toBe(400);
    await expect(streamOf(result).close()).resolves.toBeUndefined();
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toMatchObject({ kind: 'unreadable', error: { message: upstreamError.message } });
    expect(trace).toContainEqual(expect.objectContaining({ k: 'log', level: 'warn', message: 'claude_code_terminal_sentinel_body_read_failed' }));
    expect(currentState().accounts[0]!.state).toBe('active');
    expect(await result.done).toEqual({ ok: true });
  });

  test('propagates an upstream read error to the caller reading the response body', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamError = new Error('upstream body failed during delivery');
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(upstreamError); },
    });
    const result = await runMessages({ fetcher: async () => new Response(source, { status: 400 }) });
    const reader = streamOf(result)[Symbol.asyncIterator]();
    await expect(reader.next()).rejects.toBe(upstreamError);
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toMatchObject({ kind: 'unreadable', error: { message: upstreamError.message } });
    expect(await result.done).toMatchObject({ ok: false, error: { message: upstreamError.message } });
  });

  test('detects an unread sentinel on release without pulling it before release', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('{"error":{"type":"invalid_request_error","message":"organization has been disabled"}}'));
      controller.close();
    });
    const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
    const result = await runMessages({ fetcher: async () => new Response(stream, { status: 400 }) });
    expect(pull).not.toHaveBeenCalled();
    await release(result);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ persisted: true });
    expect(currentState().accounts[0]).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining('organization has been disabled') });
  });

  test('relays a body beyond the observer byte limit and records an incomplete verdict', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const document = { error: { type: 'invalid_request_error', message: 'organization has been disabled' }, padding: 'x'.repeat(65536) };
    const result = await runMessages({ fetcher: async () => errorJson(400, document) });

    expect(await jsonOf(result)).toEqual(document);
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ kind: 'incomplete', reason: 'byte_limit' });
    expect(await result.done).toEqual({ ok: true });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('bounds a release drain and cancels the stalled physical read', async () => {
    vi.useFakeTimers();
    seedAccount({ accessToken: freshAccessTokenEntry });
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull: () => reading.resolve(), cancel }, { highWaterMark: 0 });
    const result = await runMessages({ fetcher: async () => new Response(source, { status: 400 }) });
    const close = streamOf(result).close();
    await reading.promise;
    await vi.advanceTimersByTimeAsync(1000);

    await expect(close).resolves.toBeUndefined();
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ kind: 'incomplete', reason: 'deadline' });
    expect(await result.done).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('settles an unread sentinel as incomplete when the caller cancels', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const controller = new AbortController();
    const pull = vi.fn();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const result = await runMessages({ fetcher: async () => new Response(stream, { status: 400 }), signal: controller.signal });

    controller.abort(new Error('caller disconnected'));
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ kind: 'incomplete', reason: 'cancelled' });
    expect(await result.done).toEqual({ ok: true });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('does not classify a partial observation when cancellation stops a release drain', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const cancelDomain = new AbortController();
    const waitingForEnd = Promise.withResolvers<void>();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"type":"invalid_request_error","message":"organization has been disabled"}}'));
      },
      pull() { waitingForEnd.resolve(); },
    }, { highWaterMark: 0 });
    const result = await runMessages({ fetcher: async () => new Response(source, { status: 400 }), signal: cancelDomain.signal });
    const closing = streamOf(result).close();
    await waitingForEnd.promise;
    cancelDomain.abort();

    await closing;
    expect(await result['response.claudeCode.terminalSentinel']?.promise).toEqual({ kind: 'incomplete', reason: 'cancelled' });
    expect(await result.done).toEqual({ ok: true });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('quota and terminal persistence failures resolve to failure data while done succeeds', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    writeError = new Error('state write failed');
    const trace: RunEvent[] = [];
    const events = (event: RunEvent) => { trace.push(event); };
    const quota = await runMessages({ fetcher: async () => sseResponse(), events });
    await release(quota);
    expect(await quota['response.claudeCode.quota']?.promise).toMatchObject({ persisted: false, error: { message: 'state write failed' } });

    const terminal = await runMessages({
      fetcher: async () => errorJson(400, { error: { type: 'invalid_request_error', message: 'organization has been disabled' } }),
      events,
    });
    await release(terminal);
    expect(await terminal['response.claudeCode.terminalSentinel']?.promise).toMatchObject({ persisted: false, error: { message: 'state write failed' } });
    for (const message of ['claude_code_quota_persist_failed', 'claude_code_terminal_sentinel_persist_failed']) {
      expect(trace).toContainEqual(expect.objectContaining({
        k: 'log', level: 'warn', message, fields: expect.objectContaining({ upstream_id: upstreamId, error: 'Error: state write failed' }),
      }));
    }
  });
});

test('incomplete SSE logs diagnostic context and carries the OAuth bearer as a secret', async () => {
  seedAccount({ accessToken: freshAccessTokenEntry });
  const trace: RunEvent[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<Fetcher>(async () => sseResponse(200, { 'request-id': 'req_incomplete' }));
  const result = await runMessages({ fetcher, events: event => { trace.push(event); } });

  for await (const _frame of result['response.events']!) { /* Exhaust the SSE parser. */ }
  expect(await result.done).toEqual({ ok: true });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude_code_messages_stream_incomplete'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('request_id=req_incomplete'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('raw_sse_frames=1'));
  const terminal = trace.find((event): event is Extract<RunEvent, { k: 'enter' }> => event.k === 'enter' && event.name === 'http');
  const wire = terminal?.facts['request.http'] as HttpRequestFacts | undefined;
  expect(isSecret(wire?.headers.find(([key]) => key === 'authorization')?.[1])).toBe(true);
  expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('authorization')).toBe('Bearer at_cached');
});
