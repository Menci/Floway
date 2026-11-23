import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { toClaudeCodeUpstreamFacts, type ClaudeCodeUpstreamFacts } from '../src/config.ts';
import { claudeCodePipelines } from '../src/pipelines.ts';
import { createClaudeCodeService, type ClaudeCodeService, type ClaudeCodeServices } from '../src/service.ts';
import type {
  ClaudeCodeAccessTokenEntry,
  ClaudeCodeAccountCredential,
  ClaudeCodeQuotaSnapshotEntry,
  ClaudeCodeUpstreamState,
} from '../src/state.ts';
import { observeTerminalSentinel } from '../src/terminal-account.ts';
import { Bytes, compose, defineEnding, defineStage, isManagedStream, isSecret, run, snapshotError, type RunDone, type RunEvent } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { directFetcher, httpTerminal, httpUrl, initProviderRepo, isTransportFailure, toProviderModelFacts, UpstreamTransportError, type Fetcher, type HeaderEntry, type HttpRequestFacts, type HttpResponseBodyChunk, type HttpResponseFacts, type ProviderAnthropicInput, type ProviderAnthropicMessagesOutput, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';
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
let upstreamMissing: boolean;
let claudeCode: ClaudeCodeService;

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
  upstreamMissing = false;
  claudeCode = createClaudeCodeService();
  seedAccount();
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => upstreamMissing ? null : { ...currentRecord, configVersion: 1 },
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

type HttpOutput = { readonly 'response.http': HttpResponseFacts };
type HttpInput = { readonly 'request.http': HttpRequestFacts; readonly 'provider.upstream': ClaudeCodeUpstreamFacts };

const httpInput = (headers: readonly HeaderEntry[] = []): HttpInput => ({
  'provider.upstream': toClaudeCodeUpstreamFacts(currentRecord),
  'request.http': { method: 'POST', url: httpUrl('http://floway.test/v1/messages'), headers, body: null },
});

const tracing = (fetcher: Fetcher, signal?: AbortSignal) => {
  const trace: RunEvent[] = [];
  return {
    trace,
    options: {
      services: { fetcher: () => fetcher, claudeCode },
      finalizationTimeoutMs: 2000,
      events: (event: RunEvent) => { trace.push(event); },
      ...(signal === undefined ? {} : { signal }),
    },
  };
};

interface RunMessagesInput {
  readonly model?: ProviderModel;
  readonly body?: ProviderAnthropicInput['request.payload'];
  readonly headers?: readonly HeaderEntry[];
  readonly anthropicBeta?: readonly string[];
  readonly fetcher?: Fetcher;
}

const runMessages = async ({
  model = sonnetModel, body = minimalBody, headers = [], anthropicBeta = [], fetcher = directFetcher,
}: RunMessagesInput = {}) => {
  const { trace, options } = tracing(fetcher);
  const handle = run(claudeCodePipelines.anthropicMessages, {
    ...httpInput(headers),
    'provider.model': toProviderModelFacts(model),
    'request.payload': body,
    'request.anthropicBeta': anthropicBeta,
  }, options);
  return { ...await handle.result, done: handle.done, trace };
};

const sentinelStage = defineStage<HttpInput, HttpInput, HttpOutput, HttpOutput, ClaudeCodeServices>({
  name: 'observe',
  through: {
    request: { needs: ['provider.upstream'], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http'] },
  },
  async execute(facts, scope) {
    const response = await scope.next(facts);
    return { 'response.http': observeTerminalSentinel(facts['provider.upstream'].id, response['response.http'], scope) };
  },
});

const sentinelPipeline = (source?: AsyncIterable<HttpResponseBodyChunk>) =>
  compose<HttpInput & HttpOutput, ClaudeCodeServices>()('claude-code.sentinel-test', {
    entry: ['provider.upstream', 'request.http'],
    exit: ['response.http'],
    stages: [sentinelStage],
    ending: source === undefined ? httpTerminal : defineEnding<{}, HttpOutput>({
      name: 'body',
      request: { needs: [] },
      return: { provides: ['response.http'] },
      async execute(_facts, scope) {
        return {
          'response.http': {
            status: 400,
            statusText: '',
            headers: [],
            body: scope.createStream({ label: 'test.body', iterate: () => source }),
            timing: { startedAt: 0, headersAt: 0 },
          },
        };
      },
    }),
  });

const runSentinel = async (fetcher: Fetcher, signal?: AbortSignal, source?: AsyncIterable<HttpResponseBodyChunk>) => {
  const { trace, options } = tracing(fetcher, signal);
  const handle = run(sentinelPipeline(source), httpInput(), options);
  return { ...await handle.result, done: handle.done, trace };
};

const settled = (trace: RunEvent[], name: string) => {
  const declaration = trace.find((event): event is Extract<RunEvent, { k: 'deferred' }> => event.k === 'deferred' && event.name === name);
  return declaration === undefined
    ? undefined
    : trace.find((event): event is Extract<RunEvent, { k: 'settled' }> => event.k === 'settled' && event.deferredId === declaration.deferredId);
};
const receipt = ({ trace }: { readonly trace: RunEvent[] }, name: string): unknown => {
  const event = settled(trace, name);
  expect(event).toMatchObject({ k: 'settled', ok: true });
  return event?.ok === true ? event.value : undefined;
};

const successful = ({ 'response.http': { status } }: HttpOutput): boolean => status >= 200 && status < 300;
const headersOf = ({ 'response.http': { headers } }: HttpOutput): Headers =>
  new Headers(headers.map(([name, value]): [string, string] => [name, typeof value === 'string' ? value : value.reveal()]));
const errorOf = (result: ProviderAnthropicMessagesOutput, source: 'local' | 'upstream') => {
  const outcome = result['response.anthropicMessages'];
  expect(outcome).toMatchObject({ kind: 'error', source });
  if (outcome.kind !== 'error') throw new TypeError('Expected an Anthropic Messages error outcome');
  return outcome.error;
};
const streamOf = (result: HttpOutput) => {
  const body = result['response.http'].body;
  if (!isManagedStream(body)) throw new Error('expected a streaming HTTP body');
  return body;
};
const eventsOf = (result: ProviderAnthropicMessagesOutput) => {
  const outcome = result['response.anthropicMessages'];
  if (outcome.kind !== 'stream') throw new TypeError('Expected an Anthropic Messages stream outcome');
  return outcome.events;
};
const release = async (result: HttpOutput & Partial<ProviderAnthropicMessagesOutput> & { done: Promise<RunDone> }) => {
  const outcome = result['response.anthropicMessages'];
  const body = outcome?.kind === 'stream' ? outcome.events : result['response.http'].body;
  if (isManagedStream(body)) await body.close();
  expect(await result.done).toEqual({ ok: true });
};

describe('Claude Code pre-fetch gates', () => {
  test('non-active account → synthetic 503', async () => {
    seedAccount({ state: 'session_terminated', stateMessage: 'revoked' });
    const fetcher = vi.fn<Fetcher>();
    const result = await runMessages({ fetcher });
    expect(result['response.http'].status).toBe(503);
    expect(result['response.http'].exchange).toBeUndefined();
    expect(errorOf(result, 'local')).toMatchObject({ error: { message: expect.stringContaining('revoked') } });
    expect(fetcher).not.toHaveBeenCalled();
    await release(result);
  });

  test('missing upstream is a local 503', async () => {
    upstreamMissing = true;
    const fetcher = vi.fn<Fetcher>();
    const result = await runMessages({ fetcher });
    expect(result['response.http'].status).toBe(503);
    expect(result['response.http'].exchange).toBeUndefined();
    expect(errorOf(result, 'local')).toMatchObject({ error: { message: expect.stringContaining('disappeared') } });
    expect(fetcher).not.toHaveBeenCalled();
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
    expect(result['response.http'].status).toBe(429);
    expect(result['response.http'].exchange).toBeUndefined();
    expect(headersOf(result).get('retry-after')).toBeTruthy();
    expect(errorOf(result, 'local')).toMatchObject({ error: { type: 'claude_code_rate_limited', retry_at: resetIso } });
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
    expect(first['response.http'].status).toBe(429);
    expect(headersOf(first).get('retry-after')).toBe(quotaHeaders['retry-after']);
    expect(errorOf(first, 'upstream')).toEqual(upstreamBody);
    await release(first);
    expect(receipt(first, 'claude-code.quota')).toEqual({ persisted: true });
    expect(readQuotaEntry()).toMatchObject({ modelId: 'claude-fable-5-1', data: { status: 'rejected', representativeClaim: 'seven_day_overage_included' } });

    const again = await runMessages({ model: fableModel, body: minimalBody });
    expect(again['response.http'].status).toBe(429);
    expect(errorOf(again, 'local')).toMatchObject({ error: { type: 'claude_code_rate_limited' } });
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
  test('a shaped request forwards the provider-allowlisted fingerprint and sets Authorization', async () => {
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
        'x-private': 'private',
        'x-stainless-private': 'private',
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
    expect(wireHeaders.has('x-private')).toBe(false);
    expect(wireHeaders.has('x-stainless-private')).toBe(false);
  });

});

describe('Claude Code wire body', () => {
  test('forces stream:true regardless of caller intent', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await runMessages({
      model: sonnetModel,
      body: { ...minimalBody, stream: false },
      headers: [['x-private', 'discard'], ['anthropic-version', 'client-version'], ['x-stainless-os', 'client-os']],
      anthropicBeta: ['client-beta'],
    });
    await release(result);
    const request = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = await readJsonRequest(request) as AnthropicMessagesPayload;
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    const headers = new Headers(request.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-stainless-os')).toBe('Linux');
    expect(headers.get('anthropic-beta')).not.toContain('client-beta');
    expect(headers.has('x-private')).toBe(false);
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
    expect(result['response.http'].status).toBe(401);
    expect(errorOf(result, 'upstream')).toEqual({ error: { type: 'authentication_error', message: 'still expired' } });
    await release(result);
  });

  test('rejected setup token becomes terminal without replaying the bearer', async () => {
    seedAccount({ tokenKind: 'setup-token', refreshToken: null, accessToken: freshAccessTokenEntry });
    const fetcher = vi.fn<Fetcher>(async () => errorJson(401, { error: { type: 'authentication_error', message: 'revoked' } }));
    const result = await runMessages({ fetcher });

    expect(result['response.http'].status).toBe(503);
    expect(errorOf(result, 'upstream')).toMatchObject({ error: { message: expect.stringContaining('Setup token rejected') } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(currentState().accounts[0]).toMatchObject({ state: 'refresh_failed', accessToken: null });
    await release(result);
  });
});

describe('Claude Code quota persistence', () => {
  test('2xx exposes a quota persistence deferred', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse());
    const result = await runMessages({ model: sonnetModel, body: minimalBody });
    expect(successful(result)).toBe(true);
    await release(result);
    expect(receipt(result, 'claude-code.quota')).toEqual({ persisted: true });
    expect(readQuotaEntry()).toMatchObject({
      modelId: sonnetProviderData.upstreamModelId,
      data: { status: 'allowed', fiveHour: { status: 'allowed', utilization: 0 } },
    });
  });
});

const disabledOrganization = { error: { type: 'invalid_request_error', message: 'organization has been disabled' } };
const disabledOrganizationBytes = Bytes.fromUtf8(JSON.stringify(disabledOrganization));
const interruptedAfterSentinel = (error: Error) => new ReadableStream<Uint8Array>({
  start(controller) { controller.enqueue(disabledOrganizationBytes.toUint8Array()); },
  pull(controller) { controller.error(error); },
}, { highWaterMark: 0 });

const textPart = (part: IteratorResult<HttpResponseBodyChunk>): string => {
  if (part.done || isTransportFailure(part.value)) throw new TypeError('Expected an HTTP byte chunk');
  return part.value.utf8();
};

describe('Claude Code terminal sentinel detection', () => {
  test.each([
    [400, 'invalid_request_error', 'organization has been disabled', 'org_disabled_400_sentinel'],
    [403, 'permission_error', 'OAuth authentication is currently not allowed', 'org_banned_403_sentinel'],
  ] as const)('preserves a %s response verbatim and flips the account on a terminal sentinel', async (status, type, message, reason) => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const body = { error: { type, message }, padding: 'x'.repeat(1200) };
    const result = await runMessages({ fetcher: async () => errorJson(status, body) });

    expect(result['response.http'].status).toBe(status);
    expect(result['response.http'].exchange).toBe('upstream');
    expect(errorOf(result, 'upstream')).toEqual(body);
    await release(result);
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ persisted: true });
    expect(currentState().accounts[0]).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining(message), accessToken: null });
    expect(result.trace).toContainEqual(expect.objectContaining({ k: 'log', message: 'claude_code_terminal_sentinel_detected', fields: expect.objectContaining({ reason }) }));
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
    const result = await runSentinel(async () => new Response(source, { status: 400 }));
    const reader = streamOf(result)[Symbol.asyncIterator]();
    expect(textPart(await reader.next())).toBe(prefix);
    expect(currentState().accounts[0]!.state).toBe('active');
    gate.resolve();
    expect(textPart(await reader.next())).toBe('}}');
    expect((await reader.next()).done).toBe(true);
    expect(await result.done).toEqual({ ok: true });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ persisted: true });
  });

  test('marks a transport failure during the release drain as unreadable', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const upstreamError = new Error('upstream body failed');
    const result = await runSentinel(async () => new Response(interruptedAfterSentinel(upstreamError), { status: 400 }));
    expect(result['response.http'].status).toBe(400);
    await release(result);
    expect(receipt(result, 'claude-code.terminal-sentinel.verdict')).toMatchObject({ kind: 'unreadable', error: { message: upstreamError.message } });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toMatchObject({ kind: 'unreadable', error: { message: upstreamError.message } });
    expect(result.trace).toContainEqual(expect.objectContaining({ k: 'log', level: 'warn', message: 'claude_code_terminal_sentinel_body_read_failed' }));
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('forwards a transport failure during transform and settles the observed sentinel as unreadable', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const failure = { type: 'transport-error', error: snapshotError(new Error('upstream body failed during delivery')) } as const;
    const source = async function* () {
      yield disabledOrganizationBytes;
      yield failure;
    };
    const result = await runSentinel(directFetcher, undefined, source());
    const reader = streamOf(result)[Symbol.asyncIterator]();
    expect(textPart(await reader.next())).toBe(disabledOrganizationBytes.utf8());
    expect((await reader.next()).value).toBe(failure);
    expect((await reader.next()).done).toBe(true);
    expect(await result.done).toEqual({ ok: true });
    expect(receipt(result, 'claude-code.terminal-sentinel.verdict')).toEqual({ kind: 'unreadable', error: failure.error });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ kind: 'unreadable', error: failure.error });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('propagates an unexpected drain error and rejects the stream verdict', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const error = new Error('broken upstream body iterator');
    const source = async function* () {
      yield disabledOrganizationBytes;
      throw error;
    };
    const result = await runSentinel(directFetcher, undefined, source());
    await expect(streamOf(result).close()).rejects.toBe(error);
    expect(await result.done).toMatchObject({ ok: false, error: { message: error.message } });
    expect(settled(result.trace, 'claude-code.terminal-sentinel.verdict')).toMatchObject({ ok: false, error: { message: error.message } });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('detects an unread sentinel on release without pulling it before release', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode('{"error":{"type":"invalid_request_error","message":"organization has been disabled"}}'));
      controller.close();
    });
    const stream = new ReadableStream({ pull }, { highWaterMark: 0 });
    const result = await runSentinel(async () => new Response(stream, { status: 400 }));
    expect(pull).not.toHaveBeenCalled();
    await release(result);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ persisted: true });
    expect(currentState().accounts[0]).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining('organization has been disabled') });
  });

  test('relays a body beyond the observer byte limit and records an incomplete verdict', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const document = { error: { type: 'invalid_request_error', message: 'organization has been disabled' }, padding: 'x'.repeat(65536) };
    const result = await runMessages({ fetcher: async () => errorJson(400, document) });

    expect(errorOf(result, 'upstream')).toEqual(document);
    await release(result);
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ kind: 'incomplete', reason: 'byte_limit' });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('bounds a release drain and cancels the stalled physical read', async () => {
    vi.useFakeTimers();
    seedAccount({ accessToken: freshAccessTokenEntry });
    const reading = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull: () => reading.resolve(), cancel }, { highWaterMark: 0 });
    const result = await runSentinel(async () => new Response(source, { status: 400 }));
    const close = streamOf(result).close();
    await reading.promise;
    await vi.advanceTimersByTimeAsync(1000);

    await expect(close).resolves.toBeUndefined();
    expect(await result.done).toEqual({ ok: true });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ kind: 'incomplete', reason: 'deadline' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('settles an unread sentinel as incomplete when the caller cancels', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const controller = new AbortController();
    const pull = vi.fn();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const result = await runSentinel(async () => new Response(stream, { status: 400 }), controller.signal);

    controller.abort(new Error('caller disconnected'));
    expect(await result.done).toEqual({ ok: true });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ kind: 'incomplete', reason: 'cancelled' });
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
    const result = await runSentinel(async () => new Response(source, { status: 400 }), cancelDomain.signal);
    const closing = streamOf(result).close();
    await waitingForEnd.promise;
    cancelDomain.abort();

    await closing;
    expect(await result.done).toEqual({ ok: true });
    expect(receipt(result, 'claude-code.terminal-sentinel')).toEqual({ kind: 'incomplete', reason: 'cancelled' });
    expect(currentState().accounts[0]!.state).toBe('active');
  });

  test('quota and terminal persistence failures resolve to failure data while done succeeds', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    writeError = new Error('state write failed');
    const quota = await runMessages({ fetcher: async () => sseResponse() });
    await release(quota);
    expect(receipt(quota, 'claude-code.quota')).toMatchObject({ persisted: false, error: { message: 'state write failed' } });

    const terminal = await runMessages({ fetcher: async () => errorJson(400, disabledOrganization) });
    await release(terminal);
    expect(receipt(terminal, 'claude-code.terminal-sentinel')).toMatchObject({ persisted: false, error: { message: 'state write failed' } });
    for (const { trace, message } of [
      { trace: quota.trace, message: 'claude_code_quota_persist_failed' },
      { trace: terminal.trace, message: 'claude_code_terminal_sentinel_persist_failed' },
    ]) {
      expect(trace).toContainEqual(expect.objectContaining({
        k: 'log', level: 'warn', message, fields: expect.objectContaining({ upstream_id: upstreamId, error: 'Error: state write failed' }),
      }));
    }
  });
});

describe('Claude Code upstream error outcomes', () => {
  test('OAuth session termination records upstream failure', async () => {
    const fetcher = vi.fn<Fetcher>(async () => errorJson(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }));
    const result = await runMessages({ fetcher });

    expect(result['response.http'].status).toBe(503);
    expect(errorOf(result, 'upstream')).toEqual({ error: { type: 'claude_code_upstream_unavailable', message: 'Claude Code refresh failed: Refresh token revoked' } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(currentState().accounts[0].state).toBe('refresh_failed');
    await release(result);
  });

  test('OAuth nonterminal HTTP failure records upstream failure and keeps the account active', async () => {
    const fetcher = vi.fn<Fetcher>(async () => errorJson(503, { detail: 'OAuth temporarily unavailable' }));
    const result = await runMessages({ fetcher });

    expect(errorOf(result, 'upstream')).toMatchObject({ error: { message: expect.stringContaining('OAuth temporarily unavailable') } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(currentState().accounts[0].state).toBe('active');
    await release(result);
  });

  test.each(['OAuth', 'Messages'])('%s transport rejection returns a 502', async operation => {
    if (operation === 'Messages') seedAccount({ accessToken: freshAccessTokenEntry });
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new UpstreamTransportError(new Error('connection refused')));
    const result = await runMessages({ fetcher });

    expect(result['response.http']).toMatchObject({ status: 502, transportError: { message: 'connection refused' } });
    expect(errorOf(result, 'upstream')).toEqual({ error: { type: 'upstream_transport_error', message: 'connection refused' } });
    expect(fetcher).toHaveBeenCalledOnce();
    await release(result);
  });

  test('non-JSON upstream error produces a protocol error with the upstream status', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const result = await runMessages({ fetcher: async () => new Response('upstream overloaded', { status: 503 }) });

    expect(result['response.http']).toMatchObject({ status: 503, exchange: 'upstream', body: null });
    expect(errorOf(result, 'upstream')).toEqual({ error: { type: 'upstream_error', message: 'upstream overloaded' } });
    await release(result);
  });

  test('2xx wrong MIME produces a protocol error with the body snippet', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const result = await runMessages({ fetcher: async () => new Response('upstream returned HTML', { headers: { 'content-type': 'text/html' } }) });

    expect(result['response.http']).toMatchObject({ status: 502, exchange: 'upstream', body: null });
    expect(errorOf(result, 'upstream')).toMatchObject({ error: { type: 'upstream_invalid_stream', message: expect.stringContaining('upstream returned HTML') } });
    await release(result);
  });

  test('interrupted 400 error body produces a transport error outcome and keeps the account active', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const error = new Error('incomplete upstream error response');
    const result = await runMessages({ fetcher: async () => new Response(interruptedAfterSentinel(error), { status: 400 }) });

    expect(result['response.http']).toMatchObject({ status: 502, exchange: 'upstream', transportError: { message: error.message } });
    expect(errorOf(result, 'upstream')).toEqual({ error: { type: 'upstream_transport_error', message: error.message } });
    await release(result);
    expect(receipt(result, 'claude-code.terminal-sentinel')).toMatchObject({ kind: 'unreadable', error: { message: error.message } });
    expect(currentState().accounts[0].state).toBe('active');
  });

  test('mid-SSE transport failure is the terminal protocol frame', async () => {
    seedAccount({ accessToken: freshAccessTokenEntry });
    const error = new Error('incomplete event stream');
    const bytes = Bytes.fromUtf8('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.toUint8Array()); },
      pull(controller) { controller.error(error); },
    }, { highWaterMark: 0 });
    const result = await runMessages({
      fetcher: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    });

    const events = await Array.fromAsync(eventsOf(result));
    expect(events).toMatchObject([
      { type: 'event', event: { type: 'message_stop' } },
      { type: 'transport-error', error: { message: error.message } },
    ]);
    expect(await result.done).toEqual({ ok: true });
  });
});

test('incomplete SSE logs diagnostic context and carries the OAuth bearer as a secret', async () => {
  seedAccount({ accessToken: freshAccessTokenEntry });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const fetcher = vi.fn<Fetcher>(async () => sseResponse(200, { 'request-id': 'req_incomplete' }));
  const result = await runMessages({ fetcher });

  for await (const _frame of eventsOf(result)) { /* Exhaust the SSE parser. */ }
  expect(await result.done).toEqual({ ok: true });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude_code_messages_stream_incomplete'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('request_id=req_incomplete'));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('raw_sse_frames=1'));
  const terminal = result.trace.find((event): event is Extract<RunEvent, { k: 'enter' }> => event.k === 'enter' && event.name === 'http');
  const wire = terminal?.facts['request.http'] as HttpRequestFacts | undefined;
  expect(isSecret(wire?.headers.find(([key]) => key === 'authorization')?.[1])).toBe(true);
  expect(new Headers(fetcher.mock.calls[0]?.[1].headers).get('authorization')).toBe('Bearer at_cached');
});
