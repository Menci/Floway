import { expect, test, vi } from 'vitest';

import { readUpstreamModelsSnapshotAndScheduleRefresh, MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { createProvider } from '../../../src/data-plane/providers/registry.ts';
import { modelsRefreshTarget, refreshModels } from '../../../src/execution/models-refresh.ts';
import { modelsCacheGeneration } from '../../../src/repo/models-cache-contract.ts';
import { seedModelsCache } from '../../repo/models-cache-fixture.ts';
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
  await seedModelsCache(repo.upstreams, record.id, modelsCacheGeneration(record), {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: Date.now(),
    models: [stubProviderModel({ id: 'cached' })],
  });
  const cached = await repo.upstreams.getById(record.id);
  if (cached === null) throw new Error('cached upstream missing');
  const scheduled = captureScheduled();

  const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(createProvider(cached), {
    scheduler: scheduled.scheduler,
    runtimeLocation: 'TEST',
  });

  expect(snapshot.models.map(model => model.id)).toEqual(['cached']);
  expect(scheduled.promises).toEqual([]);
});

test('a stale snapshot returns immediately and refreshes through the execution cell', async () => {
  const { repo, record } = await setupCustom();
  await seedModelsCache(repo.upstreams, record.id, modelsCacheGeneration(record), {
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
      const snapshot = readUpstreamModelsSnapshotAndScheduleRefresh(createProvider(stale), {
        scheduler: scheduled.scheduler,
        runtimeLocation: 'TEST',
      });
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
    const first = refreshModels(target, 'TEST', { bypassBackoff: true, includeDiscovered: false });
    const second = refreshModels(target, 'TEST', { bypassBackoff: true, includeDiscovered: false });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!(jsonResponse({ object: 'list', data: [{ id: 'shared' }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ kind: 'refreshed' }, { kind: 'refreshed' }]);
  });
});

test('background refreshes honor backoff and explicit refreshes bypass it', async () => {
  const { record } = await setupCustom();
  const fetch = vi.fn(() => new Response('unavailable', { status: 503 }));

  await withMockedFetch(fetch, async () => {
    const target = modelsRefreshTarget(record);
    await expect(refreshModels(target, 'TEST', { bypassBackoff: false, includeDiscovered: false }))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
    await expect(refreshModels(target, 'TEST', { bypassBackoff: false, includeDiscovered: false }))
      .resolves.toEqual({ kind: 'backoff' });
    await expect(refreshModels(target, 'TEST', { bypassBackoff: true, includeDiscovered: false }))
      .rejects.toBeInstanceOf(ProviderModelsUnavailableError);
  });

  expect(fetch).toHaveBeenCalledTimes(2);
});

test('a changed config fences an old execution target before fetching', async () => {
  const { repo, record } = await setupCustom();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    config: { ...record.config as Record<string, unknown>, apiKey: 'changed' },
  }));
  const fetch = vi.fn(() => jsonResponse({ object: 'list', data: [] }));

  await withMockedFetch(fetch, async () => {
    await expect(refreshModels(modelsRefreshTarget(record), 'TEST', { bypassBackoff: true, includeDiscovered: false }))
      .resolves.toEqual({ kind: 'generation-mismatch' });
  });
  expect(fetch).not.toHaveBeenCalled();
});

test('custom explicit refresh returns discovered dashboard models from the same fetch', async () => {
  const { record } = await setupCustom();
  await withMockedFetch(
    () => jsonResponse({ object: 'list', data: [{ id: 'discovered', display_name: 'Discovered' }] }),
    async () => {
      const result = await refreshModels(modelsRefreshTarget(record), 'TEST', { bypassBackoff: true, includeDiscovered: true });
      expect(result).toMatchObject({
        kind: 'refreshed',
        discovered: [{ upstreamModelId: 'discovered', publicModelId: 'discovered', display_name: 'Discovered' }],
      });
    },
  );
});
