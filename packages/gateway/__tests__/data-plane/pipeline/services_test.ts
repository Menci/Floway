import { expect, test, vi } from 'vitest';

import { createGatewayServices } from '../../../src/data-plane/pipeline/services.ts';
import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { modelsRefreshInputs } from '../../../src/repo/models-refresh-inputs.ts';
import { generateServerSecret } from '../../../src/shared/server-secret.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

test.each(['catalog', 'fetcher'] as const)('uses the same upstream snapshot when an edit follows the %s lookup', async firstLookup => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const createdAt = new Date().toISOString();
  const original = {
    id: 'old-upstream',
    kind: 'custom' as const,
    name: 'Old upstream',
    createdAt,
    updatedAt: createdAt,
    config: { baseUrl: 'https://old.example.test', endpoints: { openaiEmbeddings: {} } },
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    state: null,
    sortOrder: 1,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [{ id: 'direct_fetch' }],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  };
  const inserted = await repo.upstreams.insertForModels(original);
  if (inserted === null) throw new Error('Could not insert upstream fixture');
  expect(await repo.upstreams.publishModelsRefresh({
    id: original.id,
    configVersion: inserted.configVersion,
    cacheEpoch: 0,
    refreshInputs: modelsRefreshInputs(inserted),
    cache: {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: Date.now(),
      models: [stubProviderModel({ id: 'vectors', kind: 'embedding', endpoints: { openaiEmbeddings: {} } })],
    },
  })).toBe(true);

  const lookup = vi.spyOn(repo.upstreams, 'list');
  const services = await createGatewayServices('TEST', { id: 'key', serverSecret: generateServerSecret(), openaiResponsesRetentionSeconds: 0 });
  const catalog = async () => {
    const result = await services.catalogCandidates({
      subject: { id: 1, isAdmin: true },
      upstreamIds: null,
      randomizeUpstreams: false,
      model: 'vectors',
      kind: 'embedding',
      runtimeLocation: 'TEST',
      scheduler() {},
    });
    expect(result.candidates.map(item => item.provider.upstreamId)).toEqual([original.id]);
  };
  const fetcher = async () => {
    const fetch = vi.fn(async () => Response.json({ from: 'old-upstream' }));
    await withMockedFetch(fetch, async () => {
      const { response } = await services.fetcher(original.id)('https://old.example.test/embeddings', { method: 'GET' });
      expect(await response.json()).toEqual({ from: 'old-upstream' });
    });
    expect(fetch).toHaveBeenCalledOnce();
  };
  await (firstLookup === 'catalog' ? catalog() : fetcher());
  await repo.upstreams.deleteAll();
  await repo.upstreams.insertForModels({ ...original, id: 'new-upstream', name: 'New upstream' });
  await (firstLookup === 'catalog' ? fetcher() : catalog());
  expect(lookup).toHaveBeenCalledOnce();
});
