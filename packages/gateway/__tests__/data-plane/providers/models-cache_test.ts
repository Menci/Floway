import { expect, test, vi } from 'vitest';

import { readUpstreamModelsSnapshotAndScheduleRefresh, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { InvalidProxyConfigurationError } from '../../../src/dial/per-request.ts';
import { createModelsRefreshScheduler, modelsRefreshTarget, refreshModels, refreshModelsExplicit } from '../../../src/execution/models-refresh.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { jsonResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

const setupCustom = async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord());
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
      expect.objectContaining({ kind: 'refreshed' }),
      expect.objectContaining({ kind: 'refreshed' }),
    ]);
  });
});

test('automatic and explicit callers across locations share one base cell', async () => {
  const { record } = await setupCustom();
  let release: ((response: Response) => void) | undefined;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    const automatic = refreshModels(target, 'SIN');
    const explicit = refreshModelsExplicit(target, 'NRT', true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(Promise.all([automatic, explicit])).resolves.toEqual([
      expect.objectContaining({ kind: 'refreshed', discovered: [expect.objectContaining({ upstreamModelId: 'shared' })] }),
      expect.objectContaining({ kind: 'refreshed', discovered: [expect.objectContaining({ upstreamModelId: 'shared' })] }),
    ]);
  });
});

test('explicit join still validates proxy configuration excluded from the automatic owner location', async () => {
  const { repo, record } = await setupCustom();
  await repo.upstreams.save({
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
    const explicit = refreshModelsExplicit(target, 'NRT', true);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(automatic).resolves.toMatchObject({ kind: 'refreshed', mode: 'automatic' });
    await expect(explicit).rejects.toBeInstanceOf(InvalidProxyConfigurationError);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('explicit caller retries after joining a failed automatic refresh', async () => {
  const { repo, record } = await setupCustom();
  let failAutomatic: ((response: Response) => void) | undefined;
  let stealingAutomatic: Promise<unknown> | undefined;
  let reads = 0;
  const getById = repo.upstreams.getById.bind(repo.upstreams);
  vi.spyOn(repo.upstreams, 'getById').mockImplementation(async id => {
    const current = await getById(id);
    reads += 1;
    if (reads === 2) stealingAutomatic = refreshModels(modelsRefreshTarget(record), 'HKG');
    return current;
  });
  const fetch = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>(resolve => { failAutomatic = resolve; }))
    .mockImplementationOnce(() => jsonResponse({ object: 'list', data: [{ id: 'retried' }] }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    const automatic = refreshModels(target, 'SIN');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const explicit = refreshModelsExplicit(target, 'NRT', true);
    failAutomatic!(new Response('unavailable', { status: 503 }));
    await expect(automatic).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    await expect(explicit).resolves.toMatchObject({ kind: 'refreshed', mode: 'explicit', discovered: [{ upstreamModelId: 'retried' }] });
    await stealingAutomatic;
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('background refreshes honor backoff and explicit refreshes bypass it', async () => {
  const { record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    await expect(refreshModels(target, 'TEST'))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    await expect(refreshModels(target, 'TEST'))
      .resolves.toEqual({ kind: 'backoff', mode: 'automatic' });
    await expect(refreshModelsExplicit(target, 'TEST', false))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a clean explicit failure makes one attempt and records one failure', async () => {
  const { repo, record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST', true))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(repo.upstreams.beginModelsRefresh({
    id: record.id,
    ...modelsRefreshIdentity(record),
    now: Date.now(),
    bypassBackoff: true,
  })).resolves.toEqual({ kind: 'ready', failureCount: 1 });
});

test('automatic proxy configuration failures are recorded and backed off', async () => {
  const { repo, record } = await setupCustom();
  await repo.upstreams.save({ ...record, proxyFallbackList: [{ id: 'missing' }] });
  const invalid = await repo.upstreams.getById(record.id);
  if (invalid === null) throw new Error('invalid-proxy upstream missing');
  const target = modelsRefreshTarget(invalid);

  await expect(refreshModels(target, 'TEST')).rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.lastError).not.toBeNull();
  await expect(refreshModels(target, 'TEST')).resolves.toEqual({ kind: 'backoff', mode: 'automatic' });
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

test('a changed config fences an old execution target before fetching', async () => {
  const { repo, record } = await setupCustom();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    config: { ...record.config as Record<string, unknown>, apiKey: 'changed' },
  }));
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModelsExplicit(modelsRefreshTarget(record), 'TEST', false))
      .resolves.toEqual({ kind: 'superseded', mode: 'explicit' });
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
    await expect(refreshModelsExplicit(staleTarget, 'TEST', true)).resolves.toMatchObject({
      kind: 'refreshed',
      mode: 'explicit',
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
      const result = await refreshModelsExplicit(modelsRefreshTarget(record), 'TEST', true);
      expect(result).toMatchObject({
        kind: 'refreshed',
        discovered: [{ upstreamModelId: 'discovered', publicModelId: 'discovered', display_name: 'Discovered' }],
      });
    },
  );
});

test('explicit discovery retries after an automatic refresh skips disabled fetching', async () => {
  const { repo, record } = await setupCustom();
  await repo.upstreams.save({
    ...record,
    config: { ...record.config as Record<string, unknown>, modelsFetch: { enabled: false } },
  });
  const disabled = await repo.upstreams.getById(record.id);
  if (disabled === null) throw new Error('disabled custom upstream missing');

  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'discovered' }] }),
    async () => {
      const result = await refreshModelsExplicit(modelsRefreshTarget(disabled), 'TEST', true);
      expect(result).toMatchObject({ kind: 'refreshed', discovered: [{ upstreamModelId: 'discovered' }] });
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
      async () => await refreshModels(modelsRefreshTarget(cached), 'TEST'),
    );
  } finally {
    now.mockRestore();
  }
  expect((await repo.upstreams.getById(record.id))?.modelsCache?.fetchedAt).toBe(1_001);
});
