import { test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/repo/models-cache-contract.ts';
import { modelsRefreshIdentity, seedModelsCache } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, requestApp, setupAppTest, sseOpenAIChatCompletionsResponse } from '../../test-utils/app.ts';
import { projectCustomModels } from '@floway-dev/provider-custom';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const cases: Array<{ name: string; access: 'all' | 'none' | 'up_a' | 'up_b'; keyCap: string[] | null; models: string[] }> = [
  { name: 'all Model.Use grants and an inheriting key', access: 'all', keyCap: null, models: ['model_a', 'model_b'] },
  { name: 'an empty key restriction', access: 'all', keyCap: [], models: [] },
  { name: 'an empty key under a single-upstream grant', access: 'up_a', keyCap: [], models: [] },
  { name: 'no Model.Use grants with an inheriting key', access: 'none', keyCap: null, models: [] },
  { name: 'no Model.Use grants and an empty key', access: 'none', keyCap: [], models: [] },
  { name: 'a key cannot add an upstream absent from Model.Use', access: 'none', keyCap: ['up_a'], models: [] },
  { name: 'a single-upstream grant with an inheriting key', access: 'up_a', keyCap: null, models: ['model_a'] },
  { name: 'disjoint Model.Use and key restrictions', access: 'up_b', keyCap: ['up_a'], models: [] },
];

test.each(cases)('$name controls model visibility and upstream dispatch', async ({ access, keyCap, models }) => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const suffix of ['a', 'b']) {
    const upstream = buildCustomUpstreamRecord({
      id: `up_${suffix}`,
      name: `Upstream ${suffix}`,
      config: {
        baseUrl: `https://${suffix}.example.com`,
        authStyle: 'bearer',
        ingressHeadersRules: [],
        apiKey: 'upstream-key',
        endpoints: { openaiChatCompletions: {} },
        modelsFetch: { enabled: false },
        models: [{ upstreamModelId: `model_${suffix}`, kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
      },
    });
    await saveUpstreamForTest(repo.upstreams, upstream);
    const stored = await repo.upstreams.getById(upstream.id);
    if (stored === null) throw new Error(`Upstream ${upstream.id} was not saved`);
    assertEquals(await seedModelsCache(repo.upstreams, upstream.id, modelsRefreshIdentity(stored), {
      revision: MODEL_CATALOG_REVISION,
      fetchedAt: Date.now(),
      models: projectCustomModels(stored),
    }), true);
  }

  const keyUpdate = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ upstream_ids: keyCap }),
  });
  assertEquals(keyUpdate.status, 200);
  if (access !== 'all') {
    await repo.accessRecords.deleteByPrincipal({ kind: 'user', id: apiKey.userId });
    if (access !== 'none') {
      await repo.accessRecords.save({
        principal: { kind: 'user', id: apiKey.userId },
        scope: { kind: 'upstream', upstreamId: access },
        sortOrder: 0,
        values: { 'Model.Use': true },
      });
    }
  }

  const dispatchedModels: string[] = [];
  await withMockedFetch(async request => {
    assertEquals(new URL(request.url).pathname, '/v1/chat/completions');
    const { model } = await request.json() as { model: string };
    dispatchedModels.push(model);
    return sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl-upstream-access',
      model,
      created: 0,
      choices: [{ message: { refusal: null, role: 'assistant', content: 'Available' }, finish_reason: 'stop' }],
    });
  }, async () => {
    const listed = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(listed.status, 200);
    const catalog = await listed.json();

    const geminiListed = await requestApp('/v1beta/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(geminiListed.status, 200);
    const geminiCatalog = await geminiListed.json();
    assertEquals(catalog.data.map((model: { id: string }) => model.id).sort(), models);
    assertEquals(geminiCatalog.models.map((model: { baseModelId: string }) => model.baseModelId).sort(), models);

    for (const model of ['model_a', 'model_b']) {
      const response = await requestApp('/v1/chat/completions', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
      });
      assertEquals(response.status, models.includes(model) ? 200 : 404);
      await response.json();
    }
  });
  assertEquals(dispatchedModels, models);
});
