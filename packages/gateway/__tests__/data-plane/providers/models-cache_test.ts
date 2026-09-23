import { expect, test, vi } from 'vitest';

import { readUpstreamModelsSnapshotAndScheduleRefresh, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { InvalidProxyConfigurationError } from '../../../src/dial/per-request.ts';
import { createModelsRefreshScheduler, discoverDraftModels, modelsRefreshTarget, refreshModels, refreshModelsExplicit } from '../../../src/execution/models-refresh.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCodexUpstreamRecord, buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { jsonResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const setupCustom = async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  const record = await repo.upstreams.getById('up_custom');
  if (record === null) throw new Error('custom upstream missing');
  return { repo, record };
};

const captureScheduled = () => {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    scheduler: (promise: Promise<unknown>): void => { promises.push(promise); },
  };
};

test('a fresh snapshot returns without scheduling work', async () => {
  const { repo, record } = await setupCustom();
  await seedModelsCache(repo.upstreams, record.id, modelsRefreshIdentity(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({ id: 'cached' })],
  });
  const cached = await repo.upstreams.getById(record.id);
  if (cached === null) throw new Error('cached upstream missing');
  const scheduled = captureScheduled();

  const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(
    createProvider(cached),
    createModelsRefreshScheduler('TEST', scheduled.scheduler),
  );

  expect(snapshot.models.map(model => model.id)).toEqual(['cached']);
  expect(scheduled.promises).toEqual([]);
});

test('a stale snapshot returns immediately and refreshes through the execution cell', async () => {
  const { repo, record } = await setupCustom();
  await seedModelsCache(repo.upstreams, record.id, modelsRefreshIdentity(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now() - 11 * 60_000,
    models: [stubProviderModel({ id: 'stale' })],
  });
  const stale = await repo.upstreams.getById(record.id);
  if (stale === null) throw new Error('stale upstream missing');
  const scheduled = captureScheduled();

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'fresh' }] }),
    async () => {
      const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(
        createProvider(stale),
        createModelsRefreshScheduler('TEST', scheduled.scheduler),
      );
      expect(snapshot.models.map(model => model.id)).toEqual(['stale']);
      await Promise.all(scheduled.promises);
    },
  );

  expect((await repo.upstreams.getById(record.id))?.modelsCache?.models.map(model => model.id)).toEqual(['fresh']);
});

test('concurrent callers share one upstream fetch', async () => {
  const { record } = await setupCustom();
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    const first = refreshModels(target, 'TEST');
    const second = refreshModels(target, 'TEST');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'discovered', publication: 'published' }),
      expect.objectContaining({ kind: 'discovered', publication: 'published' }),
    ]);
  });
});

test('draft discovery uses its supplied record without reading or writing an upstream row', async () => {
  const { repo, record } = await setupCustom();
  const read = vi.spyOn(repo.upstreams, 'getById');
  const publish = vi.spyOn(repo.upstreams, 'publishModelsRefresh');
  const draft = { ...record, config: { ...record.config as Record<string, unknown>, baseUrl: 'https://draft.example.com' } };

  await withMockedFetch(
    request => {
      expect(new URL(request.url).hostname).toBe('draft.example.com');
      return jsonResponse({ object: 'list', data: [{ id: 'draft-model' }] });
    },
    async () => {
      const result = await discoverDraftModels(draft, 'TEST');
      expect(result).toMatchObject({ kind: 'discovered', publication: 'draft', discovered: [{ upstreamModelId: 'draft-model' }] });
      if (result.kind !== 'discovered') throw new Error('draft did not discover models');
      expect(result.models[0]?.enabledFlags).toBeInstanceOf(Set);
    },
  );
  expect(read).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
});

test('a config edit during discovery returns its models without publishing the old catalog', async () => {
  const { repo, record } = await setupCustom();
  let release: ((response: Response) => void) | undefined;
  await withMockedFetch(
    () => new Promise<Response>(resolve => { release = resolve; }),
    async () => {
      const pending = refreshModelsExplicit(modelsRefreshTarget(record), 'TEST');
      await vi.waitFor(() => expect(release).toBeDefined());
      const current = await repo.upstreams.getById(record.id);
      if (current === null) throw new Error('upstream disappeared');
      await repo.upstreams.replaceForModels({ previous: current, upstream: { ...current, config: { ...current.config as Record<string, unknown>, baseUrl: 'https://next.example.com' } } });
      release!(jsonResponse({ object: 'list', data: [{ id: 'old-model' }] }));
      await expect(pending).resolves.toMatchObject({ kind: 'discovered', publication: 'lost-race', discovered: [{ upstreamModelId: 'old-model' }] });
    },
  );
  expect((await repo.upstreams.getById(record.id))?.modelsCache).toBeNull();
});

test('a replacement row gets a separate cell and discards its predecessor’s models', async () => {
  const { repo, record } = await setupCustom();
  const releases = new Map<string, (response: Response) => void>();

  await withMockedFetch(
    request => new Promise<Response>(resolve => { releases.set(new URL(request.url).hostname, resolve); }),
    async () => {
      const old = refreshModelsExplicit(modelsRefreshTarget(record), 'TEST');
      await vi.waitFor(() => expect(releases.size).toBe(1));
      await repo.upstreams.delete(record.id);
      const replacement = await repo.upstreams.insertForModels({
        ...record,
        config: { ...record.config as Record<string, unknown>, baseUrl: 'https://replacement.example.com' },
      });
      if (replacement === null) throw new Error('replacement insert failed');
      const current = refreshModelsExplicit(modelsRefreshTarget(replacement), 'TEST');
      await vi.waitFor(() => expect(releases.size).toBe(2));
      releases.get('replacement.example.com')!(jsonResponse({ object: 'list', data: [{ id: 'new-model' }] }));
      await expect(current).resolves.toMatchObject({ kind: 'discovered', publication: 'published' });
      for (const [hostname, release] of releases) {
        if (hostname !== 'replacement.example.com') release(jsonResponse({ object: 'list', data: [{ id: 'old-model' }] }));
      }
      await expect(old).resolves.toMatchObject({ kind: 'discovered', publication: 'lost-race' });
    },
  );
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.models.map(model => model.id)).toEqual(['new-model']);
});

test('automatic and explicit callers across locations have separate cells and both return models', async () => {
  const { record } = await setupCustom();
  const releases: Array<(response: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => { releases.push(resolve); }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    const automatic = refreshModels(target, 'SIN');
    const explicit = refreshModelsExplicit(target, 'NRT');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    for (const release of releases) release(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(Promise.all([automatic, explicit])).resolves.toEqual([
      expect.objectContaining({ kind: 'discovered', discovered: [expect.objectContaining({ upstreamModelId: 'shared' })] }),
      expect.objectContaining({ kind: 'discovered', discovered: [expect.objectContaining({ upstreamModelId: 'shared' })] }),
    ]);
  });
});

test('explicit fetch validates proxy configuration excluded from the automatic location', async () => {
  const { repo, record } = await setupCustom();
  await saveUpstreamForTest(repo.upstreams, {
    ...record,
    proxyFallbackList: [{ id: 'missing', colos: ['NRT'] }, { id: 'direct_fetch' }],
  });
  const configured = await repo.upstreams.getById(record.id);
  if (configured === null) throw new Error('configured custom upstream missing');
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(configured);
    const automatic = refreshModels(target, 'SIN');
    const explicit = expect(refreshModelsExplicit(target, 'NRT')).rejects.toBeInstanceOf(InvalidProxyConfigurationError);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(automatic).resolves.toMatchObject({ kind: 'discovered' });
    await explicit;
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('background refreshes honor backoff and explicit refreshes bypass it', async () => {
  const { record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    await expect(refreshModels(target, 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    await expect(refreshModels(target, 'TEST'))
      .resolves.toEqual({ kind: 'backoff' });
    await expect(refreshModelsExplicit(target, 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(2);
});

test('automatic execution skips a cache refreshed after its target was scheduled', async () => {
  const { repo, record } = await setupCustom();
  const target = modelsRefreshTarget(record);
  await seedModelsCache(repo.upstreams, record.id, modelsRefreshIdentity(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({ id: 'fresh' })],
  });
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [{ id: 'explicit' }] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModels(target, 'TEST')).resolves.toEqual({ kind: 'not-due' });
    await expect(refreshModelsExplicit(target, 'TEST')).resolves.toMatchObject({ kind: 'discovered', publication: 'published' });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a clean explicit failure makes one attempt and records one failure', async () => {
  const { repo, record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(1);
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.failureCount).toBe(1);
});

test.each([
  { name: 'plain', apiKey: 'sk-custom' },
  { name: 'JSON-escaped', apiKey: 'a"b' },
  { name: 'spaced', apiKey: 'key with spaces' },
  { name: 'long', apiKey: 'x'.repeat(15_300) },
])('a model-list error redacts the echoed $name credential', async ({ apiKey }) => {
  const { repo, record } = await setupCustom();
  const configured = await repo.upstreams.replaceForModels({
    previous: record,
    upstream: { ...record, config: { ...record.config as Record<string, unknown>, apiKey } },
  });
  if (configured === null) throw new Error('credential update failed');
  await withMockedFetch(
    request => {
      const authorization = request.headers.get('authorization');
      const headers = new Headers({ 'content-type': 'application/json' });
      if (apiKey.length < 100) headers.set('x-error', authorization!);
      return new Response(JSON.stringify({ error: `rejected ${authorization}` }), {
        status: 401,
        headers,
      });
    },
    async () => {
      try {
        await refreshModelsExplicit(modelsRefreshTarget(configured), 'TEST');
        throw new Error('refresh unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderModelsUnavailableError);
        const response = (error as ProviderModelsUnavailableError).displayResponse;
        expect(JSON.stringify(response)).toContain('rejected [REDACTED]');
        expect(JSON.stringify(response)).not.toContain(apiKey);
        expect(JSON.stringify(response)).not.toContain(JSON.stringify(apiKey).slice(1, -1));
        if (apiKey.length > 100) expect(JSON.stringify(response)).not.toContain(apiKey.slice(0, 100));
      }
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('rejected [REDACTED]');
  expect(message).not.toContain(apiKey);
  expect(message).not.toContain(JSON.stringify(apiKey).slice(1, -1));
  if (apiKey.length > 100) expect(message).not.toContain(apiKey.slice(0, 100));
});

test('Copilot token exchange cannot echo the GitHub PAT into the model error', async () => {
  const { repo, copilotUpstream, githubAccount } = await setupAppTest();
  const record = await repo.upstreams.getById(copilotUpstream.id);
  if (record === null) throw new Error('Copilot upstream missing');
  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        expect(request.headers.get('authorization')).toBe(`token ${githubAccount.token}`);
        return new Response(JSON.stringify({ error: `rejected ${githubAccount.token}` }), { status: 401 });
      }
      throw new Error(`Unexpected request ${request.url}`);
    },
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('rejected [REDACTED]');
  expect(message).not.toContain(githubAccount.token);
});

test('a model error cannot echo an API key as a JSON field name', async () => {
  const { repo, record } = await setupCustom();
  await withMockedFetch(
    () => jsonResponse({ 'sk-custom': 'rejected' }, 401),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('[REDACTED]');
  expect(message).not.toContain('sk-custom');
});

test.each(['api_key', 'api_token', 'password', 'client_secret', 'api_secret', 'sig', 'signature', 'X-Amz-Signature'])('model discovery redacts a %s endpoint query credential', async parameter => {
  const { repo, record } = await setupCustom();
  const config = { ...record.config as Record<string, unknown> };
  delete config.apiKey;
  const configured = await repo.upstreams.replaceForModels({
    previous: record,
    upstream: { ...record, config: { ...config, authStyle: 'none', modelsFetch: { enabled: true, endpoint: `/v1/models?limit=1&monkey=banana&${parameter}=query-secret-42` } } },
  });
  if (configured === null) throw new Error('query-auth update failed');
  await withMockedFetch(
    request => {
      const query = new URL(request.url).searchParams;
      return new Response(JSON.stringify({ error: `HTTP 401 rejected ${query.get('monkey')} ${query.get(parameter)}` }), { status: 401 });
    },
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(configured), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('HTTP 401 rejected banana [REDACTED]');
  expect(message).not.toContain('query-secret-42');
});

test('model discovery redacts the sent spelling of a percent-encoded query credential', async () => {
  const { repo, record } = await setupCustom();
  const config = { ...record.config as Record<string, unknown> };
  delete config.apiKey;
  const configured = await repo.upstreams.replaceForModels({
    previous: record,
    upstream: { ...record, config: { ...config, authStyle: 'none', modelsFetch: { enabled: true, endpoint: '/v1/models?api_key=query%2fsecret' } } },
  });
  if (configured === null) throw new Error('encoded query-auth update failed');
  await withMockedFetch(
    request => new Response(`rejected ${request.url}`, { status: 401 }),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(configured), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('rejected https://custom.example.com/v1/models?api_key=[REDACTED]');
  expect(message).not.toContain('query%2fsecret');
});

test('model discovery redacts userinfo from a URL construction failure', async () => {
  const { repo, record } = await setupCustom();
  const configured = await repo.upstreams.replaceForModels({
    previous: record,
    upstream: { ...record, config: { ...record.config as Record<string, unknown>, baseUrl: 'https://user:secret@custom.example.com' } },
  });
  if (configured === null) throw new Error('userinfo update failed');
  await withMockedFetch(
    () => new Response('upstream unavailable', { status: 401 }),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(configured), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).not.toContain('secret');
  expect(message).not.toContain('user:secret');
});

test('Codex OAuth failure cannot echo a refresh token into the model error', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const codex = buildCodexUpstreamRecord();
  const state = codex.state as { accounts: Array<Record<string, unknown>> };
  await saveUpstreamForTest(repo.upstreams, {
    ...codex,
    state: { accounts: state.accounts.map(account => ({ ...account, accessToken: null })) },
  });
  const record = await repo.upstreams.getById(codex.id);
  if (record === null) throw new Error('Codex upstream missing');
  await withMockedFetch(
    async request => {
      expect(new URL(request.url).pathname).toBe('/oauth/token');
      const refreshToken = new URLSearchParams(await request.text()).get('refresh_token');
      expect(refreshToken).toBe('rt_v1');
      return jsonResponse({ error: { code: 'app_session_terminated', message: `expired ${refreshToken}` } }, 401);
    },
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toThrow('expired [REDACTED]');
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('expired [REDACTED]');
  expect(message).not.toContain('rt_v1');
});

test('Codex OAuth failure redacts a form-encoded refresh token echo', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const codex = buildCodexUpstreamRecord();
  const state = codex.state as { accounts: Array<Record<string, unknown>> };
  await saveUpstreamForTest(repo.upstreams, {
    ...codex,
    state: { accounts: state.accounts.map(account => ({ ...account, refresh_token: 'rt with spaces', accessToken: null })) },
  });
  const record = await repo.upstreams.getById(codex.id);
  if (record === null) throw new Error('Codex upstream missing');
  await withMockedFetch(
    async request => new Response(`denied ${await request.text()}`, { status: 503 }),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toThrow('refresh_token=[REDACTED]');
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('refresh_token=[REDACTED]');
  expect(message).not.toContain('rt+with+spaces');
});

test('Claude Code OAuth failure cannot echo a refresh token into the model error', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const record = buildCustomUpstreamRecord({
    id: 'up_claude',
    kind: 'claude-code',
    config: { accounts: [{ email: 'a@b.com', accountUuid: 'acc-1', organizationUuid: null, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }] },
    state: {
      accounts: [{
        accountUuid: 'acc-1', tokenKind: 'oauth', refreshToken: 'claude-refresh-token', state: 'active',
        stateUpdatedAt: '2026-01-01T00:00:00Z', accessToken: null, quotaSnapshot: null, usageProbeSnapshot: null,
      }],
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);
  const stored = await repo.upstreams.getById(record.id);
  if (stored === null) throw new Error('Claude Code upstream missing');
  await withMockedFetch(
    async request => {
      const refreshToken = (await request.json() as { refresh_token: string }).refresh_token;
      expect(refreshToken).toBe('claude-refresh-token');
      return jsonResponse({ error: 'invalid_grant', error_description: `revoked ${refreshToken}` }, 401);
    },
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(stored), 'TEST')).rejects.toThrow('revoked [REDACTED]');
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('revoked [REDACTED]');
  expect(message).not.toContain('claude-refresh-token');
});

test('a malformed Codex catalog cannot echo its bearer token in a parser error', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCodexUpstreamRecord());
  const record = await repo.upstreams.getById('up_codex');
  if (record === null) throw new Error('Codex upstream missing');
  await withMockedFetch(
    () => jsonResponse({ models: [{ slug: 'codex-access-token' }] }),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toThrow('model entry [REDACTED] missing display_name');
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache?.lastError?.message;
  expect(message).toContain('[REDACTED]');
  expect(message).not.toContain('codex-access-token');
});

test('automatic proxy configuration failures are recorded and backed off', async () => {
  const { repo, record } = await setupCustom();
  await saveUpstreamForTest(repo.upstreams, { ...record, proxyFallbackList: [{ id: 'missing' }] });
  const invalid = await repo.upstreams.getById(record.id);
  if (invalid === null) throw new Error('invalid-proxy upstream missing');
  const target = modelsRefreshTarget(invalid);

  await expect(refreshModels(target, 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.lastError).not.toBeNull();
  await expect(refreshModels(target, 'TEST')).resolves.toEqual({ kind: 'backoff' });
});

test('failure persistence retains the upstream error when recording also fails', async () => {
  const { repo, record } = await setupCustom();
  vi.spyOn(repo.upstreams, 'recordModelsRefreshFailure').mockRejectedValue(new Error('storage unavailable'));

  await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    async () => {
      try {
        await refreshModels(modelsRefreshTarget(record), 'TEST');
        throw new Error('refresh unexpectedly succeeded');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([
          expect.any(ProviderModelsUnavailableError),
          expect.objectContaining({ message: 'storage unavailable' }),
        ]);
      }
    },
  );
});

test('publication failure is not recorded as an upstream failure', async () => {
  const { repo, record } = await setupCustom();
  const storageError = new Error('publication unavailable');
  vi.spyOn(repo.upstreams, 'publishModelsRefresh').mockRejectedValue(storageError);
  const recordFailure = vi.spyOn(repo.upstreams, 'recordModelsRefreshFailure');

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'discovered' }] }),
    async () => {
      await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST')).rejects.toBe(storageError);
    },
  );
  expect(recordFailure).not.toHaveBeenCalled();
  expect((await repo.upstreams.getById(record.id))?.modelsCache).toBeNull();
});

test('a changed config fences an old execution target before fetching', async () => {
  const { repo, record } = await setupCustom();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: { ...record.config as Record<string, unknown>, apiKey: 'changed' },
  }));
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST'))
      .resolves.toEqual({ kind: 'superseded' });
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('explicit refresh follows a newer cache epoch under the same config', async () => {
  const { repo, record } = await setupCustom();
  const staleTarget = modelsRefreshTarget(record);
  await seedModelsCache(repo.upstreams, record.id, modelsRefreshIdentity(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_000,
    models: [],
  });
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [{ id: 'current' }] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(staleTarget, 'TEST')).resolves.toMatchObject({
      kind: 'discovered',
      discovered: [{ upstreamModelId: 'current' }],
    });
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('custom explicit refresh returns discovered dashboard models from the same fetch', async () => {
  const { record } = await setupCustom();
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'discovered', display_name: 'Discovered' }] }),
    async () => {
      const result = await refreshModelsExplicit(modelsRefreshTarget(record), 'TEST');
      expect(result).toMatchObject({
        kind: 'discovered',
        discovered: [{ upstreamModelId: 'discovered', publicModelId: 'discovered', display_name: 'Discovered' }],
      });
    },
  );
});

test('explicit discovery fetches even when automatic custom fetch is disabled', async () => {
  const { repo, record } = await setupCustom();
  await saveUpstreamForTest(repo.upstreams, {
    ...record,
    config: { ...record.config as Record<string, unknown>, modelsFetch: { enabled: false } },
  });
  const disabled = await repo.upstreams.getById(record.id);
  if (disabled === null) throw new Error('disabled custom upstream missing');

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'discovered' }] }),
    async () => {
      const result = await refreshModelsExplicit(modelsRefreshTarget(disabled), 'TEST');
      expect(result).toMatchObject({ kind: 'discovered', discovered: [{ upstreamModelId: 'discovered' }] });
    },
  );
});

test('successful refresh advances the cache epoch monotonically', async () => {
  const { repo, record } = await setupCustom();
  await seedModelsCache(repo.upstreams, record.id, modelsRefreshIdentity(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_000,
    models: [],
  });
  const cached = await repo.upstreams.getById(record.id);
  if (cached === null) throw new Error('cached custom upstream missing');
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  try {
    await withMockedFetch(
      () => jsonResponse({ object: 'list', data: [{ id: 'fresh' }] }),
      async () => await refreshModelsExplicit(modelsRefreshTarget(cached), 'TEST'),
    );
  } finally {
    now.mockRestore();
  }
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.fetchedAt).toBe(1_001);
});
