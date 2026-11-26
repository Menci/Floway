import { expect, test, vi } from 'vitest';

import type { StoredUpstreamRecord } from '../../../src/repo/types.ts';
import { refreshModels, refreshModelsExplicit } from '../../../src/upstreams/models-refresh.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildChatGPTUpstreamRecord, buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const targetFor = (record: StoredUpstreamRecord) => ({ upstreamId: record.id, version: record.version });

const setupCustom = async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord());
  const record = await repo.upstreams.getById('up_custom');
  if (record === null) throw new Error('custom upstream missing');
  return { repo, record };
};

test('a config edit during discovery returns its models without publishing the old catalog', async () => {
  const { repo, record } = await setupCustom();
  let release: ((response: Response) => void) | undefined;
  await withMockedFetch(
    () => new Promise<Response>(resolve => { release = resolve; }),
    async () => {
      const pending = refreshModelsExplicit(targetFor(record), 'TEST');
      await vi.waitFor(() => expect(release).toBeDefined());
      const current = await repo.upstreams.getById(record.id);
      if (current === null) throw new Error('upstream disappeared');
      await repo.upstreams.replace({
        previous: current,
        upstream: { ...current, config: { ...current.config as Record<string, unknown>, baseUrl: 'https://next.example.com' } },
      });
      release!(jsonResponse({ object: 'list', data: [{ id: 'old-model' }] }));
      await expect(pending).resolves.toMatchObject({ kind: 'discovered', publication: 'lost-race', entries: [{ source: 'auto', model: expect.objectContaining({ upstreamModelId: 'old-model' }) }] });
    },
  );
  expect((await repo.upstreams.getById(record.id))?.modelsCache).toEqual({ revision: null, fetchedAt: null, lastError: null });
  expect(await repo.upstreamModels.listByUpstream(record.id)).toEqual([]);
});

test('background refreshes honor backoff and explicit refreshes bypass it', async () => {
  const { record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    const target = targetFor(record);
    await expect(refreshModels(target, 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    await expect(refreshModels(target, 'TEST'))
      .resolves.toEqual({ kind: 'backoff' });
    await expect(refreshModelsExplicit(target, 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(2);
});

test.each([
  { name: 'JSON-escaped', apiKey: 'a"b' },
  { name: 'long', apiKey: 'x'.repeat(15_300) },
])('a model-list error redacts the echoed $name credential', async ({ apiKey }) => {
  const { repo, record } = await setupCustom();
  const configured = await repo.upstreams.replace({
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
        await refreshModelsExplicit(targetFor(configured), 'TEST');
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
  const message = (await repo.upstreams.getById(record.id))?.modelsCache.lastError?.message;
  expect(message).toContain('rejected [REDACTED]');
  expect(message).not.toContain(apiKey);
  expect(message).not.toContain(JSON.stringify(apiKey).slice(1, -1));
  if (apiKey.length > 100) expect(message).not.toContain(apiKey.slice(0, 100));
});

test('model discovery redacts an endpoint query credential', async () => {
  const parameter = 'X-Amz-Signature';
  const { repo, record } = await setupCustom();
  const config = { ...record.config as Record<string, unknown> };
  delete config.apiKey;
  const configured = await repo.upstreams.replace({
    previous: record,
    upstream: { ...record, config: { ...config, apiKey: '', modelsFetch: { enabled: true, authStyle: 'bearer', endpoint: `/v1/models?limit=1&monkey=banana&${parameter}=query-secret-42` } } },
  });
  if (configured === null) throw new Error('query-auth update failed');
  await withMockedFetch(
    request => {
      const query = new URL(request.url).searchParams;
      return new Response(JSON.stringify({ error: `HTTP 401 rejected ${query.get('monkey')} ${query.get(parameter)}` }), { status: 401 });
    },
    async () => {
      await expect(refreshModelsExplicit(targetFor(configured), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache.lastError?.message;
  expect(message).toContain('HTTP 401 rejected banana [REDACTED]');
  expect(message).not.toContain('query-secret-42');
});

test('model discovery redacts userinfo from a URL construction failure', async () => {
  const { repo, record } = await setupCustom();
  const configured = await repo.upstreams.replace({
    previous: record,
    upstream: { ...record, config: { ...record.config as Record<string, unknown>, baseUrl: 'https://user:secret@custom.example.com' } },
  });
  if (configured === null) throw new Error('userinfo update failed');
  await withMockedFetch(
    () => new Response('upstream unavailable', { status: 401 }),
    async () => {
      await expect(refreshModelsExplicit(targetFor(configured), 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache.lastError?.message;
  expect(message).not.toContain('secret');
  expect(message).not.toContain('user:secret');
});

test('ChatGPT OAuth failure redacts a form-encoded refresh token echo', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const chatgpt = buildChatGPTUpstreamRecord();
  const state = chatgpt.state as { accounts: Array<Record<string, unknown>> };
  await saveUpstreamForTest(repo.upstreams, {
    ...chatgpt,
    state: { accounts: state.accounts.map(account => ({ ...account, refresh_token: 'rt with spaces', accessToken: null })) },
  });
  const record = await repo.upstreams.getById(chatgpt.id);
  if (record === null) throw new Error('ChatGPT upstream missing');
  await withMockedFetch(
    async request => new Response(`denied ${await request.text()}`, { status: 503 }),
    async () => {
      await expect(refreshModelsExplicit(targetFor(record), 'TEST')).rejects.toThrow('refresh_token=[REDACTED]');
    },
  );
  const message = (await repo.upstreams.getById(record.id))?.modelsCache.lastError?.message;
  expect(message).toContain('refresh_token=[REDACTED]');
  expect(message).not.toContain('rt+with+spaces');
});

test('failure persistence retains the upstream error when recording also fails', async () => {
  const { repo, record } = await setupCustom();
  vi.spyOn(repo.upstreams, 'recordModelsRefreshFailure').mockRejectedValue(new Error('storage unavailable'));

  await withMockedFetch(
    () => new Response('unavailable', { status: 503 }),
    async () => {
      try {
        await refreshModels(targetFor(record), 'TEST');
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
      await expect(refreshModelsExplicit(targetFor(record), 'TEST')).rejects.toBe(storageError);
    },
  );
  expect(recordFailure).not.toHaveBeenCalled();
  expect((await repo.upstreams.getById(record.id))?.modelsCache).toEqual({ revision: null, fetchedAt: null, lastError: null });
});

test('a changed config fences an old execution target before fetching', async () => {
  const { repo, record } = await setupCustom();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    config: { ...record.config as Record<string, unknown>, apiKey: 'changed' },
  }));
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(targetFor(record), 'TEST'))
      .resolves.toEqual({ kind: 'superseded' });
  });
  expect(fetch).not.toHaveBeenCalled();
});
