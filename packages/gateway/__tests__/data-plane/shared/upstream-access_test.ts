import { test } from 'vitest';

import { buildCustomUpstreamRecord, requestApp, setupAppTest, sseOpenAIChatCompletionsResponse } from '../../test-utils/app.ts';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

const cases: Array<{ name: string; userCap: string[] | null; keyCap: string[] | null; models: string[] }> = [
  { name: 'unrestricted user and key', userCap: null, keyCap: null, models: ['model_a', 'model_b'] },
  { name: 'empty key restriction', userCap: null, keyCap: [], models: [] },
  { name: 'empty key under a restricted user', userCap: ['up_a'], keyCap: [], models: [] },
  { name: 'empty user restriction with an inheriting key', userCap: [], keyCap: null, models: [] },
  { name: 'empty user and key restrictions', userCap: [], keyCap: [], models: [] },
  { name: 'user restriction narrowed to empty after a key grant', userCap: [], keyCap: ['up_a'], models: [] },
  { name: 'restricted user with an inheriting key', userCap: ['up_a'], keyCap: null, models: ['model_a'] },
  { name: 'disjoint user and key restrictions', userCap: ['up_b'], keyCap: ['up_a'], models: [] },
];

test.each(cases)('$name controls model visibility and upstream dispatch', async ({ userCap, keyCap, models }) => {
  const { repo, apiKey, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  for (const suffix of ['a', 'b']) {
    await repo.upstreams.save(buildCustomUpstreamRecord({
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
    }));
  }

  const keyUpdate = await requestApp(`/api/keys/${apiKey.id}`, {
    method: 'PATCH',
    headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
    body: JSON.stringify({ upstream_ids: keyCap }),
  });
  assertEquals(keyUpdate.status, 200);
  const userUpdate = await requestApp(`/api/users/${apiKey.userId}`, {
    method: 'PATCH',
    headers: { 'x-floway-session': adminSession, 'content-type': 'application/json' },
    body: JSON.stringify({ upstreamIds: userCap }),
  });
  assertEquals(userUpdate.status, 200);

  const dispatchedModels: string[] = [];
  await withMockedFetch(async request => {
    assertEquals(new URL(request.url).pathname, '/v1/chat/completions');
    const { model } = await request.json() as { model: string };
    dispatchedModels.push(model);
    return sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl-upstream-access',
      model,
      created: 0,
      choices: [{ message: { role: 'assistant', content: 'Available' }, finish_reason: 'stop' }],
    });
  }, async () => {
    const listingStatus = models.length > 0 ? 200 : 502;
    const listed = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(listed.status, listingStatus);
    const catalog = await listed.json();

    const geminiListed = await requestApp('/v1beta/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(geminiListed.status, listingStatus);
    const geminiCatalog = await geminiListed.json();
    if (models.length > 0) {
      assertEquals(catalog.data.map((model: { id: string }) => model.id).sort(), models);
      assertEquals(geminiCatalog.models.map((model: { baseModelId: string }) => model.baseModelId).sort(), models);
    } else {
      const message = 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard';
      assertEquals(catalog, { error: { message, type: 'api_error' } });
      assertEquals(geminiCatalog, { error: { code: 502, message, status: 'UNAVAILABLE' } });
    }

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
