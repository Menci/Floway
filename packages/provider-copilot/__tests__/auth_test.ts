import { afterEach, describe, expect, test, vi } from 'vitest';

import { modelInput, runCopilotPipeline } from './pipeline-fixture.ts';
import type { CopilotUpstreamFacts } from '../src/config.ts';
import { clearInProcessCopilotTokenCache } from '../src/index.ts';
import { copilotPipelines } from '../src/pipelines.ts';
import type { CopilotUpstreamState } from '../src/state.ts';
import { isSecret, secret, type RunEvent } from '@floway-dev/pipeline';
import { initProviderRepo, directFetcher, UpstreamTransportError, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_copilot_test';
const TOKEN_BASE_URL = 'https://api.individual.githubcopilot.com';

const tokenResponse = (): Response => jsonResponse({
  token: 'tok-test',
  expires_at: 4_102_444_800,
  refresh_in: 1800,
  endpoints: { api: TOKEN_BASE_URL },
});

const installRepoAndClearCache = async () => {
  let state: unknown = null;
  const stub: UpstreamRecord = {
    id: UPSTREAM_ID,
    kind: 'copilot',
    name: 'auth-test',
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
      getById: async () => ({ ...stub, state, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        state = mutate(state, 1);
      },
    },
  }));
  clearInProcessCopilotTokenCache();
};

const defaultAuth: CopilotUpstreamFacts = {
  id: UPSTREAM_ID,
  kind: 'copilot',
  name: 'auth-test',
  config: { githubHost: 'github.com', githubToken: secret('ghu_test') },
};

const runAuthedPipeline = async (auth: CopilotUpstreamFacts, fetcher: Fetcher, signal?: AbortSignal) => {
  const model = stubProviderModel({
    id: 'claude-test',
    endpoints: { anthropicMessages: {} },
    providerData: { rawModels: [{ id: 'claude-test' }] },
  });
  const trace: RunEvent[] = [];
  const handle = runCopilotPipeline(copilotPipelines.anthropicMessages, {
    ...modelInput(model, { messages: [], max_tokens: 32 }, auth),
    'request.anthropicBeta': [],
  }, fetcher, { signal, events: event => trace.push(event) });
  try {
    const output = await handle.result;
    const http = output['response.http'];
    const outcome = output['response.anthropicMessages'];
    if (outcome.kind === 'stream') await Array.fromAsync(outcome.events);
    assertEquals(await handle.done, { ok: true });
    return { status: http.status, headers: http.headers, transportError: http.transportError, outcome, trace };
  } finally {
    await handle.done;
  }
};

const runAuthedFetch = async (fetcher: Fetcher, signal?: AbortSignal) => {
  await installRepoAndClearCache();
  return await runAuthedPipeline(defaultAuth, fetcher, signal);
};

const messageStop = () => sseResponse('data: {"type":"message_stop"}\n\n');

describe('Copilot token exchange retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('makes four attempts after exact 1s, 2s, and 4s delays', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tokenAttempts = 0;
    const fetcher: Fetcher = async url => {
      if (new URL(url).pathname !== '/copilot_internal/v2/token') return messageStop();
      tokenAttempts++;
      if (tokenAttempts < 4) throw new Error(`transient ${tokenAttempts}`);
      return tokenResponse();
    };

    const result = runAuthedFetch(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(tokenAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenAttempts).toBe(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(tokenAttempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tokenAttempts).toBe(3);

    await vi.advanceTimersByTimeAsync(3999);
    expect(tokenAttempts).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ status: 200 });
    expect(tokenAttempts).toBe(4);
  });

  test('retries a non-Error rejection and finally preserves the original value', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reason = 'proxy rejected';
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      throw reason;
    };

    const rejection = expect(runAuthedFetch(fetcher)).rejects.toBe(reason);
    await vi.runAllTimersAsync();
    await rejection;
    expect(tokenAttempts).toBe(4);
  });

  test('treats an HTTP error as terminal on the first attempt', async () => {
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      return new Response('status 429', { status: 429, headers: { 'retry-after': '15' } });
    };

    const result = await runAuthedFetch(fetcher);
    expect(result.status).toBe(429);
    expect(result.headers).toContainEqual(['retry-after', '15']);
    expect(result.outcome).toEqual({ kind: 'error', source: 'upstream', error: { error: { type: 'upstream_error', message: 'status 429' } } });
    expect(tokenAttempts).toBe(1);
  });

  test('returns an upstream error after token endpoint transport failures exhaust retries', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(new UpstreamTransportError(new Error('token endpoint unreachable')));
    const pending = runAuthedFetch(fetcher);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([url]) => new URL(url).pathname === '/copilot_internal/v2/token')).toBe(true);
    expect(result.status).toBe(502);
    expect(result.transportError?.name).toBe('UpstreamTransportError');
    expect(result.outcome).toEqual({
      kind: 'error',
      source: 'upstream',
      error: { error: { type: 'upstream_transport_error', message: 'token endpoint unreachable' } },
    });
  });

  test('preserves an AbortError thrown by the token fetcher without retrying', async () => {
    const reason = new DOMException('fetch cancelled', 'AbortError');
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      throw reason;
    };

    await expect(runAuthedFetch(fetcher)).rejects.toBe(reason);
    expect(tokenAttempts).toBe(1);
  });

  test('preserves a signal reason when cancelled during backoff', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const reason = new DOMException('cancelled during backoff', 'AbortError');
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      throw new Error('transient');
    };

    const result = runAuthedFetch(fetcher, controller.signal);
    const rejection = expect(result).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenAttempts).toBe(1);
    controller.abort(reason);
    await rejection;
    expect(tokenAttempts).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

test('Copilot exchanges a GHE credential on the tenant API and still follows token endpoints.api', async () => {
  await installRepoAndClearCache();
  const observed: string[] = [];
  await withMockedFetch(
    async request => {
      observed.push(request.url);
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok-ghe',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1800,
          endpoints: { api: 'https://api.business.githubcopilot.com' },
        });
      }
      return messageStop();
    },
    async () => {
      await runAuthedPipeline({ ...defaultAuth, config: { githubHost: 'octocorp.ghe.com', githubToken: secret('ghu_ghe') } }, directFetcher);
    },
  );

  assertEquals(observed, [
    'https://api.octocorp.ghe.com/copilot_internal/v2/token',
    'https://api.business.githubcopilot.com/v1/messages',
  ]);
});

test('Copilot reads a still-valid token from state_json instead of refreshing', async () => {
  await installRepoAndClearCache();
  let tokenFetches = 0;
  let upstreamFetches = 0;
  let authHeader: string | null = null;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        tokenFetches++;
        return jsonResponse({
          token: 'tok-persisted',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1800,
          endpoints: { api: TOKEN_BASE_URL },
        });
      }
      upstreamFetches++;
      authHeader = request.headers.get('authorization');
      return messageStop();
    },
    async () => {
      const { trace } = await runAuthedPipeline(defaultAuth, directFetcher);
      const wire = trace.find(event => event.k === 'enter' && event.name === 'http');
      if (wire?.k !== 'enter') throw new Error('Expected the Copilot HTTP terminal to run');
      const http = wire.facts['request.http'];
      if (typeof http !== 'object' || http === null || !('headers' in http) || !Array.isArray(http.headers)) {
        throw new Error('Expected HTTP request facts');
      }
      const authorization = http.headers.find(entry => Array.isArray(entry) && entry[0] === 'authorization');
      assertEquals(isSecret(authorization?.[1]), true);
      // Drop the in-process memo so the second call has to consult state_json;
      // if state_json hydration works, the token endpoint won't be hit again.
      clearInProcessCopilotTokenCache();
      await runAuthedPipeline(defaultAuth, directFetcher);
    },
  );

  assertEquals(tokenFetches, 1);
  assertEquals(upstreamFetches, 2);
  assertEquals(authHeader, 'Bearer tok-persisted');
});

// Regression: the token persist used to build its document from the row read
// BEFORE the token exchange, so any write that landed during that round trip —
// and the quota harvest writes this row on every data-plane response — was
// either overwritten or cost the upstream its freshly minted token. The persist
// is now a mutator over the state the repo hands it at write time.
test('Copilot persists a minted token even when the row changed during the exchange', async () => {
  let state: unknown = { knownModels: null, copilotToken: null, quotaSnapshot: null };
  let exchanged = false;
  const stub: UpstreamRecord = {
    id: UPSTREAM_ID,
    kind: 'copilot',
    name: 'auth-test',
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
      getById: async () => ({ ...stub, state, configVersion: 1 }),
      saveState: async (_id, mutate) => {
        state = mutate(state, 1);
      },
    },
  }));
  clearInProcessCopilotTokenCache();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        // A concurrent quota harvest lands mid-exchange, advancing the row.
        exchanged = true;
        state = {
          knownModels: null,
          copilotToken: null,
          quotaSnapshot: { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } },
        };
        return jsonResponse({
          token: 'tok-test',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1800,
          endpoints: { api: TOKEN_BASE_URL },
        });
      }
      return messageStop();
    },
    async () => {
      await runAuthedPipeline(defaultAuth, directFetcher);
    },
  );

  assertEquals(exchanged, true);
  const persisted = state as CopilotUpstreamState;
  assertEquals(persisted.copilotToken?.token, 'tok-test');
  // The sibling write that landed mid-exchange survives — the persist spreads
  // the row as it stands now, not the snapshot taken before the round trip.
  assertEquals(persisted.quotaSnapshot?.fetchedAt, 1);
});
