import { describe, expect, test, vi } from 'vitest';

import { claudeCodeUpstreamFact } from '../../../src/config.ts';
import { addMetadataUserId } from '../../../src/pipelines/anthropic-messages/synthesize-metadata-user-id.ts';
import { claudeCodePipelines } from '../../../src/pipelines/index.ts';
import { parseClaudeCodeQuotaHeaders } from '../../../src/quota.ts';
import { createClaudeCodeService } from '../../../src/service.ts';
import { readClaudeCodeUpstreamState, type ClaudeCodeAccountCredential } from '../../../src/state.ts';
import * as upstreamMetrics from '../../../src/upstream-metrics.ts';
import { getHeader, type HttpHeaders, type HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret, type RunEvent } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { toProviderModelFact, type ProviderRepo, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const upstreamId = 'claude-code-upstream';
const accountUuid = 'claude-code-account';
const modelId = 'claude-sonnet-4-5-20250929';
const sonnet = stubProviderModel({
  id: 'claude-sonnet-4-5',
  upstreamModelId: modelId,
  limits: { max_output_tokens: 8192 },
});
const record = {
  id: upstreamId,
  kind: 'claude-code',
  name: 'Claude Code',
  config: { accounts: [{ accountUuid, email: null, organizationUuid: null, subscriptionType: 'max', rateLimitTier: null }] },
  configVersion: 1,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
} satisfies Omit<UpstreamRecord, 'state'> & { configVersion: number };

const activeAccount = {
  accountUuid,
  tokenKind: 'oauth',
  refreshToken: 'rt_cached',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00.000Z',
  accessToken: { token: 'at_cached', expiresAt: Date.now() + 3_600_000, refreshedAt: '2026-01-01T00:00:00.000Z' },
  quotaSnapshot: null,
  usageProbeSnapshot: null,
} satisfies ClaudeCodeAccountCredential;

const payload = {
  model: sonnet.id,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hello' }],
} satisfies AnthropicMessagesPayload;

const createHarness = (account: ClaudeCodeAccountCredential = activeAccount) => {
  let state = readClaudeCodeUpstreamState({ accounts: [account] });
  const getById = vi.fn<ProviderRepo['upstreams']['getById']>(async () => ({ ...record, state }));
  const saveState = vi.fn<ProviderRepo['upstreams']['saveState']>(async (_id, mutate) => {
    state = readClaudeCodeUpstreamState(mutate(state, record.configVersion));
  });
  const recordUpstreamMetric = vi.fn<ProviderRepo['recordUpstreamMetric']>().mockResolvedValue(undefined);
  const claudeCode = createClaudeCodeService({
    upstreams: { getById, saveState },
    recordUpstreamMetric,
  });
  const send = vi.fn<ReturnType<ProviderServices['fetcher']>>();
  const events: RunEvent[] = [];
  const start = (body: AnthropicMessagesPayload = payload, headers: HttpHeaders = [], model = sonnet) => run(
    claudeCodePipelines.anthropicMessages,
    {
      'request.http': move({ url: 'https://floway.test/v1/messages', method: 'POST', headers, body }),
      'request.anthropicMessages': move(body),
      'provider.model': move(toProviderModelFact(model)),
      'provider.upstream': move(claudeCodeUpstreamFact({ ...record, state })),
    },
    {
      services: { claudeCode, fetcher: () => send },
      events: event => { events.push(event); },
    },
  );
  return { start, send, getById, saveState, recordUpstreamMetric, claudeCode, events, account: () => state.accounts[0]! };
};

const reply = (value: Response) => ({ ok: true, value }) as const;
const sse = (headers: HeadersInit = {}): Response => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
  headers: { 'content-type': 'text/event-stream', ...headers },
});
const oauthToken = (): Response => Response.json({
  access_token: 'at_new', refresh_token: 'rt_new', token_type: 'Bearer', expires_in: 3600, scope: '',
});
const finish = async (call: ReturnType<ReturnType<typeof createHarness>['start']>) => {
  const answer = await call.result;
  const outcome = answer['response.anthropicMessages'];
  const items = outcome.kind === 'stream' ? await Array.fromAsync(outcome.stream) : [];
  await call.done;
  return { answer, outcome, items };
};

describe('Claude Code Anthropic Messages pipeline', () => {
  test.each([false, true])('returns a local 503 for removal before dispatch (after gate: %s)', async afterGate => {
    const h = createHarness();
    if (afterGate) h.getById.mockResolvedValueOnce({ ...record, state: { accounts: [activeAccount] } });
    h.getById.mockResolvedValueOnce(null);
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 503, statusText: 'Service Unavailable' });
    expect(outcome).toMatchObject({ kind: 'error', source: 'local', error: { error: { type: 'claude_code_upstream_unavailable' } } });
    expect(h.send).not.toHaveBeenCalled();
  });

  test('a quota metrics bug propagates through the persistence stage', async () => {
    const h = createHarness();
    const bug = new TypeError('quota metrics bug');
    const metrics = vi.spyOn(upstreamMetrics, 'claudeCodeQuotaMetrics').mockImplementationOnce(() => { throw bug; });
    try {
      h.send.mockResolvedValueOnce(reply(new Response('quota exhausted', {
        status: 429,
        headers: { 'anthropic-ratelimit-unified-status': 'rejected' },
      })));
      const call = h.start();
      await expect(call.done).rejects.toBe(bug);
      expect(h.saveState).toHaveBeenCalledOnce();
    } finally {
      metrics.mockRestore();
    }
  });

  test('shapes an unrecognized request as Claude Code and serializes the dated model', async () => {
    const h = createHarness();
    h.send.mockResolvedValueOnce(reply(sse()));
    const { max_tokens: _maxTokens, ...withoutMaxTokens } = payload;
    const unshaped = { ...withoutMaxTokens, system: 'Operator instructions' } as AnthropicMessagesPayload;
    const { answer, items } = await finish(h.start(unshaped, [['user-agent', 'other-client']]));

    expect(h.send).toHaveBeenCalledOnce();
    const [url, request] = h.send.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    const wireHeaders = new Headers(request.headers);
    expect(wireHeaders.get('user-agent')).toMatch(/^claude-cli\//);
    expect(wireHeaders.get('anthropic-beta')).toContain('claude-code-20250219');
    const body = JSON.parse(String(request.body)) as AnthropicMessagesPayload;
    expect(body).toMatchObject({
      model: modelId,
      stream: true,
      max_tokens: 8192,
      temperature: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nOperator instructions' }] },
        { role: 'assistant' },
        payload.messages[0],
      ],
      system: [
        { type: 'text', text: expect.stringMatching(/^x-anthropic-billing-header:/) },
        { type: 'text', text: expect.stringMatching(/^You are Claude Code/) },
        { type: 'text', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      metadata: { user_id: expect.any(String) },
    });
    expect(answer['response.http']).toMatchObject({ status: 200, body: null });
    expect(body.metadata).toEqual(addMetadataUserId(unshaped, upstreamId).metadata);
    expect(answer['response.modelKey']).toBe(modelId);
    expect(items).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
  });

  test('preserves the recognized payload and allowed header lines and adds a Secret bearer', async () => {
    const h = createHarness();
    h.send.mockResolvedValueOnce(reply(sse()));
    const shaped = {
      ...payload,
      stream: false,
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      metadata: { user_id: JSON.stringify({ device_id: 'a'.repeat(64), account_uuid: '', session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }) },
    };
    const fingerprint: HttpHeaders = [
      ['User-Agent', 'claude-cli/2.1.280 (external, cli)'],
      ['x-app', 'cli'],
      ['anthropic-version', '2023-06-01'],
      ['anthropic-beta', 'oauth-2025-04-20'],
      ['Anthropic-Beta', 'custom-beta'],
      ['x-stainless-package-version', '0.112.1'],
      ['x-claude-code-session-id', 'sess-abc'],
      ['x-client-request-id', 'req-xyz'],
    ];
    const headers: HttpHeaders = [
      ...fingerprint,
      ['authorization', 'Bearer inbound'],
      ['unrecognized', 'omit'],
    ];
    await finish(h.start(shaped, headers));

    const [, request] = h.send.mock.calls[0]!;
    expect(JSON.parse(String(request.body))).toEqual({ ...shaped, model: modelId, stream: true });
    expect(request.headers).toEqual([
      ...fingerprint,
      ['content-type', 'application/json'],
      ['authorization', 'Bearer at_cached'],
    ]);
    const terminal = h.events.find(event => event.type === 'stage.entered' && event.name === 'http');
    if (terminal?.type !== 'stage.entered') return expect.fail('The HTTP terminal did not run');
    const requestFact = terminal.facts['request.http'] as HttpRequestFact;
    expect(getHeader(requestFact.headers, 'authorization')).toBeInstanceOf(Secret);
    expect(Object.hasOwn(terminal.facts, 'request.claudeCodeShaped')).toBe(false);
  });

  test('uses the live account health to return a local 503 before OAuth', async () => {
    const h = createHarness({ ...activeAccount, state: 'refresh_failed', stateMessage: 'account disabled' });
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 503, statusText: 'Service Unavailable', body: null });
    expect(answer['response.modelKey']).toBe(modelId);
    expect(outcome).toEqual({
      kind: 'error', source: 'local',
      error: { error: { type: 'claude_code_upstream_unavailable', message: 'Claude Code account is refresh_failed: account disabled' } },
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.events.some(event => event.type === 'stage.entered' && event.name === 'claude-code.serialize')).toBe(false);
  });

  test('uses the shared quota reset to return a local 429 without refreshing OAuth', async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    const snapshot = parseClaudeCodeQuotaHeaders(new Headers({
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-reset': String(reset),
    }));
    const h = createHarness({
      ...activeAccount, accessToken: null,
      quotaSnapshot: { data: snapshot, fetchedAt: Date.now(), modelId },
    });
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 429, statusText: 'Too Many Requests', body: null });
    expect(Number(getHeader(answer['response.http']!.headers, 'retry-after'))).toBeGreaterThan(0);
    expect(answer['response.modelKey']).toBe(modelId);
    expect(outcome).toMatchObject({ kind: 'error', source: 'local', error: { error: { retry_at: new Date(reset * 1000).toISOString() } } });
    expect(h.send).not.toHaveBeenCalled();
  });

  test('aborts and joins a rejected cached response before refreshing and retrying once', async () => {
    const h = createHarness();
    const cancelled = Promise.withResolvers<void>();
    const allowCancel = Promise.withResolvers<void>();
    const body = new ReadableStream({
      cancel() {
        cancelled.resolve();
        return allowCancel.promise;
      },
    });
    h.send
      .mockResolvedValueOnce(reply(new Response(body, { status: 401 })))
      .mockImplementationOnce(async (_url, init) => {
        expect(h.events.some(event => event.type === 'stream.end')).toBe(true);
        expect(Object.hasOwn(init, 'signal')).toBe(false);
        return reply(oauthToken());
      })
      .mockResolvedValueOnce(reply(sse()));
    const call = h.start();
    await cancelled.promise;
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![1].signal?.aborted).toBe(true);
    expect(h.account().accessToken?.token).toBe('at_cached');
    allowCancel.resolve();
    const { items } = await finish(call);
    expect(items).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
    expect(h.send).toHaveBeenCalledTimes(3);
    expect(new Headers(h.send.mock.calls[2]![1].headers).get('authorization')).toBe('Bearer at_new');
    expect(h.account()).toMatchObject({ accessToken: { token: 'at_new' }, refreshToken: 'rt_new' });
  });

  test.each([false, true])('returns the upstream 401 for a freshly minted token (prior attempt %s)', async retry => {
    const h = createHarness(retry ? activeAccount : { ...activeAccount, accessToken: null });
    if (retry) h.send.mockResolvedValueOnce(reply(new Response('expired', { status: 401 })));
    const error = { type: 'error', error: { type: 'authentication_error', message: 'still expired' } };
    h.send
      .mockResolvedValueOnce(reply(oauthToken()))
      .mockResolvedValueOnce(reply(Response.json(error, { status: 401, headers: { 'request-id': 'retained' } })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 401, body: null });
    expect(getHeader(answer['response.http']!.headers, 'request-id')).toBe('retained');
    expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect(h.send).toHaveBeenCalledTimes(retry ? 3 : 2);
  });

  test('preserves the token endpoint rejection after a rejected cached bearer and flips the account terminal', async () => {
    const h = createHarness();
    const error = { error: 'invalid_grant', error_description: 'Revoked refresh token' };
    h.send
      .mockResolvedValueOnce(reply(new Response('expired', { status: 401 })))
      .mockResolvedValueOnce(reply(Response.json(error, { status: 400, headers: { 'request-id': 'token-endpoint-rejection' } })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 400, body: null });
    expect(getHeader(answer['response.http']!.headers, 'request-id')).toBe('token-endpoint-rejection');
    expect(answer['response.modelKey']).toBe(modelId);
    expect(outcome).toMatchObject({ kind: 'error', source: 'upstream', error, cause: { code: 'invalid_grant' } });
    expect(h.account()).toMatchObject({ state: 'refresh_failed', accessToken: null });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  test('reports an OAuth transport failure before headers with the original cause and completes the run', async () => {
    const h = createHarness({ ...activeAccount, accessToken: null });
    const cause = new Error('token endpoint unreachable');
    h.send.mockResolvedValueOnce({ ok: false, error: { kind: 'transport', cause } });
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toBeNull();
    expect(answer['response.modelKey']).toBe(modelId);
    expect(outcome).toMatchObject({
      kind: 'error', source: 'upstream',
      error: { type: 'error', error: { message: cause.message } },
      cause: { kind: 'transport', cause },
    });
    expect(h.account().state).toBe('active');
  });

  test('preserves a non-JSON OAuth rejection in the Anthropic error envelope', async () => {
    const h = createHarness({ ...activeAccount, accessToken: null });
    h.send.mockResolvedValueOnce(reply(new Response('upstream maintenance', {
      status: 503, statusText: 'Temporarily Unavailable', headers: { 'retry-after': '5' },
    })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 503, statusText: 'Temporarily Unavailable', body: null });
    expect(getHeader(answer['response.http']!.headers, 'retry-after')).toBe('5');
    expect(outcome).toMatchObject({
      kind: 'error', source: 'upstream', error: { type: 'error', error: { message: 'upstream maintenance' } },
    });
    expect(h.account().state).toBe('active');
  });

  test('returns a local 503 for an expired setup token without contacting OAuth', async () => {
    const h = createHarness({
      ...activeAccount, tokenKind: 'setup-token', refreshToken: null,
      accessToken: { ...activeAccount.accessToken, expiresAt: Date.now() - 1 },
    });
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 503, statusText: 'Service Unavailable', body: null });
    expect(outcome).toMatchObject({ kind: 'error', source: 'local' });
    expect(h.account()).toMatchObject({ state: 'refresh_failed', accessToken: null });
    expect(h.send).not.toHaveBeenCalled();
  });

  test.each([
    [400, 'invalid_request_error', 'This organization has been disabled.'],
    [403, 'permission_error', 'OAuth authentication is currently not allowed for this organization.'],
  ] as const)('observes a %s terminal sentinel across chunks and retains the original JSON error', async (status, type, message) => {
    const h = createHarness();
    const error = { type: 'error', error: { type, message }, request_id: 'sentinel' };
    const data = new TextEncoder().encode(JSON.stringify(error));
    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(data.subarray(0, 60));
        controller.enqueue(data.subarray(60));
        controller.close();
      },
    });
    h.send.mockResolvedValueOnce(reply(new Response(readable, { status, headers: { 'request-id': 'sentinel' } })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status, body: null });
    expect(getHeader(answer['response.http']!.headers, 'request-id')).toBe('sentinel');
    expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect(h.account()).toMatchObject({ state: 'refresh_failed', stateMessage: expect.stringContaining(message), accessToken: null });
  });

  test('wraps a non-JSON upstream 403 and leaves the account active', async () => {
    const h = createHarness();
    h.send.mockResolvedValueOnce(reply(new Response('Forbidden content', { status: 403, statusText: 'Access denied' })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 403, statusText: 'Access denied', body: null });
    expect(outcome).toMatchObject({
      kind: 'error', source: 'upstream', error: { type: 'error', error: { message: 'Forbidden content' } },
    });
    expect(h.account().state).toBe('active');
    expect(h.saveState).not.toHaveBeenCalled();
  });

  test('limits sentinel observation and forwards an oversized JSON error intact', async () => {
    const h = createHarness();
    const error = {
      error: { type: 'invalid_request_error', message: 'Organization has been disabled.' },
      detail: 'x'.repeat(64 * 1024),
    };
    h.send.mockResolvedValueOnce(reply(Response.json(error, { status: 400 })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 400 });
    expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect(h.account().state).toBe('active');
    expect(h.saveState).not.toHaveBeenCalled();
    expect(JSON.stringify(h.events.filter(event => event.type === 'log'))).toContain('claude_code_terminal_sentinel_body_too_large');
  });

  test('propagates a failed sentinel read with its cause and leaves the account active', async () => {
    const h = createHarness();
    const cause = new Error('upstream body read failed');
    const body = new ReadableStream({ start: controller => controller.error(cause) });
    h.send.mockResolvedValueOnce(reply(new Response(body, { status: 400 })));
    const { answer, outcome } = await finish(h.start());
    expect(answer['response.http']).toMatchObject({ status: 400 });
    expect(outcome).toMatchObject({ kind: 'error', source: 'upstream', cause: { kind: 'transport', cause } });
    expect(h.account().state).toBe('active');
    expect(h.saveState).not.toHaveBeenCalled();
  });

  test('reports an incomplete SSE stream with its retained raw frame diagnostics', async () => {
    const h = createHarness();
    h.send.mockResolvedValueOnce(reply(new Response('event: ping\ndata: {"type":"ping"}\n\n', {
      headers: { 'content-type': 'text/event-stream', 'request-id': 'incomplete' },
    })));
    const { items } = await finish(h.start());
    expect(items.at(-1)).toMatchObject({ ok: false, error: { kind: 'protocol' } });
    const logs = JSON.stringify(h.events.filter(event => event.type === 'log'));
    expect(logs).toContain('claude_code_messages_stream_incomplete');
    expect(logs).toContain('incomplete');
    expect(logs).toContain('ping');
  });

  test.each(['quota', 'terminal'] as const)('retains the response and completes when %s persistence fails', async kind => {
    const h = createHarness();
    const persistence = Promise.withResolvers<void>();
    const failure = new Error('state store unavailable');
    const observe = vi.spyOn(h.claudeCode, kind === 'quota' ? 'persistQuota' : 'persistTerminal');
    h.saveState.mockReturnValueOnce(persistence.promise);
    const response = kind === 'quota'
      ? sse({ 'anthropic-ratelimit-unified-status': 'allowed' })
      : Response.json({ error: { type: 'invalid_request_error', message: 'Organization has been disabled.' } }, { status: 400 });
    h.send.mockResolvedValueOnce(reply(response));

    const call = h.start();
    const answer = await call.result;
    const outcome = answer['response.anthropicMessages'];
    if (outcome.kind === 'stream') expect(await Array.fromAsync(outcome.stream)).toHaveLength(1);
    expect(answer['response.http']?.status).toBe(response.status);
    expect(h.saveState).toHaveBeenCalledOnce();
    let finished = false;
    const completion = call.done.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    persistence.reject(failure);
    await expect(observe.mock.results[0]!.value).resolves.toEqual({ persisted: false, error: failure });
    await completion;
    expect(finished).toBe(true);
  });

  test('records quota and metric samples for an upstream 429', async () => {
    const h = createHarness();
    const reset = Math.floor(Date.now() / 1000) + 600;
    const error = { type: 'error', error: { type: 'rate_limit_error', message: 'paused' } };
    h.send.mockResolvedValueOnce(reply(Response.json(error, {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
        'anthropic-ratelimit-unified-reset': String(reset),
        'anthropic-ratelimit-unified-5h-utilization': '1',
      },
    })));
    const { outcome } = await finish(h.start());
    expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect(h.account().quotaSnapshot).toMatchObject({ modelId, data: { status: 'rejected' } });
    expect(h.recordUpstreamMetric).toHaveBeenCalled();
    expect((await finish(h.start())).answer['response.http']?.status).toBe(429);
    expect(h.send).toHaveBeenCalledOnce();
  });

  test('records the allowed quota and metrics from a successful stream', async () => {
    const h = createHarness();
    h.send.mockResolvedValueOnce(reply(sse({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.25',
    })));
    const { items } = await finish(h.start());
    expect(items).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
    expect(h.account().quotaSnapshot).toMatchObject({
      modelId, data: { status: 'allowed', fiveHour: { status: 'allowed', utilization: 0.25 } },
    });
    expect(h.recordUpstreamMetric).toHaveBeenCalled();
  });

  // Claude Code 2.1.322 labels the model-specific seven-day claim 7d_oi.
  // https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.322.tgz
  test.each([false, true])('Fable quota leaves sibling models available (five-hour header present: %s)', async windowObserved => {
    const h = createHarness();
    const fable = stubProviderModel({ ...sonnet, id: 'public-fable-alias', upstreamModelId: 'claude-fable-5-1' });
    const reset = Math.floor(Date.now() / 1000) + 600;
    const error = { error: { type: 'rate_limit_error', message: 'Weekly allowance exhausted' } };
    h.send.mockResolvedValueOnce(reply(Response.json(error, {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
        'anthropic-ratelimit-unified-reset': String(reset),
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-7d_oi-reset': String(reset),
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'retry-after': '600',
        ...(windowObserved ? { 'anthropic-ratelimit-unified-5h-status': 'allowed' } : {}),
      },
    })));
    const first = await finish(h.start(payload, [], fable));
    expect(first.answer['response.modelKey']).toBe(fable.upstreamModelId);
    expect(getHeader(first.answer['response.http']!.headers, 'retry-after')).toBe('600');
    expect(first.outcome).toEqual({ kind: 'error', source: 'upstream', error });
    expect(h.account().quotaSnapshot).toMatchObject({
      modelId: fable.upstreamModelId,
      data: { status: 'rejected', representativeClaim: 'seven_day_overage_included' },
    });
    expect((await finish(h.start(payload, [], fable))).outcome).toMatchObject({ kind: 'error', source: 'local' });
    expect(h.send).toHaveBeenCalledOnce();

    for (const id of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
      const model = stubProviderModel({ ...sonnet, id, upstreamModelId: id });
      h.send.mockResolvedValueOnce(reply(sse()));
      expect((await finish(h.start(payload, [], model))).outcome.kind).toBe('stream');
      expect(JSON.parse(String(h.send.mock.calls.at(-1)![1].body))).toMatchObject({ model: id });
    }
    expect(h.send).toHaveBeenCalledTimes(4);
  });
});
