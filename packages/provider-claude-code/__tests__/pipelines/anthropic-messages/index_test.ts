import { describe, expect, test, vi } from 'vitest';

import { toClaudeCodeUpstream } from '../../../src/config.ts';
import { parseMetadataUserID } from '../../../src/detection.ts';
import { claudeCodePipelines } from '../../../src/pipelines/anthropic-messages/index.ts';
import { createClaudeCodeService } from '../../../src/service.ts';
import type { ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../../../src/state.ts';
import { getHeader, UpstreamTransportError, type HttpHeaders, type HttpRequestFact, type ProviderFetcher } from '@floway-dev/http';
import { run, Secret, type RunEvent } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { toProviderModelFact, type ProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const upstreamModelId = 'claude-sonnet-4-5-20250929';
const model = toProviderModelFact(stubProviderModel({
  id: 'claude-sonnet-4-5',
  endpoints: { anthropicMessages: {} },
  providerData: { upstreamModelId },
}));
const body: AnthropicMessagesPayload = {
  model: 'client-alias',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hello' }],
  stream: false,
};

const activeAccount: ClaudeCodeAccountCredential = {
  accountUuid: 'account',
  tokenKind: 'oauth',
  refreshToken: 'refresh-old',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: { token: 'access-cached', expiresAt: Date.now() + 86_400_000, refreshedAt: '2026-01-01T00:00:00Z' },
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};
const upstream: UpstreamRecord = {
  id: 'claude-code',
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  config: { accounts: [{ email: null, accountUuid: 'account', organizationUuid: null, subscriptionType: 'max', rateLimitTier: null }] },
  state: { accounts: [activeAccount] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

const fixture = (account: ClaudeCodeAccountCredential = activeAccount) => {
  let state: ClaudeCodeUpstreamState = { accounts: [account] };
  const recordUpstreamMetric = vi.fn<ProviderRepo['recordUpstreamMetric']>(async () => {});
  const saveState = vi.fn<ProviderRepo['upstreams']['saveState']>(async (_id, mutate) => {
    state = mutate(state, 1) as ClaudeCodeUpstreamState;
  });
  const repo: ProviderRepo = {
    recordUpstreamMetric,
    upstreams: { getById: async () => ({ ...upstream, state, configVersion: 1 }), saveState },
  };
  const claudeCode = createClaudeCodeService(repo);
  const events: RunEvent[] = [];
  const tasks: Promise<unknown>[] = [];
  return {
    events,
    tasks,
    recordUpstreamMetric,
    saveState,
    account: () => state.accounts[0],
    start(fetch: ProviderFetcher, options: { payload?: AnthropicMessagesPayload; headers?: HttpHeaders; model?: typeof model; controller?: AbortController } = {}) {
      const controller = options.controller ?? new AbortController();
      const running = run(claudeCodePipelines.anthropicMessages, {
        'request.http': { method: 'POST', url: 'https://gateway.test/v1/messages', headers: options.headers ?? [], body: new Uint8Array([5]) },
        'request.anthropicMessages': options.payload ?? body,
        'provider.model': options.model ?? model,
        'provider.upstream': toClaudeCodeUpstream(upstream),
      }, {
        signal: controller.signal,
        services: { claudeCode, fetcher: () => fetch },
        waitUntil: task => { tasks.push(task); },
        events: event => { events.push(event); },
      });
      return { running: { ...running, abort: () => { controller.abort(); } }, controller };
    },
  };
};

type Running = ReturnType<ReturnType<typeof fixture>['start']>['running'];

const outcomeOf = async (running: Running) => {
  let streaming = false;
  try {
    const outcome = (await running.result)['response.anthropicMessages'];
    streaming = outcome.kind === 'stream';
    return outcome;
  } finally {
    if (!streaming) running.abort();
  }
};

const readStream = async (running: Running) => {
  try {
    const outcome = await outcomeOf(running);
    if (outcome.kind !== 'stream') throw new Error('Expected Claude Code stream');
    const items = await Array.fromAsync(running.read(outcome.stream));
    await running.done;
    return items;
  } finally {
    running.abort();
  }
};

const sse = (headers: Record<string, string> = {}, events = 'event: message_stop\ndata: {"type":"message_stop"}\n\n') =>
  new Response(events, { headers: { 'content-type': 'text/event-stream', ...headers } });

const fetchResponse = (response: () => Response) => vi.fn<ProviderFetcher>(async () => ({ response: response() }));

const wireOf = (fetch: ReturnType<typeof fetchResponse>) => {
  const [url, { body: bytes, headers }] = fetch.mock.calls.at(-1)!;
  if (!(bytes instanceof Uint8Array)) throw new Error('Expected HTTP request bytes');
  return { url, headers: new Headers(headers), payload: JSON.parse(new TextDecoder().decode(bytes)) as AnthropicMessagesPayload };
};

describe('Claude Code Anthropic Messages pipeline', () => {
  test('shapes an unmodified client payload and serializes the dated model as a stream request', async () => {
    const host = fixture();
    const fetch = fetchResponse(() => sse());
    const sharedSystem = 'Keep answers short.';
    const payload = { ...body, system: sharedSystem };
    const { running } = host.start(fetch, { payload });
    expect(await readStream(running)).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
    const wire = wireOf(fetch);
    expect(wire.payload.model).not.toBe(model.id);
    expect((await running.result)['response.usageModelKey']).toBe(wire.payload.model);
    expect(wire.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(wire.headers.get('authorization')).toBe('Bearer access-cached');
    expect(wire.headers.get('user-agent')).toMatch(/^claude-cli\//);
    expect(wire.payload).toMatchObject({
      model: upstreamModelId,
      stream: true,
      max_tokens: 16,
      temperature: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `[System Instructions]\n${sharedSystem}` }] },
        { role: 'assistant' },
        body.messages[0],
      ],
      system: [
        { text: expect.stringMatching(/^x-anthropic-billing-header:/) },
        { text: expect.stringMatching(/^You are Claude Code/) },
        { cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    });
    expect(payload.system).toBe(sharedSystem);
    const first = parseMetadataUserID(wire.payload.metadata!.user_id!);
    await readStream(host.start(fetch, {
      payload: { ...payload, messages: [{ role: 'user', content: 'another question' }] },
    }).running);
    const second = parseMetadataUserID(wireOf(fetch).payload.metadata!.user_id!);
    expect(first?.sessionId).toBeTypeOf('string');
    expect(second?.sessionId).toBeTypeOf('string');
    expect(second?.sessionId).not.toBe(first?.sessionId);
  });

  test('preserves the shaped client headers and payload, replacing only the authorization credential', async () => {
    const host = fixture();
    const fetch = fetchResponse(() => sse());
    const payload = {
      ...body,
      system: [{ type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      metadata: { user_id: JSON.stringify({ device_id: 'd'.repeat(32), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) },
    };
    const { running } = host.start(fetch, {
      payload,
      headers: [
        ['user-agent', 'claude-cli/2.1.280 (external, cli)'],
        ['x-app', 'cli'],
        ['anthropic-version', '2023-06-01'],
        ['anthropic-beta', 'oauth-2025-04-20'],
        ['anthropic-beta', 'claude-code-20250219'],
        ['x-stainless-package-version', '0.112.1'],
        ['x-claude-code-session-id', 'sess-abc'],
        ['x-client-request-id', 'req-xyz'],
        ['authorization', Secret.from('client authorization')],
        ['x-api-key', Secret.from('client api key')],
        ['x-unrelated', 'discard'],
      ],
    });
    await readStream(running);
    const wire = wireOf(fetch);
    expect(wire.payload).toEqual({ ...payload, model: upstreamModelId, stream: true });
    expect(Object.fromEntries(wire.headers)).toEqual({
      'anthropic-beta': 'oauth-2025-04-20, claude-code-20250219',
      'anthropic-version': '2023-06-01',
      'authorization': 'Bearer access-cached',
      'content-type': 'application/json',
      'user-agent': 'claude-cli/2.1.280 (external, cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'sess-abc',
      'x-client-request-id': 'req-xyz',
      'x-stainless-package-version': '0.112.1',
    });
    const dial = host.events.find(event => event.type === 'stage.entered' && event.name === 'http');
    if (dial?.type !== 'stage.entered') throw new Error('Expected the HTTP stage to run');
    expect(getHeader((dial.facts['request.http'] as HttpRequestFact).headers, 'authorization')).toBeInstanceOf(Secret);
    expect(JSON.stringify(host.events)).not.toContain('access-cached');
  });

  test('returns a local 503 for inactive credentials before attempting an upstream call', async () => {
    const fetch = fetchResponse(() => sse());
    const { running } = fixture({ ...activeAccount, state: 'session_terminated', stateMessage: 'revoked' }).start(fetch);
    const response = await running.result;
    expect(response['response.http']?.status).toBe(503);
    expect(Object.hasOwn(response, 'response.usageModelKey')).toBe(false);
    expect(await outcomeOf(running)).toMatchObject({ kind: 'error', source: 'local', error: { error: { message: expect.stringContaining('revoked') } } });
    await running.done;
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each(['five_hour', 'seven_day_overage_included'])('persists 429 quota and applies the %s limit to subsequent calls', async claim => {
    const host = fixture();
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const upstreamError = { error: { type: 'rate_limit_error', message: 'Allowance exhausted' } };
    const fetch = fetchResponse(() => Response.json(upstreamError, {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': claim,
        'anthropic-ratelimit-unified-reset': String(reset),
        'retry-after': '3600',
      },
    }));
    const fable = { ...model, id: 'public-fable-alias', providerData: { upstreamModelId: 'claude-fable-5-1' } };
    const first = host.start(fetch, { model: fable }).running;
    expect(await outcomeOf(first)).toEqual({ kind: 'error', source: 'upstream', error: upstreamError });
    expect(getHeader((await first.result)['response.http']!.headers, 'retry-after')).toBe('3600');
    await first.done;
    await Promise.all(host.tasks);
    expect(host.account().quotaSnapshot).toMatchObject({ modelId: 'claude-fable-5-1', data: { status: 'rejected', representativeClaim: claim } });

    const second = host.start(fetch, { model: fable }).running;
    expect(await outcomeOf(second)).toMatchObject({ kind: 'error', source: 'local' });
    const localAnswer = await second.result;
    expect(Object.hasOwn(localAnswer, 'response.usageModelKey')).toBe(false);
    const localHead = localAnswer['response.http'];
    expect(localHead?.status).toBe(429);
    expect(Number(getHeader(localHead!.headers, 'retry-after'))).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await second.done;

    if (claim === 'seven_day_overage_included') {
      const sibling = fetchResponse(() => sse());
      await readStream(host.start(sibling).running);
      expect(wireOf(sibling).payload.model).toBe(upstreamModelId);
    }
  });

  test('aborts and discards an open 401 body when refreshing a cached token', async () => {
    const host = fixture();
    const cancelled = Promise.withResolvers<unknown>();
    let firstSignal: AbortSignal | undefined;
    const fetch = vi.fn<ProviderFetcher>()
      .mockImplementationOnce(async (_url, init) => {
        firstSignal = init.signal!;
        return { response: new Response(new ReadableStream({ cancel: cancelled.resolve }), { status: 401 }) };
      })
      .mockImplementationOnce(async (_url, init) => {
        expect(firstSignal?.aborted).toBe(true);
        expect(init.signal?.aborted).not.toBe(true);
        return { response: Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', token_type: 'Bearer', expires_in: 600, scope: '' }) };
      })
      .mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-new');
        expect(init.signal?.aborted).toBe(false);
        return { response: sse() };
      });
    const { running } = host.start(fetch);
    await readStream(running);
    expect((await running.result)['response.usageModelKey']).toBe(wireOf(fetch).payload.model);
    expect(await cancelled.promise).toBe(firstSignal?.reason);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(host.account()).toMatchObject({ refreshToken: 'refresh-new', accessToken: { token: 'access-new' } });
  });

  test('returns a freshly minted token rejection as an upstream 401 without another retry', async () => {
    const host = fixture({ ...activeAccount, accessToken: null });
    const error = { error: { type: 'authentication_error', message: 'still expired' } };
    const fetch = vi.fn<ProviderFetcher>()
      .mockResolvedValueOnce({ response: Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', token_type: 'Bearer', expires_in: 600, scope: '' }) })
      .mockResolvedValueOnce({ response: Response.json(error, { status: 401 }) });
    const { running } = host.start(fetch);
    expect(await outcomeOf(running)).toEqual({ kind: 'error', source: 'upstream', error });
    expect((await running.result)['response.http']?.status).toBe(401);
    await running.done;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    [400, 'invalid_request_error', 'This organization has been disabled.'],
    [403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.'],
  ] as const)('observes %i sentinel without replacing the upstream error body', async (status, type, message) => {
    const host = fixture();
    const error = { error: { type, message }, request_id: 'upstream-id' };
    const fetch = fetchResponse(() => Response.json(error, { status, headers: { 'request-id': 'upstream-id' } }));
    const { running } = host.start(fetch);
    expect(await outcomeOf(running)).toEqual({ kind: 'error', source: 'upstream', error });
    const head = (await running.result)['response.http'];
    expect(head?.status).toBe(status);
    expect(getHeader(head!.headers, 'request-id')).toBe('upstream-id');
    await running.done;
    await Promise.all(host.tasks);
    expect(host.account()).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining(message), accessToken: null });
  });

  test('passes through unrelated 400/403 error bodies without scheduling sentinel persistence', async () => {
    const host = fixture();
    const error = { error: { type: 'permission_error', message: 'Unrelated error' } };
    const { running } = host.start(fetchResponse(() => Response.json(error, { status: 403 })));
    expect(await outcomeOf(running)).toEqual({ kind: 'error', source: 'upstream', error });
    await running.done;
    expect(host.tasks).toHaveLength(0);
    expect(host.account().state).toBe('active');
  });

  test('preserves a non-JSON 400 message without treating it as a credential sentinel', async () => {
    const host = fixture();
    const message = 'This organization has been disabled.';
    const { running } = host.start(fetchResponse(() => new Response(message, { status: 400 })));
    expect(await outcomeOf(running)).toMatchObject({
      kind: 'error',
      source: 'upstream',
      error: { type: 'error', error: { type: 'invalid_request_error', message } },
    });
    await running.done;
    expect(host.events).toContainEqual(expect.objectContaining({
      type: 'log',
      message: 'claude_code_unparseable_error_body',
      fields: { status: 400, body_snippet: message },
    }));
    expect(host.tasks).toHaveLength(0);
    expect(host.account().state).toBe('active');
  });

  test('logs a failed sentinel body read and preserves the upstream failure', async () => {
    const host = fixture();
    const cause = new Error('disconnected');
    const failure = new UpstreamTransportError(cause);
    const fetch = vi.fn<ProviderFetcher>(async () => ({
      response: new Response(new ReadableStream({ start: controller => { controller.error(cause); } }), { status: 403 }),
      identifyBodyTransportFailure: error => error === cause ? failure : undefined,
    }));
    const { running } = host.start(fetch);
    expect(await outcomeOf(running)).toMatchObject({
      kind: 'error',
      source: 'upstream',
      error: { error: { message: 'disconnected' } },
    });
    expect((await running.result)['response.http']?.status).toBe(403);
    await running.done;
    expect(host.events).toContainEqual(expect.objectContaining({
      type: 'log',
      message: 'claude_code_terminal_sentinel_body_read_failed',
      fields: { upstream_id: upstream.id, upstream_status: 403, error: 'disconnected' },
    }));
    expect(host.tasks).toHaveLength(0);
  });

  test('continues forwarding a 400 body beyond the sentinel observation limit', async () => {
    const host = fixture();
    const error = {
      padding: 'x'.repeat(65_536),
      error: { type: 'invalid_request_error', message: 'This organization has been disabled.' },
    };
    const { running } = host.start(fetchResponse(() => Response.json(error, { status: 400 })));
    expect(await outcomeOf(running)).toEqual({ kind: 'error', source: 'upstream', error });
    await running.done;
    expect(host.events).toContainEqual(expect.objectContaining({
      type: 'log',
      message: 'claude_code_terminal_sentinel_body_too_large',
      fields: { upstream_id: upstream.id, upstream_status: 400, limit_bytes: 65_536 },
    }));
    expect(host.tasks).toHaveLength(0);
  });

  test('completes a successful response independently of quota persistence and logs worker failure', async () => {
    const host = fixture();
    const stored = Promise.withResolvers<void>();
    host.saveState.mockReturnValueOnce(stored.promise);
    const { running } = host.start(fetchResponse(() => sse({ 'anthropic-ratelimit-unified-status': 'allowed' })));
    expect(await readStream(running)).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
    expect(host.tasks).toHaveLength(1);
    expect(host.account().quotaSnapshot).toBeNull();
    stored.reject(new Error('quota store offline'));
    await Promise.all(host.tasks);
    const stage = host.events.find(event => event.type === 'stage.entered' && event.name.endsWith('observe-quota'));
    if (stage?.type !== 'stage.entered') throw new Error('Expected the quota observer to run');
    expect(host.events).toContainEqual(expect.objectContaining({
      type: 'log',
      stageId: stage.stageId,
      message: 'claude_code_quota_persist_failed',
    }));
  });

  test('classifies a pre-header transport failure independently of the HTTP response', async () => {
    const fetch = vi.fn<ProviderFetcher>().mockRejectedValue(new UpstreamTransportError(new Error('network unavailable')));
    const { running } = fixture().start(fetch);
    const response = await running.result;
    expect(response['response.http']).toBeNull();
    expect(response['response.usageModelKey']).toBe(upstreamModelId);
    expect(await outcomeOf(running)).toMatchObject({ kind: 'error', source: 'upstream', error: { error: { message: 'network unavailable' } } });
    await running.done;
  });

  test('omits model identity and skips the fetcher when already cancelled before dialing', async () => {
    const fetch = fetchResponse(() => sse());
    const controller = new AbortController();
    controller.abort();
    const { running } = fixture().start(fetch, { controller });
    expect(await outcomeOf(running)).toMatchObject({ kind: 'error', source: 'local', error: { error: { message: 'Upstream request cancelled' } } });
    const answer = await running.result;
    expect(answer['response.http']).toBeNull();
    expect(Object.hasOwn(answer, 'response.usageModelKey')).toBe(false);
    await running.done;
    expect(fetch).not.toHaveBeenCalled();
  });

  test('classifies cancellation while dialing as a local protocol outcome without model identity', async () => {
    const dialed = Promise.withResolvers<void>();
    const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
      const signal = init.signal!;
      const response = Promise.withResolvers<never>();
      signal.addEventListener('abort', () => { response.reject(signal.reason); }, { once: true });
      dialed.resolve();
      return await response.promise;
    });
    const { running, controller } = fixture().start(fetch);
    await dialed.promise;
    controller.abort();
    expect(await outcomeOf(running)).toMatchObject({ kind: 'error', source: 'local', error: { error: { message: 'Upstream request cancelled' } } });
    const answer = await running.result;
    expect(answer['response.http']).toBeNull();
    expect(Object.hasOwn(answer, 'response.usageModelKey')).toBe(false);
    await running.done;
    expect(fetch).toHaveBeenCalledOnce();
  });

  test('reports incomplete streams with bounded decoded snippets and redacted credentials', async () => {
    const host = fixture();
    const body = [
      { type: 'message_start' },
      { type: 'content_block_start', access_token: 'test-secret', data: 'diagnostic context' },
      { type: 'content_block_delta', data: 'x'.repeat(512) },
      { type: 'message_delta' },
    ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    const { running } = host.start(fetchResponse(() => sse({ 'request-id': 'req-stream' }, body)));
    expect((await readStream(running)).at(-1)).toMatchObject({ ok: false, error: { kind: 'protocol' } });
    const log = host.events.find(event => event.type === 'log' && event.message === 'claude_code_messages_stream_incomplete');
    expect(log).toMatchObject({
      fields: {
        request_id: 'req-stream',
        events: 4,
        failure_kind: 'protocol',
        error: expect.stringMatching(/message_stop/),
        last_event_frames: [
          { event: 'content_block_start', data: expect.stringContaining('diagnostic context') },
          { event: 'content_block_delta', data: expect.stringMatching(/\.\.\.$/) },
          { event: 'message_delta', data: '{"type":"message_delta"}' },
        ],
      },
    });
    expect(JSON.stringify(log)).not.toContain('test-secret');
  });
});
