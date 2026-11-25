import { afterEach, describe, expect, test, vi } from 'vitest';

import { resolveCopilotToken } from '../src/auth.ts';
import { copilotUpstreamFact, type CopilotUpstream } from '../src/config.ts';
import { copilotOperation } from '../src/pipelines/facts.ts';
import { authorize } from '../src/pipelines/shared/authorize.ts';
import { formatOpenAIError } from '../src/pipelines/shared/format-errors.ts';
import { createCopilotService, type CopilotService } from '../src/service.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from '../src/state.ts';
import { UpstreamTransportError, type ProviderFetcher } from '@floway-dev/http';
import { run, Secret } from '@floway-dev/pipeline';
import { initProviderRepo, type UpstreamRecord } from '@floway-dev/provider';
import { jsonResponse } from '@floway-dev/test-utils';

const upstream: CopilotUpstream = {
  id: 'up_copilot_test',
  kind: 'copilot',
  name: 'auth-test',
  config: { githubHost: 'github.com', githubToken: Secret.from('ghu_test') },
};
const TOKEN_BASE_URL = 'https://api.individual.githubcopilot.com';
const warn = () => {};

const tokenResponse = (baseUrl = TOKEN_BASE_URL, token = 'tok-test'): Response => jsonResponse({
  token,
  expires_at: 4_102_444_800,
  refresh_in: 1800,
  endpoints: { api: baseUrl },
});

const installRepo = (initialState: unknown = null) => {
  let state = initialState;
  let version = 1;
  let record: UpstreamRecord = {
    id: upstream.id,
    kind: upstream.kind,
    name: upstream.name,
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: { githubHost: 'github.com', githubToken: 'ghu_test', user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...record, state, configVersion: version }),
      saveState: async (_id, mutate) => { state = mutate(state, version); },
    },
  }));
  return {
    service: createCopilotService(),
    setState(next: unknown) { state = next; },
    replaceConfig(githubToken: string, githubHost: string, nextState: unknown) {
      version++;
      record = { ...record, config: { githubHost, githubToken, user: { id: 1, login: 't', name: null, avatar_url: '' } } };
      state = nextState;
    },
    state: () => readCopilotUpstreamState(state),
    record,
  };
};

const exchange = (fetcher: ProviderFetcher, signal = new AbortController().signal) =>
  resolveCopilotToken(upstream, fetcher, signal, warn, () => {});

describe('Copilot token exchange retries', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('makes four attempts after exact 1s, 2s, and 4s delays', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const pending = exchange(async () => {
      attempts++;
      if (attempts < 4) throw new UpstreamTransportError(new Error(`transient ${attempts}`));
      return { response: tokenResponse() };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: true, value: { baseUrl: TOKEN_BASE_URL } });
    expect(attempts).toBe(4);
  });

  test('exposes an unexpected rejection immediately and preserves the original value', async () => {
    const reason = { issue: 'broken fetcher' };
    const fetcher = vi.fn(async () => { throw reason; });
    await expect(exchange(fetcher)).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test.each([403, 429])('returns HTTP %s immediately with its original headers and bytes', async status => {
    const fetcher = vi.fn(async () => ({ response: new Response('declined', { status, headers: [['x-upstream', 'token']] }) }));
    const result = await exchange(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, error: { kind: 'http', head: { status } } });
    if (result.ok || result.error.kind !== 'http' || result.error.body === null) throw new Error('expected HTTP error body');
    const text = [];
    for await (const item of result.error.body) {
      if (!item.ok) throw item.error.cause;
      text.push(new TextDecoder().decode(item.value));
    }
    expect(text.join('')).toBe('declined');
    expect(result.error.head.headers).toContainEqual(['x-upstream', 'token']);
  });

  test('preserves a fetcher panic that occurs after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('fetcher bug');
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw reason;
    });
    await expect(exchange(fetcher, controller.signal)).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('returns an abort when cancelled during backoff', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new DOMException('cancelled during backoff', 'AbortError');
    const fetcher = vi.fn(async () => { throw new UpstreamTransportError(new Error('transient')); });
    const result = exchange(fetcher, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    expect(await result).toEqual({ ok: false, error: { kind: 'io', head: null, error: { kind: 'abort', cause: reason } } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('keeps the recorded transport failure when cancellation stops a retry from being scheduled', async () => {
    const controller = new AbortController();
    const cause = new UpstreamTransportError(new Error('dial reset'));
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw cause;
    });
    const result = await exchange(fetcher, controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, error: { kind: 'io', head: null, error: { kind: 'transport', cause } } });
  });

  test('releases the unopened HTTP response of a losing retry', async () => {
    vi.useFakeTimers();
    const pull = vi.fn();
    const cancel = vi.fn();
    let attempts = 0;
    const pending = exchange(async () => {
      attempts++;
      return {
        response: attempts === 1
          ? new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), { status: 503 })
          : tokenResponse(),
      };
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ ok: true, value: { token: 'tok-test' } });
  });
});

const credentials = (service: CopilotService, fetcher: ProviderFetcher, selected: CopilotUpstream = upstream) =>
  service.credentials(selected, fetcher, new AbortController().signal, warn, () => {});

test('exchanges a GHE credential on the tenant API and returns the Copilot API from that exchange', async () => {
  const { record, replaceConfig, service } = installRepo();
  const api = 'https://api.business.githubcopilot.com';
  replaceConfig('ghu_ghe', 'octocorp.ghe.com', null);
  const fetcher = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('token ghu_ghe');
    return { response: tokenResponse(api) };
  });
  const result = await credentials(service, fetcher, copilotUpstreamFact(record));

  expect(fetcher.mock.calls[0][0]).toBe('https://api.octocorp.ghe.com/copilot_internal/v2/token');
  expect(result).toMatchObject({ ok: true, value: { baseUrl: api, token: expect.any(Secret) } });
});

test('hydrates a valid persisted token after invalidating the service memo', async () => {
  const { service, state } = installRepo();
  const fetcher = vi.fn<ProviderFetcher>(async () => ({ response: tokenResponse() }));
  const first = await credentials(service, fetcher);
  expect(first).toMatchObject({ ok: true });
  service.clearTokens(upstream.id);
  const second = await credentials(service, fetcher);
  expect(second).toMatchObject({ ok: true, value: { baseUrl: TOKEN_BASE_URL } });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(state().copilotToken?.token).toBe('tok-test');
});

test('persists a mint against the state that won a concurrent quota write', async () => {
  const { service, state, setState } = installRepo();
  const quotaSnapshot: CopilotUpstreamState['quotaSnapshot'] = {
    fetchedAt: 1,
    data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} },
  };
  const result = await credentials(service, async () => {
    setState({ knownModels: null, copilotToken: null, quotaSnapshot });
    return { response: tokenResponse() };
  });
  expect(result).toMatchObject({ ok: true });
  expect(state().copilotToken?.token).toBe('tok-test');
  expect(state().quotaSnapshot).toEqual(quotaSnapshot);
});

test('exchanges the PAT bound to the CAS version and skips a mint rejected after re-import', async () => {
  const { record, service, replaceConfig, state } = installRepo();
  const staleProjection = copilotUpstreamFact(record);
  replaceConfig('ghu_v2', 'github.com', null);
  const fetcher = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('token ghu_v2');
    replaceConfig('ghu_v3', 'github.com', null);
    return { response: tokenResponse(TOKEN_BASE_URL, 'tok-v2') };
  });
  await expect(credentials(service, fetcher, staleProjection)).resolves.toMatchObject({ ok: true });
  expect(state().copilotToken).toBeNull();

  const reexchange = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('token ghu_v3');
    return { response: tokenResponse(TOKEN_BASE_URL, 'tok-v3') };
  });
  await credentials(service, reexchange, staleProjection);
  expect(reexchange).toHaveBeenCalledOnce();
  expect(state().copilotToken?.token).toBe('tok-v3');
});

test('a different isolate re-importing the upstream invalidates the first isolate’s token memo', async () => {
  const { service, replaceConfig } = installRepo();
  const fetcher = vi.fn<ProviderFetcher>(async () => ({ response: tokenResponse() }));
  await credentials(service, fetcher);
  const previous = await credentials(service, fetcher);
  expect(previous.ok && previous.value.token.describe().hash).toBe(Secret.from('tok-test').describe().hash);

  replaceConfig('ghu_rotated', 'github.com', null);
  const otherIsolate = createCopilotService();
  const mint = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('token ghu_rotated');
    return { response: tokenResponse(TOKEN_BASE_URL, 'new-token') };
  });
  await credentials(otherIsolate, mint);
  const current = await credentials(service, fetcher);
  expect(current.ok && current.value.token.describe().hash).toBe(Secret.from('new-token').describe().hash);
  expect(mint).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledOnce();
});

test('hands an unopened, oversized non-2xx token body to the authorize stage’s caller', async () => {
  const { service } = installRepo();
  const bytes = new TextEncoder().encode('x'.repeat(300 * 1024));
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    controller.enqueue(bytes);
    controller.close();
  });
  const source = new ReadableStream({ pull }, { highWaterMark: 0 });
  const fetcher: ProviderFetcher = async () => ({ response: new Response(source, { status: 403 }) });
  const { compose, defineStage } = copilotOperation<'openaiChatCompletions'>();
  const ending = defineStage({
    name: 'unused-copilot-dial',
    request: { needs: [] },
    return: { provides: ['response.http'] },
    async execute() { throw new Error('Token rejection must short-circuit the dial'); },
  });
  const pipeline = compose('authorize-copilot', {
    entry: ['request.http', 'provider.upstream'],
    exit: ['response.http', 'response.openaiChatCompletions?'],
    stages: [authorize('openaiChatCompletions', formatOpenAIError)],
    ending,
  });
  const controller = new AbortController();
  const running = run(pipeline, {
    'provider.upstream': upstream,
    'request.http': { method: 'POST', url: 'https://floway.test', headers: [], body: null },
  }, {
    services: { copilot: service, fetcher: () => fetcher },
    signal: controller.signal,
    waitUntil() {},
  });
  try {
    const http = (await running.result)['response.http'];
    expect(http).toMatchObject({ status: 403 });
    expect(pull).not.toHaveBeenCalled();
    if (!http?.body || http.body instanceof Uint8Array) throw new Error('expected an unopened HTTP byte stream');
    const chunks = [];
    for await (const item of running.read(http.body)) {
      if (!item.ok) throw item.error.cause;
      chunks.push(item.value);
    }
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(bytes.length);
    expect(pull).toHaveBeenCalledOnce();
    await running.done;
  } finally {
    controller.abort();
  }
});
