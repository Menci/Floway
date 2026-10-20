import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals } from '@floway-dev/test-utils';

const listingModel = (upstream: ReturnType<typeof buildCustomUpstreamRecord>) => {
  const stored = upstream;
  return {
    ...stored,
    config: {
      ...stored.config as object,
      models: [{
        upstreamModelId: `model-${upstream.id}`,
        limits: { max_context_window_tokens: upstream.id === 'a' ? 100_000 : 200_000 },
        endpoints: upstream.id === 'a' ? { openaiChatCompletions: {} } : { anthropicMessages: {} },
      }],
    },
  };
};

test('restricted data-plane aliases keep gateway-wide metadata and caller-scoped targets', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await repo.upstreams.deleteAll();
  for (const [id, host, sortOrder] of [['a', 'a.example.com', 0], ['b', 'b.example.com', 1]] as const) {
    const upstream = buildCustomUpstreamRecord({
      id,
      name: id,
      sortOrder,
      config: {
        baseUrl: `https://${host}`,
        authStyle: 'bearer',
        apiKey: 'sk',
        ingressHeadersRules: [],
        endpoints: id === 'a' ? { openaiChatCompletions: {} } : { anthropicMessages: {} },
      },
    });
    const stored = listingModel(upstream);
    await saveUpstreamForTest(repo.upstreams, stored);
    const persisted = await repo.upstreams.getById(id);
    if (persisted === null) throw new Error(`Missing upstream ${id}`);
    await seedModelsCache(repo.upstreams, id, modelsRefreshIdentity(persisted), {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: 1,
      models: projectCustomModels(persisted),
    });
  }
  await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
  await repo.accessRecords.save({
    principal: { kind: 'user', id: apiKey.userId },
    scope: { kind: 'upstream', upstreamId: 'a' },
    sortOrder: 0,
    values: { 'Model.Use': true },
  });
  await repo.modelAliases.insert({
    id: 'alias',
    name: 'mix',
    kind: 'chat',
    selection: 'first-available',
    displayName: null,
    visibleInModelsList: true,
    targets: [{ target_model_id: 'model-a', rules: {} }, { target_model_id: 'model-b', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await repo.apiKeys.save({
    id: 'admin-key',
    userId: 1,
    name: 'Admin',
    key: 'raw-admin-key',
    serverSecret: '00'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
    randomizeUpstreams: false,
  });
  await repo.apiKeys.save({
    id: 'admin-restricted-key',
    userId: 1,
    name: 'Restricted admin',
    key: 'raw-admin-restricted-key',
    serverSecret: '01'.repeat(32),
    createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: ['b'],
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
    randomizeUpstreams: false,
  });

  const aliasFor = async (key: string) => {
    const response = await requestApp('/v1/models', { headers: { 'x-api-key': key } });
    assertEquals(response.status, 200);
    const body = await response.json() as { data: Array<{ id: string; limits: { max_context_window_tokens?: number }; endpoints: object; aliasedFrom?: { targets: unknown[] } }> };
    return body.data.find(model => model.id === 'mix')!;
  };
  const restricted = await aliasFor(apiKey.key);
  const admin = await aliasFor('raw-admin-key');
  const restrictedAdmin = await aliasFor('raw-admin-restricted-key');

  expect(restricted.limits).toEqual(admin.limits);
  expect(restricted.endpoints).toEqual(admin.endpoints);
  expect(restrictedAdmin.limits).toEqual(admin.limits);
  expect(restrictedAdmin.endpoints).toEqual(admin.endpoints);
  expect(restricted.aliasedFrom?.targets).toHaveLength(1);
  expect(admin.aliasedFrom?.targets).toHaveLength(2);
  expect(restrictedAdmin.aliasedFrom?.targets).toHaveLength(1);
});

test('Gemini aliases use the same gateway-wide metadata and caller-scoped targets', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.modelAliases.deleteAll();
  await repo.upstreams.deleteAll();
  const upstream = listingModel(buildCustomUpstreamRecord({
    id: 'a',
    config: {
      baseUrl: 'https://a.example.com', authStyle: 'bearer', apiKey: 'sk', ingressHeadersRules: [],
      endpoints: { openaiChatCompletions: {} },
    },
  }));
  await saveUpstreamForTest(repo.upstreams, upstream);
  const persisted = await repo.upstreams.getById('a');
  if (persisted === null) throw new Error('Missing upstream');
  await seedModelsCache(repo.upstreams, 'a', modelsRefreshIdentity(persisted), {
    revision: MODEL_CATALOG_REVISION, fetchedAt: 1, models: projectCustomModels(persisted),
  });
  await repo.modelAliases.insert({
    id: 'alias', name: 'mix', kind: 'chat', selection: 'first-available', displayName: null,
    visibleInModelsList: true, targets: [{ target_model_id: 'model-a', rules: {} }],
    announcedMetadata: null, sortOrder: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const response = await requestApp('/v1beta/models', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(response.status, 200);
  const body = await response.json() as { models: Array<{ baseModelId?: string; inputTokenLimit?: number }> };
  expect(body.models.find(model => model.baseModelId === 'mix')?.inputTokenLimit).toBe(100_000);
});
