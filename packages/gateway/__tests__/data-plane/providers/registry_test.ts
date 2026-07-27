import { expect, test } from 'vitest';

import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals } from '@floway-dev/test-utils';

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
    color: null,
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

test('listModelProviders throws on unknown upstream ids in the whitelist', async () => {
  // Unknown ids are a caller-side configuration error, not a runtime state;
  // surface them instead of silently serving a smaller subset.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));

  await expect(listModelProviders(['up_ghost', 'up_a'])).rejects.toThrow(/up_ghost/);
});
