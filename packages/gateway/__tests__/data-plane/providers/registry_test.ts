import { test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

test('listModelProviders creates enabled provider instances with upstream row ids', async () => {
  const { githubAccount, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom', sortOrder: 1 }));
  await repo.upstreams.save({
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 2,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
        },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    state: null,
  });
  await repo.upstreams.save(buildCopilotUpstreamRecord(githubAccount, { id: 'up_copilot', name: 'Copilot Row', sortOrder: 3 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 0 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(provider => provider.upstreamId), ['up_custom', 'up_azure', 'up_copilot']);
});

test('listModelProviders without a filter returns global sort_order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(p => p.upstreamId), ['up_a', 'up_b', 'up_c']);
});

test('listModelProviders honors a per-key whitelist with custom order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(['up_c', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_c', 'up_a']);
});

test('listModelProviders silently drops disabled upstreams from a whitelist', async () => {
  // A per-user cap legitimately references an upstream the operator just
  // disabled; the cap survives that transition without surfacing an error.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20, enabled: false }));

  const providers = await listModelProviders(['up_b', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_a']);
});

test('listModelProviders silently drops deleted upstreams from a whitelist', async () => {
  // Deleting an upstream does not prune the caps that reference it, so a
  // dangling id narrows the cap instead of failing the principal's requests.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));

  const providers = await listModelProviders(['up_ghost', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_a']);
});

test('listModelProviders carries each row cached catalog onto its instance', async () => {
  // The SWR layer reads the catalog off the instance instead of paying a
  // second round trip, so the row read has to bring it along.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_cached', name: 'Cached', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_cold', name: 'Cold', sortOrder: 20 }));
  await repo.upstreams.saveModelsCache('up_cached', {
    revision: MODEL_CATALOG_REVISION,
    fetchedAt: 1_700_000_000_000,
    models: [stubProviderModel({ id: 'cached-model' })],
  });

  const providers = await listModelProviders(null);
  const byId = Object.fromEntries(providers.map(provider => [provider.upstreamId, provider]));
  assertEquals(byId.up_cached.modelsCache?.revision, MODEL_CATALOG_REVISION);
  assertEquals(byId.up_cached.modelsCache?.models.map(model => model.id), ['cached-model']);
  assertEquals(byId.up_cold.modelsCache, null);
});
