import { validate, version } from 'uuid';
import { expect, expectTypeOf, test, vi } from 'vitest';

import { parseMetadataUserID } from '../../../src/detection.ts';
import { CLAUDE_CLI_VERSION } from '../../../src/headers.ts';
import { claudeCodePipelines, claudeCodeUpstreamModule, createClaudeCodeService, type ClaudeCodeServices } from '../../../src/index.ts';
import { DEFAULT_TEMPLATE_BLOCK } from '../../../src/pipelines/anthropic-messages/system-blocks.ts';
import { parseClaudeCodeQuotaHeaders } from '../../../src/quota.ts';
import { readClaudeCodeUpstreamState, type ClaudeCodeAccountCredential } from '../../../src/state.ts';
import { HttpTransportError, type Fetcher, type FetchInit } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { stubUpstreamModel } from '@floway-dev/test-utils';
import {
  initUpstreamRuntimeRepo,
  toUpstreamModelSnapshot,
  toUpstreamSnapshot,
  type UpstreamPipeline,
  type UpstreamRecord,
  type UpstreamRequest,
  type UpstreamRuntimeRepo,
} from '@floway-dev/upstream';

const upstreamId = 'claude-code-test';
const modelId = 'claude-sonnet-4-5-20250929';
const model = toUpstreamModelSnapshot(stubUpstreamModel({
  id: 'public-sonnet',
  upstreamModelId: modelId,
  endpoints: { anthropicMessages: {} },
  limits: { max_output_tokens: 11 },
}));
const cachedAccount: ClaudeCodeAccountCredential = {
  accountUuid: 'account',
  tokenKind: 'oauth',
  refreshToken: 'refresh-v1',
  state: 'active',
  stateUpdatedAt: '2026-01-01T00:00:00Z',
  accessToken: {
    token: 'access-cached',
    expiresAt: Date.now() + 60 * 60 * 1000,
    refreshedAt: '2026-01-01T00:00:00Z',
  },
  quotaSnapshot: null,
  usageProbeSnapshot: null,
};
const makeRecord = (account: ClaudeCodeAccountCredential): UpstreamRecord => ({
  id: upstreamId,
  kind: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  config: {
    accounts: [{
      email: null,
      accountUuid: account.accountUuid,
      organizationUuid: null,
      subscriptionType: 'max',
      rateLimitTier: null,
    }],
  },
  state: { accounts: [account] },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 0,
});
const request: UpstreamRequest<'anthropicMessages'> = {
  upstream: toUpstreamSnapshot(makeRecord(cachedAccount)),
  model,
  http: { url: 'https://floway.test/v1/messages', method: 'POST', headers: [], body: new Uint8Array() },
  anthropicMessages: { model: model.id, messages: [{ role: 'user', content: 'hello' }], max_tokens: 11 },
};

const entry = asEntry(claudeCodePipelines.anthropicMessages);

const setup = (fetcher: Fetcher, options: {
  account?: ClaudeCodeAccountCredential;
  beforeWrite?: () => Promise<void>;
  onSchedule?: () => void;
} = {}) => {
  let record = makeRecord(options.account ?? cachedAccount);
  const recordUpstreamMetric = vi.fn<UpstreamRuntimeRepo['recordUpstreamMetric']>().mockResolvedValue(undefined);
  const repo: UpstreamRuntimeRepo = {
    recordUpstreamMetric,
    upstreams: {
      getById: async () => ({ ...record, version: 1 }),
      async saveState(_id, mutate) {
        await options.beforeWrite?.();
        record = { ...record, state: mutate(record.state, 1) };
      },
    },
  };
  const services = { fetcher: () => fetcher, claudeCode: createClaudeCodeService(repo) };
  const controller = new AbortController();
  const background: Promise<PromiseSettledResult<unknown>>[] = [];
  const waitUntil = (work: Promise<unknown>) => {
    options.onSchedule?.();
    background.push(work.then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    ));
  };
  return {
    start: (facts = request) => run(entry, facts, { services, signal: controller.signal, waitUntil }),
    repo,
    controller,
    background,
    recordUpstreamMetric,
    account: () => readClaudeCodeUpstreamState(record.state).accounts[0],
  };
};

const sse = (headers?: Record<string, string>, body = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream', ...headers } });

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const items = [];
  for await (const item of source) items.push(item);
  return items;
};

const requestBody = (init: FetchInit): AnthropicMessagesPayload => {
  if (typeof init.body !== 'string') throw new TypeError('Expected a serialized JSON body');
  return JSON.parse(init.body);
};

test('refreshes the catalog with the cached OAuth bearer and preserves the dated wire model ID', async () => {
  const record = makeRecord(cachedAccount);
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(Response.json({
    data: [{ id: modelId, display_name: 'Claude Sonnet 4.5', max_input_tokens: 200_000 }],
  }));
  const { repo } = setup(fetcher);
  initUpstreamRuntimeRepo(() => repo);
  const models = await claudeCodeUpstreamModule.getModels(record, fetcher);
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.anthropic.com/v1/models?limit=100');
  expect(init.method).toBe('GET');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-cached');
  expect(models).toMatchObject([{ id: 'claude-sonnet-4-5', upstreamData: { upstreamModelId: modelId } }]);
});

test('exports the sealed Anthropic Messages operation boundary and mimics non-Claude Code requests', async () => {
  expectTypeOf(claudeCodePipelines.anthropicMessages).toEqualTypeOf<UpstreamPipeline<'anthropicMessages', ClaudeCodeServices>>();
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(sse());
  const { max_tokens: _maxTokens, ...body } = request.anthropicMessages;
  const client = setup(fetcher).start({
    ...request,
    http: { ...request.http, headers: [['authorization', 'client-key'], ['x-app', 'unrelated-app']] },
    anthropicMessages: { ...body, stream: false, system: 'User system instructions' } as AnthropicMessagesPayload,
  });
  const answer = await client.result;
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-cached');
  expect(new Headers(init.headers).get('x-app')).toBe('cli');
  expect(new Headers(init.headers).get('user-agent')).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  expect(new Headers(init.headers).get('anthropic-beta')).toBeTruthy();
  const wireBody = requestBody(init);
  expect(wireBody).toMatchObject({
    model: modelId, stream: true, max_tokens: 11, temperature: 1, metadata: { user_id: expect.any(String) },
    system: [
      { type: 'text', text: expect.stringMatching(/^x-anthropic-billing-header: .* cch=00000;$/) },
      { type: 'text', text: expect.stringContaining('Claude Code') },
      { type: 'text', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nUser system instructions' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
      { role: 'user', content: 'hello' },
    ],
  });
  if (!Array.isArray(wireBody.system) || !wireBody.system[0]) throw new Error('Expected Claude Code billing block');
  expect(wireBody.system[0].text).toContain(`cc_version=${CLAUDE_CLI_VERSION}.`);
  expect(wireBody.system[0].text).toMatch(/cc_version=[\d.]+\.[0-9a-f]{3};/);
  if (!wireBody.metadata?.user_id) throw new Error('Expected Claude Code metadata user ID');
  const userId = parseMetadataUserID(wireBody.metadata.user_id);
  expect(userId).toMatchObject({
    isNewFormat: true,
    accountUuid: '',
    deviceId: expect.stringMatching(/^[0-9a-f]{64}$/),
    sessionId: '37e5c421-b665-4acc-9254-d0b3ea5db472',
  });
  if (!userId) throw new Error('Expected parsed Claude Code metadata user ID');
  expect(validate(userId.sessionId)).toBe(true);
  expect(version(userId.sessionId)).toBe(4);
  expect(answer).toMatchObject({ http: { status: 200, body: null } });
  expect(answer.anthropicMessages.kind).toBe('stream');
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Claude Code events');
  expect(await collect(client.read(answer.anthropicMessages.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
  client.discard(answer);
});

test('distinct user turns sharing system instructions produce different wire session IDs', async () => {
  const fetcher = vi.fn<Fetcher>().mockImplementation(async () => sse());
  const host = setup(fetcher);
  for (const firstUserText of ['What is the capital of France?', 'Who wrote The Great Gatsby?']) {
    const client = host.start({
      ...request,
      anthropicMessages: {
        ...request.anthropicMessages,
        system: 'Shared system instructions',
        messages: [{ role: 'user', content: firstUserText }],
      },
    });
    client.discard(await client.result);
  }
  const sessionIds = fetcher.mock.calls.map(([, init]) => {
    const userId = requestBody(init).metadata?.user_id;
    if (!userId) throw new Error('Expected Claude Code metadata user ID');
    return parseMetadataUserID(userId)?.sessionId;
  });
  expect(sessionIds).toEqual([expect.any(String), expect.any(String)]);
  expect(new Set(sessionIds).size).toBe(2);
});

test.each([3, 4])('keeps the template when callers use %i cache breakpoints', async count => {
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(sse());
  const client = setup(fetcher).start({
    ...request,
    anthropicMessages: {
      ...request.anthropicMessages,
      messages: [{
        role: 'user',
        content: Array.from({ length: count - 1 }, (_, index) => ({
          type: 'text',
          text: `cached fragment ${index}`,
          cache_control: { type: 'ephemeral' },
        })),
      }],
      tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
    },
  });
  const answer = await client.result;
  const system = requestBody(fetcher.mock.calls[0]![1]).system;
  expect(system).toHaveLength(3);
  expect(system?.[2]).toEqual(count === 3 ? DEFAULT_TEMPLATE_BLOCK : { type: 'text', text: DEFAULT_TEMPLATE_BLOCK.text });
  client.discard(answer);
});

test('genuine Claude Code headers retain multiplicity and the original system blocks', async () => {
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(sse());
  const system = [{ type: 'text' as const, text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  const userId = JSON.stringify({ device_id: 'device', account_uuid: '', session_id: 'session' });
  const client = setup(fetcher).start({
    ...request,
    http: {
      ...request.http,
      headers: [
        ['user-agent', 'claude-cli/2.1.280 (external, cli)'],
        ['x-app', 'claude-code-test'],
        ['x-claude-code-session-id', 'session'],
        ['anthropic-version', '2023-06-01'],
        ['anthropic-beta', 'claude-code-20250219'],
        ['anthropic-beta', 'new-feature'],
        ['x-stainless-helper-method', 'stream'],
        ['x-stainless-package-version', '0.112.1'],
        ['x-client-request-id', 'req-xyz'],
        ['x-stainless-unrelated', 'strip-me'],
        ['authorization', 'inbound-key'],
      ],
    },
    anthropicMessages: { ...request.anthropicMessages, system, metadata: { user_id: userId }, max_tokens: 19 },
  });
  const answer = await client.result;
  const [, init] = fetcher.mock.calls[0]!;
  expect(init.headers).toEqual([
    ['user-agent', 'claude-cli/2.1.280 (external, cli)'],
    ['x-app', 'claude-code-test'],
    ['x-claude-code-session-id', 'session'],
    ['anthropic-version', '2023-06-01'],
    ['anthropic-beta', 'claude-code-20250219'],
    ['anthropic-beta', 'new-feature'],
    ['x-stainless-helper-method', 'stream'],
    ['x-stainless-package-version', '0.112.1'],
    ['x-client-request-id', 'req-xyz'],
    ['authorization', 'Bearer access-cached'],
    ['content-type', 'application/json'],
  ]);
  expect(requestBody(init)).toEqual({
    ...request.anthropicMessages, model: modelId, system, metadata: { user_id: userId }, max_tokens: 19, stream: true,
  });
  client.discard(answer);
});

test('cancels the first 401 child and schedules its whole-answer drain before refreshing', async () => {
  const releaseLosingBody = Promise.withResolvers<void>();
  const losingBodyPulled = Promise.withResolvers<void>();
  let firstSignal: AbortSignal | undefined;
  let drained = false;
  const lifecycle: string[] = [];
  const fetcher = vi.fn<Fetcher>()
    .mockImplementationOnce(async (_url, init) => {
      if (!init.signal) throw new Error('Expected a child-owned HTTP signal');
      const signal = init.signal;
      firstSignal = signal;
      signal.addEventListener('abort', () => lifecycle.push('abort'), { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          losingBodyPulled.resolve();
          await releaseLosingBody.promise;
          drained = true;
          controller.error(signal.reason);
        },
      }, { highWaterMark: 0 }), { status: 401 });
    })
    .mockImplementationOnce(async url => {
      lifecycle.push('refresh');
      expect(url).toBe('https://platform.claude.com/v1/oauth/token');
      expect(firstSignal?.aborted).toBe(true);
      expect(drained).toBe(false);
      return Response.json({ access_token: 'access-new', refresh_token: 'refresh-v2', token_type: 'Bearer', expires_in: 600, scope: '' });
    })
    .mockImplementationOnce(async (_url, init) => {
      lifecycle.push('retry');
      expect(init.signal?.aborted).toBe(false);
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer access-new');
      return sse();
    });
  const host = setup(fetcher, { onSchedule: () => lifecycle.push('schedule-drain') });
  const client = host.start();
  try {
    const answer = await client.result;
    await losingBodyPulled.promise;
    expect(lifecycle).toEqual(['abort', 'schedule-drain', 'refresh', 'retry']);
    expect(drained).toBe(false);
    expect(host.account()).toMatchObject({ refreshToken: 'refresh-v2', accessToken: { token: 'access-new' } });
    expect(answer.anthropicMessages.kind).toBe('stream');
    if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Claude Code events after retry');
    expect(await collect(client.read(answer.anthropicMessages.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
    client.discard(answer);
  } finally {
    releaseLosingBody.resolve();
  }
  expect(await Promise.all(host.background)).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(drained).toBe(true);
});

test('a 401 from a newly minted token remains an upstream error after a single HTTP attempt', async () => {
  const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid token' } };
  const fetcher = vi.fn<Fetcher>()
    .mockResolvedValueOnce(Response.json({ access_token: 'access-new', refresh_token: 'refresh-v2', token_type: 'Bearer', expires_in: 600, scope: '' }))
    .mockResolvedValueOnce(Response.json(body, { status: 401 }));
  const host = setup(fetcher, { account: { ...cachedAccount, accessToken: null } });
  expect(await host.start().result).toMatchObject({
    http: { status: 401, body: null }, anthropicMessages: { kind: 'error', source: 'upstream', error: body },
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.account().accessToken?.token).toBe('access-new');
});

test('sentinel observation follows the multi-chunk 403 body and reports the original detached rejection', async () => {
  const failure = new Error('sentinel persistence failed');
  const bodyStarted = Promise.withResolvers<void>();
  const finishBody = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  const beforeWrite = vi.fn(() => finishWrite.promise);
  const bytes = new TextEncoder().encode(JSON.stringify({
    error: { type: 'permission_error', message: 'OAuth authentication is currently not allowed · Café' },
  }));
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, bytes.byteLength - 4));
    },
    async pull(controller) {
      bodyStarted.resolve();
      await finishBody.promise;
      controller.enqueue(bytes.subarray(bytes.byteLength - 4));
      controller.close();
    },
  }, { highWaterMark: 0 }), { status: 403, headers: { 'x-upstream-request-id': 'sentinel-id' } });
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(response);
  const host = setup(fetcher, { beforeWrite });
  const client = host.start();
  await bodyStarted.promise;
  expect(beforeWrite).not.toHaveBeenCalled();
  expect(host.background).toHaveLength(0);
  finishBody.resolve();

  const answer = await client.result;
  expect(answer).toMatchObject({
    http: { status: 403, headers: [['x-upstream-request-id', 'sentinel-id']], body: null },
    anthropicMessages: {
      kind: 'error', source: 'upstream',
      error: { error: { type: 'permission_error', message: 'OAuth authentication is currently not allowed · Café' } },
    },
  });
  expect(beforeWrite).toHaveBeenCalledOnce();
  expect(host.background).toHaveLength(1);
  expect(host.account().state).toBe('active');
  finishWrite.reject(failure);
  const [background] = await Promise.all(host.background);
  expect(background?.status).toBe('rejected');
  if (background?.status !== 'rejected') throw new Error('Expected the sentinel worker to reject');
  expect(background.reason).toBe(failure);
});

test.each([
  [400, 'invalid_request_error', 'This organization has been disabled.'],
  [403, 'permission_error', 'OAuth authentication is currently not allowed.'],
] as const)('persists the recognized Claude Code sentinel from HTTP %i', async (status, type, message) => {
  const body = { error: { type, message } };
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(Response.json(body, { status })));
  expect(await host.start().result).toMatchObject({
    http: { status, body: null }, anthropicMessages: { kind: 'error', source: 'upstream', error: body },
  });
  expect(await Promise.all(host.background)).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(host.account()).toMatchObject({
    state: 'refresh_failed', stateMessage: expect.stringContaining(message), accessToken: null,
  });
});

test('keeps an unrelated 400 unchanged and does not schedule sentinel persistence', async () => {
  const body = { error: { type: 'invalid_request_error', message: 'Invalid max_tokens' } };
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(Response.json(body, { status: 400 })));
  expect(await host.start().result).toMatchObject({
    http: { status: 400, body: null }, anthropicMessages: { kind: 'error', source: 'upstream', error: body },
  });
  expect(host.background).toHaveLength(0);
  expect(host.account().state).toBe('active');
});

test('delivers successful events while the detached quota write is blocked, then reports its original rejection', async () => {
  const failure = new Error('quota persistence failed');
  const finishWrite = Promise.withResolvers<void>();
  const beforeWrite = vi.fn(() => finishWrite.promise);
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(sse({
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.07',
  })), { beforeWrite });
  const client = host.start();
  const answer = await client.result;
  expect(beforeWrite).toHaveBeenCalledOnce();
  expect(host.account().quotaSnapshot).toBeNull();
  expect(answer.anthropicMessages.kind).toBe('stream');
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Claude Code events');
  expect(await collect(client.read(answer.anthropicMessages.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
  client.discard(answer);
  finishWrite.reject(failure);
  const [background] = await Promise.all(host.background);
  expect(background?.status).toBe('rejected');
  if (background?.status !== 'rejected') throw new Error('Expected the quota worker to reject');
  expect(background.reason).toBe(failure);
});

test('persists the latest model quota snapshot and its metric when HTTP returns 429', async () => {
  const body = { type: 'error', error: { type: 'rate_limit_error', message: 'Window exhausted' } };
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(Response.json(body, {
    status: 429,
    headers: {
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '0.07',
    },
  })));
  expect(await host.start().result).toMatchObject({
    http: { status: 429, body: null }, anthropicMessages: { kind: 'error', source: 'upstream', error: body },
  });
  expect(await Promise.all(host.background)).toEqual([{ status: 'fulfilled', value: undefined }]);
  const persisted = host.account().quotaSnapshot;
  expect(persisted).toMatchObject({ modelId, data: { status: 'rejected' } });
  expect(host.recordUpstreamMetric).toHaveBeenCalledWith(
    upstreamId, 'quota.utilization', { quota: 'five_hour' }, 7, persisted?.fetchedAt,
  );
});

test('local quota gating rereads provider state and skips HTTP', async () => {
  const fetcher = vi.fn<Fetcher>();
  const reset = Math.floor(Date.now() / 1000) + 60;
  const host = setup(fetcher, {
    account: {
      ...cachedAccount,
      quotaSnapshot: {
        fetchedAt: Date.now(),
        modelId,
        data: parseClaudeCodeQuotaHeaders(new Headers({
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-reset': String(reset),
        })),
      },
    },
  });
  const answer = await host.start().result;
  expect(answer).toMatchObject({
    http: {
      status: 429,
      body: null,
      headers: expect.arrayContaining([['retry-after', expect.stringMatching(/^[1-9]\d*$/)]]),
    },
    anthropicMessages: { kind: 'error', source: 'local', error: { error: { retry_at: new Date(reset * 1000).toISOString() } } },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

// Claude Code 2.1.322 maps the per-model seven_day_overage_included claim to 7d_oi.
// https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.322.tgz
test.each([false, true])('a Fable 429 only blocks Fable when 5h headers present is %s', async includesFiveHour => {
  const retrySeconds = 6 * 24 * 60 * 60;
  const reset = String(Math.floor(Date.now() / 1000) + retrySeconds);
  const fable = { ...model, id: 'public-fable', upstreamModelId: 'claude-fable-5-1' };
  const body = { error: { type: 'rate_limit_error', message: 'Fable weekly allowance exhausted' } };
  const fetcher = vi.fn<Fetcher>()
    .mockResolvedValueOnce(Response.json(body, {
      status: 429,
      headers: {
        'anthropic-ratelimit-unified-status': 'rejected',
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
        'anthropic-ratelimit-unified-reset': reset,
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.62',
        'anthropic-ratelimit-unified-7d-reset': reset,
        'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
        'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
        'anthropic-ratelimit-unified-7d_oi-reset': reset,
        'anthropic-ratelimit-unified-overage-status': 'rejected',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'out_of_credits',
        'retry-after': String(retrySeconds),
        ...(includesFiveHour ? { 'anthropic-ratelimit-unified-5h-status': 'allowed' } : {}),
      },
    }))
    .mockImplementation(async () => sse());
  const host = setup(fetcher);
  const first = host.start({ ...request, model: fable });
  const denied = await first.result;
  expect(denied).toMatchObject({
    http: { status: 429, headers: expect.arrayContaining([['retry-after', String(retrySeconds)]]) },
    anthropicMessages: { kind: 'error', source: 'upstream', error: body },
  });
  first.discard(denied);
  expect(await Promise.all(host.background)).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(host.account().quotaSnapshot).toMatchObject({
    modelId: fable.upstreamModelId,
    data: { status: 'rejected', representativeClaim: 'seven_day_overage_included' },
  });

  const second = host.start({ ...request, model: fable });
  const blocked = await second.result;
  expect(blocked).toMatchObject({ http: { status: 429 }, anthropicMessages: { kind: 'error', source: 'local' } });
  second.discard(blocked);
  expect(fetcher).toHaveBeenCalledOnce();

  for (const upstreamModelId of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']) {
    const client = host.start({ ...request, model: { ...model, upstreamModelId } });
    const answer = await client.result;
    expect(answer).toMatchObject({ http: { status: 200 }, anthropicMessages: { kind: 'stream' } });
    expect(requestBody(fetcher.mock.calls.at(-1)![1]).model).toBe(upstreamModelId);
    client.discard(answer);
  }
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test('a terminal account returns a local 503 without calling OAuth or Messages', async () => {
  const fetcher = vi.fn<Fetcher>();
  const host = setup(fetcher, {
    account: { ...cachedAccount, state: 'refresh_failed', stateMessage: 'Refresh credential revoked', accessToken: null },
  });
  expect(await host.start().result).toMatchObject({
    http: { status: 503, body: null },
    anthropicMessages: { kind: 'error', source: 'local', error: { error: { message: expect.stringContaining('Refresh credential revoked') } } },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('consumes pre-header transport and abort errors into Anthropic outcomes', async () => {
  const cause = new TypeError('socket disconnected');
  const failure = new Error('connection refused', { cause });
  const transportError = new HttpTransportError(failure);
  const transport = setup(vi.fn<Fetcher>().mockRejectedValue(transportError));
  expect(await transport.start().result).toEqual({
    http: null,
    anthropicMessages: {
      kind: 'error',
      source: 'upstream',
      error: {
        type: 'error',
        error: {
          type: 'api_error',
          message: failure.message,
          provider_specific_fields: {
            name: transportError.name,
            stack: transportError.stack,
            cause: {
              name: failure.name,
              stack: failure.stack,
              message: failure.message,
              cause: { name: cause.name, stack: cause.stack, message: cause.message, cause: undefined },
            },
          },
        },
      },
    },
  });
  const fetcher = vi.fn<Fetcher>();
  const aborted = setup(fetcher);
  aborted.controller.abort();
  expect(await aborted.start().result).toEqual({
    http: null,
    anthropicMessages: { kind: 'error', source: 'local', error: { type: 'error', error: { type: 'invalid_request_error', message: 'Upstream request cancelled' } } },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

test('keeps a damaged SSE response as a protocol Err and propagates an unexpected pre-header panic by identity', async () => {
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(sse({}, 'data: {"type":"ping"}\n\n')));
  const client = host.start();
  const answer = await client.result;
  expect(answer.anthropicMessages.kind).toBe('stream');
  if (answer.anthropicMessages.kind !== 'stream') throw new Error('Expected Claude Code events');
  expect(await collect(client.read(answer.anthropicMessages.stream))).toEqual([
    { ok: true, value: { type: 'ping' } },
    { ok: false, error: expect.objectContaining({ kind: 'protocol' }) },
  ]);
  client.discard(answer);
  const panic = new TypeError('unexpected transport flaw');
  const failed = setup(vi.fn<Fetcher>().mockRejectedValue(panic));
  await expect(failed.start().result).rejects.toBe(panic);
});

test('rejects a response error body larger than the explicit byte limit', async () => {
  const body = new Uint8Array(2 * 1024 * 1024 + 1);
  const host = setup(vi.fn<Fetcher>().mockResolvedValue(new Response(body, { status: 500 })));
  await expect(host.start().result).rejects.toThrow('Upstream response body exceeds 2097152 bytes');
  expect(await Promise.all(host.background)).toEqual([{ status: 'fulfilled', value: undefined }]);
});
