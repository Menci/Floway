import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { parseMetadataUserID } from '../src/detection.ts';
import { wireClaudeCodeRequest } from '../src/pipelines.ts';
import { createClaudeCodeProvider } from '../src/provider.ts';
import type { ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../src/state.ts';
import { computeStageDiffs, createDumpEncoder, createDumpDecoder, defineStage, isSecret, pipeline, runPipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, ManagedStream, RawRunEvent } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenWire } from '@floway-dev/protocols/common';
import { httpTerminal, initProviderRepo, isReplayableBody, readManagedBytes, toProviderModelFacts, type HttpOutcome, type ProviderPipelineServices, type UpstreamRecord, type UpstreamHttpRequest } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const upstreamId = 'up_cc_pipeline';
const upstreamModelId = 'claude-sonnet-4-5-20250929';
const providerModel = stubProviderModel({
  id: 'claude-sonnet-4-5',
  limits: { max_output_tokens: 64_000 },
  providerData: { upstreamModelId },
});

const cachedToken = 'at_cached';
const freshToken = 'at_fresh';
const oauthBearer = `Bearer ${cachedToken}`;

const account = (overrides: Partial<ClaudeCodeAccountCredential> = {}): ClaudeCodeAccountCredential => ({
  accountUuid: 'acc-1',
  tokenKind: 'oauth',
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: {
    token: cachedToken,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    refreshedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  quotaSnapshot: null,
  usageProbeSnapshot: null,
  ...overrides,
} as ClaudeCodeAccountCredential);

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: {
    accounts: [{
      email: 'claude@example.com',
      accountUuid: 'acc-1',
      organizationUuid: null,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    }],
  },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

let currentRecord: UpstreamRecord;
let backgroundStateWriteFailure: Error | null = null;

const state = (): ClaudeCodeUpstreamState => currentRecord.state as ClaudeCodeUpstreamState;

const seed = (overrides: Partial<ClaudeCodeAccountCredential> = {}): void => {
  currentRecord = makeRecord({ accounts: [account(overrides)] });
};

beforeEach(() => {
  backgroundStateWriteFailure = null;
  seed();
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => undefined,
    upstreams: {
      getById: async () => ({ ...currentRecord, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        if (backgroundStateWriteFailure !== null) throw backgroundStateWriteFailure;
        currentRecord = { ...currentRecord, state: mutate(currentRecord.state, 1) };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

const sseBody = (events = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
]): string => events.join('');

const sseResponse = (body = sseBody(), extraHeaders: Record<string, string> = {}): Response => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/event-stream', ...extraHeaders },
});

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

const requestJSON = async (init: RequestInit): Promise<Record<string, unknown>> => {
  const body = init.body;
  if (isReplayableBody(body)) return await new Response(body.open()).json() as Record<string, unknown>;
  return await new Response(body as BodyInit).json() as Record<string, unknown>;
};

const services = (fetcher: (url: string, init: RequestInit) => Promise<Response>): ProviderPipelineServices => ({
  fetcherFor: () => fetcher as never,
});

const runMessages = async (
  payload: Record<string, unknown>,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  options: {
    readonly headers?: readonly HeaderEntry[];
    readonly beta?: readonly string[];
    readonly events?: RawRunEvent[];
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  } = {},
) => {
  const provider = createClaudeCodeProvider(currentRecord);
  const traceSink = options.events === undefined ? undefined : { push: (event: RawRunEvent) => options.events!.push(event) };
  const result = await runPipeline(provider.pipelines!.anthropicMessages!, {
    'provider.model': toProviderModelFacts(providerModel),
    'request.payload': payload as Omit<AnthropicMessagesPayload, 'model'>,
    'request.inboundHeaders': options.headers ?? [],
    'request.anthropicBeta': options.beta ?? [],
  }, {
    services: services(fetcher),
    ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
    ...(traceSink === undefined ? {} : { traceSink }),
  });
  return result;
};

const readEvents = async (stream: ManagedStream<OpenWire<never>>): Promise<void> => {
  for await (const _event of stream) {
    // Consume the full stream so its completion and observation hooks run.
  }
};

const runEvents = async (events: readonly RawRunEvent[]): Promise<string[]> => {
  return events.filter((event): event is Extract<RawRunEvent, { readonly k: 'enter' }> => event.k === 'enter').map(event => event.name);
};

describe('Claude Code ProviderPipelines', () => {
  test('unshaped requests expose all six shaping stages and produce the canonical CC payload', async () => {
    const events: RawRunEvent[] = [];
    let wireBody: Record<string, unknown> | null = null;
    const result = await runMessages(
      { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
      async (_url, init) => {
        wireBody = await requestJSON(init);
        return sseResponse();
      },
      { events },
    );
    expect(result.ok).toBe(true);
    if (result.ok) await readEvents(result.events as ManagedStream<OpenWire<never>>);
    expect(await runEvents(events)).toEqual([
      'detectClaudeCodeShape',
      'backfillRequiredFields',
      'synthesizeMetadataUserId',
      'hoistUserSystemToMessages',
      'injectBillingBlock',
      'injectIdentityBlock',
      'injectDefaultTemplate',
      'authenticateClaudeCode',
      'wireClaudeCodeRequest',
      `${upstreamId}.http`,
    ]);
    expect(wireBody).not.toBeNull();
    const system = wireBody!.system as { type: string; text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(3);
    expect(system[0]!.text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3};/);
    expect(system[1]!.text).toMatch(/^You are Claude Code/);
    expect(system[2]!.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    const userId = (wireBody!.metadata as { user_id: string }).user_id;
    expect(parseMetadataUserID(userId)?.isNewFormat).toBe(true);
  });

  test('shaped requests bypass every shaping stage and preserve the client fingerprint', async () => {
    const userId = JSON.stringify({ device_id: 'd'.repeat(64), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const inboundHeaders: readonly HeaderEntry[] = [
      ['user-agent', 'claude-cli/2.1.280 (external, cli)'],
      ['x-app', 'cli'],
      ['anthropic-version', '2023-06-01'],
      ['x-client-request-id', 'client-request'],
    ];
    const sessionSecret = secret('shaped-session-value');
    const headers: readonly HeaderEntry[] = [...inboundHeaders, ['x-claude-code-session-id', sessionSecret]];
    const events: RawRunEvent[] = [];
    const result = await runMessages({
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hello' }],
      system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      metadata: { user_id: userId },
    }, async (_url, init) => {
      const wire = new Headers(init.headers);
      expect(wire.get('x-client-request-id')).toBe('client-request');
      const body = await requestJSON(init);
      expect((body.metadata as { user_id: string }).user_id).toBe(userId);
      expect((body.system as unknown[])).toHaveLength(1);
      return sseResponse();
    }, { headers, beta: ['oauth-2025-04-20'], events });
    expect(result.ok).toBe(true);
    if (result.ok) await readEvents(result.events as ManagedStream<OpenWire<never>>);
    const stageNames = await runEvents(events);
    expect(stageNames.slice(1, 7)).toEqual([
      'backfillRequiredFields',
      'synthesizeMetadataUserId',
      'hoistUserSystemToMessages',
      'injectBillingBlock',
      'injectIdentityBlock',
      'injectDefaultTemplate',
    ]);
    const decoder = createDumpDecoder();
    decoder.pushEvents(createDumpEncoder({ detectRawSecretLeaks: true }).encodeBatch(events));
    const model = decoder.view();
    const shapingNames = new Set([
      'backfillRequiredFields',
      'synthesizeMetadataUserId',
      'hoistUserSystemToMessages',
      'injectBillingBlock',
      'injectIdentityBlock',
      'injectDefaultTemplate',
    ]);
    for (const stage of model.stages.values()) {
      if (!shapingNames.has(stage.name)) continue;
      const diffs = computeStageDiffs(model, decoder, stage.stageId);
      expect(diffs.downward.flatMap(diff => diff.entries)).toEqual([]);
    }
  });

  test('shaped wire headers preserve inbound Secret entries', async () => {
    const sessionSecret = secret('session-secret');
    const inbound: readonly HeaderEntry[] = [
      ['x-client-request-id', 'request-1'],
      ['anthropic-beta', 'client-beta'],
      ['x-claude-code-session-id', sessionSecret],
    ];
    let captured: readonly HeaderEntry[] | undefined;
    const capture = defineStage<
      { readonly 'request.http': UpstreamHttpRequest; readonly 'provider.modelKey': string },
      Record<never, never>,
      HttpOutcome,
      HttpOutcome,
      never,
      ProviderPipelineServices
    >({
      name: 'capture',
      execute: async (facts, next) => {
        captured = facts['request.http'].headers;
        return await next();
      },
    });
    const wirePipeline = pipeline<{
      readonly 'provider.model': ReturnType<typeof toProviderModelFacts>;
      readonly 'request.payload': Omit<AnthropicMessagesPayload, 'model'>;
      readonly 'request.inboundHeaders': readonly HeaderEntry[];
      readonly 'request.anthropicBeta': readonly string[];
      readonly 'claudeCode.shaped': boolean;
      readonly 'claudeCode.accessToken': ReturnType<typeof secret>;
    }>('wire-headers') as unknown as {
      use: (stage: typeof wireClaudeCodeRequest) => {
        use: (stage: typeof capture) => {
          end: (ending: ReturnType<typeof httpTerminal>) => unknown;
        };
      };
    };
    const result = await runPipeline(wirePipeline
      .use(wireClaudeCodeRequest)
      .use(capture)
      .end(httpTerminal(upstreamId)) as never, {
      'provider.model': toProviderModelFacts(providerModel),
      'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] } as Omit<AnthropicMessagesPayload, 'model'>,
      'request.inboundHeaders': inbound,
      'request.anthropicBeta': ['server-beta'],
      'claudeCode.shaped': true,
      'claudeCode.accessToken': secret(`Bearer ${cachedToken}`),
    } as never, { services: services(async () => sseResponse()) }) as HttpOutcome;
    expect(result.status).toBe(200);
    if (result.body !== null) await readManagedBytes(result.body);
    expect(captured?.find(([name]) => name === 'x-claude-code-session-id')?.[1]).toBe(sessionSecret);
    expect(isSecret(captured?.find(([name]) => name === 'x-claude-code-session-id')?.[1])).toBe(true);
    expect(captured?.find(([name]) => name === 'anthropic-beta')?.[1]).toBe('server-beta');
    expect(captured?.filter(([name]) => name === 'anthropic-beta')).toHaveLength(1);
    expect(captured?.find(([name]) => name === 'content-type')?.[1]).toBe('application/json');
    expect(isSecret(captured?.find(([name]) => name === 'authorization')?.[1])).toBe(true);
  });

  test('quota and inactive-account gates short-circuit without fetching', async () => {
    const reset = new Date(Date.now() + 60_000).toISOString();
    seed({
      quotaSnapshot: {
        fetchedAt: Date.now(),
        data: {
          status: 'rejected',
          reset,
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
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
    const limited = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher);
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.http.status).toBe(429);
      expect(limited.http.headers.find(([name]) => name === 'retry-after')?.[1]).toBeTruthy();
      expect(JSON.parse(new TextDecoder().decode(await readManagedBytes(limited.http.body)))).toMatchObject({ error: { type: 'claude_code_rate_limited', retry_at: reset } });
    }
    expect(fetcher).not.toHaveBeenCalled();

    seed({ state: 'session_terminated', stateMessage: 'revoked' });
    const inactive = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher);
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.http.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('OAuth session termination maps to a synthetic 503', async () => {
    seed({ accessToken: null, refreshToken: 'dead-refresh' });
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(jsonResponse(400, { error: 'invalid_grant', error_description: 'revoked' }));
    const result = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.http.status).toBe(503);
      expect(JSON.parse(new TextDecoder().decode(await readManagedBytes(result.http.body)))).toMatchObject({
        error: { type: 'claude_code_upstream_unavailable' },
      });
    }
  });

  test('cached-token 401 drains, invalidates, mints, and retries once', async () => {
    const events: RawRunEvent[] = [];
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(401, { error: { type: 'authentication_error', message: 'expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: freshToken, refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }))
      .mockResolvedValueOnce(sseResponse());
    const result = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher, { events });
    expect(result.ok).toBe(true);
    if (result.ok) await readEvents(result.events as ManagedStream<OpenWire<never>>);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(state().accounts[0]!.accessToken?.token).toBe(freshToken);
    expect(events.some(event => event.k === 'end' && event.how === 'discarded')).toBe(true);
  });

  test('freshly minted 401 is not retried and preserves the second response', async () => {
    seed({ accessToken: null });
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: freshToken, refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { type: 'authentication_error', message: 'still bad' } }));
    const result = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.http.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('two consecutive 401 responses surface the second body', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse(401, { error: { type: 'authentication_error', message: 'first rejected' } }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: freshToken, refresh_token: 'rt_v2', token_type: 'Bearer', expires_in: 600, scope: '' }))
      .mockResolvedValueOnce(jsonResponse(401, { error: { type: 'authentication_error', message: 'second rejected' } }));
    const result = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.http.status).toBe(401);
      expect(JSON.parse(new TextDecoder().decode(await readManagedBytes(result.http.body)))).toEqual({
        error: { type: 'authentication_error', message: 'second rejected' },
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('2xx quota headers persist through waitUntil', async () => {
    const pending: Promise<unknown>[] = [];
    const result = await runMessages(
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      async () => sseResponse(sseBody(), {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.25',
      }),
      { waitUntil: promise => pending.push(promise) },
    );
    expect(result.ok).toBe(true);
    if (result.ok) await readEvents(result.events as ManagedStream<OpenWire<never>>);
    await Promise.all(pending);
    expect(state().accounts[0]!.quotaSnapshot).toMatchObject({
      modelId: upstreamModelId,
      data: { status: 'allowed', fiveHour: { status: 'allowed', utilization: 0.25 } },
    });
  });

  test('400 and 403 terminal sentinels flip state in waitUntil while preserving the full body', async () => {
    for (const [status, type, message, reason] of [
      [400, 'invalid_request_error', 'organization has been disabled', 'org_disabled_400_sentinel'],
      [403, 'permission_error', 'OAuth authentication is currently not allowed', 'org_banned_403_sentinel'],
    ] as const) {
      seed();
      const body = { error: { type, message }, padding: 'x'.repeat(1200) };
      const pending: Promise<unknown>[] = [];
      const result = await runMessages({ max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, async () => jsonResponse(status, body), {
        waitUntil: promise => pending.push(promise),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.http.status).toBe(status);
        expect(JSON.parse(new TextDecoder().decode(await readManagedBytes(result.http.body)))).toEqual(body);
      }
      await Promise.all(pending);
      expect(state().accounts[0]!.state).toBe('refresh_failed');
      expect(state().accounts[0]!.stateMessage).toContain(message);
      expect(reason).toBeTruthy();
    }
  });

  test('background quota and terminal persistence failures are logged without rejecting waitUntil', async () => {
    const warnings: { message: string; fields: Readonly<Record<string, unknown>> }[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((message: string) => {
      const separator = message.search(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/);
      const event = separator < 0 ? message : message.slice(0, separator);
      const rest = separator < 0 ? '' : message.slice(separator + 1);
      const fields: Record<string, string> = {};
      for (const part of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|[^ ]+)/g)) {
        const raw = part[2]!;
        fields[part[1]!] = raw.startsWith('"') ? JSON.parse(raw) as string : raw;
      }
      warnings.push({ message: event, fields });
    });
    backgroundStateWriteFailure = new Error('state write failed');
    const pending: Promise<unknown>[] = [];
    const quota = await runMessages(
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      async () => sseResponse(sseBody(), { 'anthropic-ratelimit-unified-status': 'allowed' }),
      { waitUntil: promise => pending.push(promise) },
    );
    expect(quota.ok).toBe(true);
    if (quota.ok) await quota.events.close();
    await expect(Promise.all(pending)).resolves.toBeDefined();

    backgroundStateWriteFailure = new Error('state write failed');
    pending.length = 0;
    const terminal = await runMessages(
      { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
      async () => jsonResponse(400, { error: { type: 'invalid_request_error', message: 'organization has been disabled' } }),
      { waitUntil: promise => pending.push(promise) },
    );
    expect(terminal.ok).toBe(false);
    if (!terminal.ok && terminal.http.body !== null) await readManagedBytes(terminal.http.body);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(warnings.some(warning => warning.message === 'claude_code_quota_persist_failed')).toBe(true);
    expect(warnings.some(warning => warning.message === 'claude_code_terminal_sentinel_persist_failed')).toBe(true);
    expect(warnings.some(warning =>
      warning.message === 'claude_code_quota_persist_failed'
      && warning.fields.upstream_id === upstreamId
      && warning.fields.error === 'Error: state write failed')).toBe(true);
    warn.mockRestore();
  });

  test('incomplete SSE emits a warning and dump encoding never reveals the OAuth bearer', async () => {
    const events: RawRunEvent[] = [];
    const logs: string[] = [];
    const fetcher = async () => sseResponse(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: upstreamModelId, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
    const provider = createClaudeCodeProvider(currentRecord);
    const result = await runPipeline(provider.pipelines!.anthropicMessages!, {
      'provider.model': toProviderModelFacts(providerModel),
      'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] } as Omit<AnthropicMessagesPayload, 'model'>,
      'request.inboundHeaders': [],
      'request.anthropicBeta': [],
    }, {
      services: services(fetcher),
      traceSink: {
        push: event => events.push(event),
        registerSecretPlaintext: plaintext => {
          if (plaintext.includes(cachedToken)) logs.push(plaintext);
        },
      },
      logger: (_id, _name, entry) => logs.push(`${entry.message} ${JSON.stringify(entry.fields ?? {})}`),
    });
    expect(result.ok).toBe(true);
    if (result.ok) await readEvents(result.events as ManagedStream<OpenWire<never>>);
    expect(logs.some(line => line.includes('claude_code_messages_stream_incomplete'))).toBe(true);
    const dumpEncoder = createDumpEncoder({ detectRawSecretLeaks: true });
    const encoded = events.flatMap(event => dumpEncoder.encodeBatch([event]));
    expect(JSON.stringify(encoded)).not.toContain(cachedToken);
    expect(JSON.stringify(encoded)).not.toContain(oauthBearer);
  });
});
