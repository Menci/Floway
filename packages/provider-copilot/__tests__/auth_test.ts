import { afterEach, describe, expect, test, vi } from 'vitest';

import { copilotAuthedFetch } from '../src/auth.ts';
import { clearInProcessCopilotTokenCache } from '../src/index.ts';
import type { CopilotUpstreamState } from '../src/state.ts';
import { initProviderRepo, directFetcher, type Fetcher, type UpstreamRecord, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

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
    config: { githubToken: 'ghu_test', user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => ({ ...stub, state }),
      saveState: async (_id, mutate) => {
        state = mutate(state);
      },
    },
  }));
  clearInProcessCopilotTokenCache();
  return {
    readPersistedState: (): CopilotUpstreamState | null => state as CopilotUpstreamState | null,
  };
};

const mockTokenAndCapture = async (
  extraHeaders: Headers | undefined,
  assert: (headers: Headers) => void,
): Promise<void> => {
  await installRepoAndClearCache();
  let captured: Headers | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok-test',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1800,
          endpoints: { api: TOKEN_BASE_URL },
        });
      }
      captured = new Headers(request.headers);
      return new Response('{}', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test' },
        extraHeaders ? { headers: extraHeaders, fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall } : { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );

  if (!captured) throw new Error('upstream call never observed');
  assert(captured);
};

const runAuthedFetch = async (fetcher: Fetcher, signal?: AbortSignal): Promise<Response> => {
  await installRepoAndClearCache();
  return await copilotAuthedFetch(
    '/v1/messages',
    { method: 'POST', body: '{}', signal },
    { id: UPSTREAM_ID, githubToken: 'ghu_test' },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
};

describe('Copilot token exchange retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('makes four attempts after exact 1s, 2s, and 4s delays', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tokenAttempts = 0;
    const fetcher: Fetcher = async url => {
      if (new URL(url).pathname !== '/copilot_internal/v2/token') return jsonResponse({});
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
    expect(warn.mock.calls).toEqual([
      ['Retry 1/3 after 1000ms: transient 1'],
      ['Retry 2/3 after 2000ms: transient 2'],
      ['Retry 3/3 after 4000ms: transient 3'],
    ]);
  });

  test.each([
    { label: 'string', reason: 'proxy rejected', message: 'proxy rejected' },
    { label: 'object', reason: { kind: 'proxy rejected' }, message: '[object Object]' },
  ])('retries a non-Error $label rejection and finally preserves the original value', async ({ reason, message }) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      throw reason;
    };

    const result = runAuthedFetch(fetcher);
    const rejection = expect(result).rejects.toBe(reason);
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
    await rejection;
    expect(tokenAttempts).toBe(4);
    expect(warn.mock.calls).toEqual([
      [`Retry 1/3 after 1000ms: ${message}`],
      [`Retry 2/3 after 2000ms: ${message}`],
      [`Retry 3/3 after 4000ms: ${message}`],
    ]);
  });

  test.each([403, 429])('treats HTTP %i as terminal on the first attempt', async status => {
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      return new Response(`status ${status}`, { status });
    };

    await expect(runAuthedFetch(fetcher)).rejects.toMatchObject({
      name: 'CopilotTokenFetchError',
      status,
      body: `status ${status}`,
    });
    expect(tokenAttempts).toBe(1);
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

  test('preserves a non-Error wrapper whose cause is an AbortError without retrying', async () => {
    const reason = { cause: new DOMException('fetch cancelled', 'AbortError') };
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      throw reason;
    };

    await expect(runAuthedFetch(fetcher)).rejects.toBe(reason);
    expect(tokenAttempts).toBe(1);
  });

  test('preserves an already-aborted signal reason without starting an attempt', async () => {
    const controller = new AbortController();
    const reason = new DOMException('already cancelled', 'AbortError');
    controller.abort(reason);
    let tokenAttempts = 0;
    const fetcher: Fetcher = async () => {
      tokenAttempts++;
      return tokenResponse();
    };

    await expect(runAuthedFetch(fetcher, controller.signal)).rejects.toBe(reason);
    expect(tokenAttempts).toBe(0);
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

test('copilotAuthedFetch overlays interceptor headers on the pinned base set', async () => {
  await mockTokenAndCapture(new Headers({ 'x-initiator': 'agent', 'copilot-vision-request': 'true' }), headers => {
    assertEquals(headers.get('x-initiator'), 'agent');
    assertEquals(headers.get('copilot-vision-request'), 'true');
    // Base headers we did not override stay pinned.
    assertEquals(headers.get('copilot-integration-id'), 'vscode-chat');
    assertEquals(headers.get('openai-intent'), 'conversation-agent');
  });
});

test('copilotAuthedFetch deletes a base header when the interceptor passes an empty-string value', async () => {
  // Sentinel contract: empty string means drop this base header from the pinned set.
  await mockTokenAndCapture(new Headers({ 'copilot-integration-id': '' }), headers => {
    assertEquals(headers.has('copilot-integration-id'), false);
  });
});

test('copilotAuthedFetch persists the minted Copilot token (with baseUrl) into state_json.copilotToken', async () => {
  const harness = await installRepoAndClearCache();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok-persisted',
          expires_at: expiresAt,
          refresh_in: 1800,
          endpoints: { api: TOKEN_BASE_URL },
        });
      }
      return new Response('{}', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test' },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );

  const persisted = harness.readPersistedState();
  if (!persisted) throw new Error('expected state_json to be written');
  assertEquals(persisted.copilotToken?.token, 'tok-persisted');
  assertEquals(persisted.copilotToken?.expiresAt, expiresAt);
  assertEquals(persisted.copilotToken?.baseUrl, TOKEN_BASE_URL);
});

test('copilotAuthedFetch routes the data-plane call through the baseUrl GitHub stamped on the token', async () => {
  await installRepoAndClearCache();
  let observedUrl: string | null = null;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'tok-test',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_in: 1800,
          endpoints: { api: 'https://api.enterprise.githubcopilot.com' },
        });
      }
      observedUrl = request.url;
      return new Response('{}', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test' },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );
  assertEquals(observedUrl, 'https://api.enterprise.githubcopilot.com/v1/messages');
});

test('copilotAuthedFetch reads a still-valid Copilot token from state_json instead of refreshing', async () => {
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
      return new Response('{}', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      const args = [
        '/v1/messages',
        { method: 'POST' as const, body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test' },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      ] as const;
      await copilotAuthedFetch(...args);
      // Drop the in-process memo so the second call has to consult state_json;
      // if state_json hydration works, the token endpoint won't be hit again.
      clearInProcessCopilotTokenCache();
      await copilotAuthedFetch(...args);
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
test('copilotAuthedFetch persists a minted token even when the row changed during the exchange', async () => {
  let state: unknown = { knownModels: null, copilotToken: null, quotaSnapshot: null };
  let exchanged = false;
  const stub: UpstreamRecord = {
    id: UPSTREAM_ID,
    kind: 'copilot',
    name: 'auth-test',
    enabled: true,
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
    config: { githubToken: 'ghu_test', user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => ({ ...stub, state }),
      saveState: async (_id, mutate) => {
        state = mutate(state);
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
      return new Response('{}', { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test' },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );

  assertEquals(exchanged, true);
  const persisted = state as CopilotUpstreamState;
  assertEquals(persisted.copilotToken?.token, 'tok-test');
  // The sibling write that landed mid-exchange survives — the persist spreads
  // the row as it stands now, not the snapshot taken before the round trip.
  assertEquals(persisted.quotaSnapshot?.fetchedAt, 1);
});
