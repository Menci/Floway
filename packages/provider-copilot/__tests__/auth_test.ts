import { afterEach, describe, expect, test, vi } from 'vitest';

import { createCopilotCredentials } from '../src/auth.ts';
import { readCopilotUpstreamState } from '../src/state.ts';
import { initProviderRepo, type Fetcher, type UpstreamRecord } from '@floway-dev/provider';
import { jsonResponse } from '@floway-dev/test-utils';

const upstreamId = 'up_copilot_test';
const tokenBaseUrl = 'https://api.individual.githubcopilot.com';
const githubHost = 'github.com';
const githubToken = 'ghu_test';

const tokenResponse = (token = 'tok-test', api = tokenBaseUrl): Response => jsonResponse({
  token,
  expires_at: 4_102_444_800,
  refresh_in: 1800,
  endpoints: { api },
});

const installRepo = (host = githubHost) => {
  let state: unknown = null;
  let configVersion = 1;
  const record: UpstreamRecord = {
    id: upstreamId,
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
    config: { githubHost: host, githubToken, user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: {
      getById: async () => ({ ...record, state, configVersion }),
      async saveState(_id, mutate) { state = mutate(state, configVersion); },
    },
  }));
  return {
    credentials: createCopilotCredentials(),
    getState: () => readCopilotUpstreamState(state),
    setState(next: unknown) { state = next; },
    advanceConfig() { configVersion++; },
  };
};

const runExchange = (fetcher: Fetcher) =>
  installRepo().credentials.getCopilotToken(upstreamId, githubHost, githubToken, fetcher);

describe('Copilot token exchange retries', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('makes four attempts after exact 1s, 2s, and 4s delays', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetcher = vi.fn<Fetcher>()
      .mockRejectedValueOnce(new Error('transient 1'))
      .mockRejectedValueOnce(new Error('transient 2'))
      .mockRejectedValueOnce(new Error('transient 3'))
      .mockResolvedValueOnce(tokenResponse());

    const pending = runExchange(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(3999);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ token: 'tok-test', baseUrl: tokenBaseUrl });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  test('retries a non-Error rejection and finally preserves the original value', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reason = 'proxy rejected';
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(reason);
    const rejection = expect(runExchange(fetcher)).rejects.toBe(reason);
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  test.each([403, 429])('treats a token exchange HTTP %d as terminal', async status => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(new Response('exchange refused', { status }));
    await expect(runExchange(fetcher)).rejects.toMatchObject({
      name: 'CopilotTokenFetchError',
      status,
      body: 'exchange refused',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test('preserves an AbortError thrown by the token fetcher without retrying', async () => {
    const reason = new DOMException('fetch cancelled', 'AbortError');
    const fetcher = vi.fn<Fetcher>().mockRejectedValue(reason);
    await expect(runExchange(fetcher)).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

test('exchanges a GitHub Enterprise credential on the tenant API and returns its Copilot endpoint', async () => {
  const host = 'octocorp.ghe.com';
  const baseUrl = 'https://api.business.githubcopilot.com';
  const { credentials } = installRepo(host);
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(tokenResponse('tok-ghe', baseUrl));

  await expect(credentials.getCopilotToken(upstreamId, host, githubToken, fetcher)).resolves.toMatchObject({
    baseUrl,
    token: 'tok-ghe',
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0][0]).toBe('https://api.octocorp.ghe.com/copilot_internal/v2/token');
});

test('hydrates a valid token from persisted state after clearing the local memo', async () => {
  const { credentials } = installRepo();
  const fetcher = vi.fn<Fetcher>().mockResolvedValue(tokenResponse('tok-persisted'));

  await credentials.getCopilotToken(upstreamId, githubHost, githubToken, fetcher);
  credentials.clear();
  await expect(credentials.getCopilotToken(upstreamId, githubHost, githubToken, fetcher)).resolves.toMatchObject({
    token: 'tok-persisted',
  });
  expect(fetcher).toHaveBeenCalledOnce();
});

test('merges a token into the state written by a concurrent quota observation', async () => {
  const { credentials, getState, setState } = installRepo();
  const quotaSnapshot = { fetchedAt: 1, data: { observed_at: '2026-08-01T00:00:00.000Z', reset_at: null, quotas: {} } };
  const fetcher: Fetcher = async () => {
    setState({ ...getState(), quotaSnapshot });
    return tokenResponse();
  };

  await credentials.getCopilotToken(upstreamId, githubHost, githubToken, fetcher);
  expect(getState().copilotToken?.token).toBe('tok-test');
  expect(getState().quotaSnapshot).toEqual(quotaSnapshot);
});

test('does not replace the persisted token after the upstream configuration changes during exchange', async () => {
  const { credentials, advanceConfig, getState } = installRepo();
  const fetcher: Fetcher = async () => {
    advanceConfig();
    return tokenResponse();
  };
  await expect(credentials.getCopilotToken(upstreamId, githubHost, githubToken, fetcher)).resolves.toMatchObject({ token: 'tok-test' });
  expect(getState().copilotToken).toBeNull();
});
