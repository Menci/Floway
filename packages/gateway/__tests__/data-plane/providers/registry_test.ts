import { expect, test } from 'vitest';

import { MODEL_CATALOG_REVISION } from '../../../src/data-plane/providers/models-cache.ts';
import { listModelProviders } from '../../../src/data-plane/providers/registry.ts';
import { seedModelsCache, storedModelsRefreshIdentity } from '../../repo/models-cache-fixture.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest, sseOpenAIChatCompletionsResponse, sseOpenAIResponsesResponse, sseAnthropicMessagesResponse } from '../../test-utils/app.ts';
import { assertEquals, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

test('listModelProviders creates enabled provider instances with upstream row ids', async () => {
  const { githubAccount, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_custom', sortOrder: 1 }));
  await saveUpstreamForTest(repo.upstreams, {
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 2,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { openaiChatCompletions: {} },
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
  await saveUpstreamForTest(repo.upstreams, buildCopilotUpstreamRecord(githubAccount, { id: 'up_copilot', name: 'Copilot Row', sortOrder: 3 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, usageRefreshIntervalMinutes: 0, sortOrder: 0 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(provider => provider.upstreamId), ['up_custom', 'up_azure', 'up_copilot']);
});

test('listModelProviders without a filter returns global sort_order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(p => p.upstreamId), ['up_a', 'up_b', 'up_c']);
});

test('listModelProviders honors a per-key whitelist with custom order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(['up_c', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_c', 'up_a']);
});

test('listModelProviders silently drops disabled upstreams from a whitelist', async () => {
  // A key whitelist can reference an upstream the operator just disabled;
  // the stored preference survives that transition without surfacing an error.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20, enabled: false }));

  const providers = await listModelProviders(['up_b', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_a']);
});

test('listModelProviders silently drops deleted upstreams from a whitelist', async () => {
  // Deleting an upstream does not prune the caps that reference it, so a
  // dangling id narrows the cap instead of failing the principal's requests.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));

  const providers = await listModelProviders(['up_ghost', 'up_a']);
  assertEquals(providers.map(p => p.upstreamId), ['up_a']);
});

test('listModelProviders carries each row cached catalog onto its instance', async () => {
  // Resolution reads the persisted snapshot off the instance instead of paying a
  // second round trip, so the row read has to bring it along.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const cachedRecord = buildCustomUpstreamRecord({ id: 'up_cached', name: 'Cached', sortOrder: 10 });
  await saveUpstreamForTest(repo.upstreams, cachedRecord);
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_cold', name: 'Cold', sortOrder: 20 }));
  await seedModelsCache(repo.upstreams, 'up_cached', await storedModelsRefreshIdentity(repo.upstreams, 'up_cached'), {
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

// https://platform.kimi.ai/docs/pricing/chat
// https://www.kimi.com/code/docs/en/kimi-code/models.html
for (const protocol of ['chat/completions', 'responses', 'messages'] as const) test.each([
  ['catalog-model', 'Catalog model', 'kimi-catalog-model', undefined, null, null, null],
  ['k3.1-pro', 'K3.1 Pro', 'kimi-k3.1-pro', undefined, '0.000002', '0.0000002', '0.00001'],
  ['k3.1-pro-highspeed', 'K3.1 Pro Highspeed', 'kimi-k3.1-pro', 'fast', '0.000004', '0.0000002', '0.00002'],
  ['kimi-for-coding-highspeed', 'K2.7 Code Highspeed', 'kimi-k2.7-code', 'fast', '0.0000019', '0.00000038', '0.000008'],
  ['kimi-for-coding', 'K2.8 Preview', 'kimi-k2.8-preview', undefined, null, null, null],
] as const)(`Floway routes Kimi Code ${protocol} model %s and records its native lane prices`, async (rawId, displayName, publicId, speed, inputPrice, cachePrice, outputPrice) => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, {
    ...buildCustomUpstreamRecord({ id: 'up_kimi_code' }), kind: 'kimi-code', config: { region: 'china', apiKey: 'sk-kimi-fake-test-key' }, proxyFallbackList: MOCKED_FETCH_EGRESS,
    state: { usageProbe: { attemptedAt: Date.now(), observation: null, error: null }, accountProbe: { attemptedAt: Date.now(), observation: null, error: null } },
  });
  const inferencePaths: string[] = [];
  await withMockedFetch(async request => {
    const path = new URL(request.url).pathname;
    if (path === '/coding/v1/models') return Response.json({ data: [{ id: rawId, display_name: displayName, context_length: 1_048_576, supports_reasoning: true, supports_image_in: true, supports_thinking_type: 'only' }] });
    inferencePaths.push(path);
    expect(path).toBe(`/coding/v1/${protocol}`);
    expect(request.headers.get('authorization')).toBe('Bearer sk-kimi-fake-test-key');
    const body = await request.json();
    expect(body.model).toBe(rawId);
    expect(body.stream).toBe(true);
    expect(body).not.toHaveProperty('thinking');
    if (protocol === 'chat/completions') return sseOpenAIChatCompletionsResponse({
      id: 'turn', model: rawId, created: 1, choices: [{ message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, prompt_tokens_details: { cached_tokens: 1 } },
    });
    if (protocol === 'responses') return sseOpenAIResponsesResponse({
      id: 'turn', object: 'response', model: rawId, status: 'completed', created_at: 1,
      output: [{ id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PONG', annotations: [] }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3, input_tokens_details: { cached_tokens: 1 } },
    });
    return sseAnthropicMessagesResponse({ id: 'turn', model: rawId, content: [{ type: 'text', text: 'PONG' }], stop_reason: 'end_turn', usage: { input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 } });
  }, async () => {
    const lane = speed === undefined ? {} : protocol === 'messages' ? { speed } : { service_tier: speed };
    const body = protocol === 'responses'
      ? { model: publicId, input: 'hello', stream: false, ...lane }
      : { model: publicId, messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false, ...lane };
    const response = await requestAppWithWarmModels(`/v1/${protocol}`, { method: 'POST', headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(JSON.stringify(result)).toContain('PONG');
  });
  expect(inferencePaths).toEqual([`/coding/v1/${protocol}`]);
  const rows = await repo.usage.listAll();
  expect(rows).toHaveLength(1);
  expect(rows[0].model).toBe(publicId);
  expect(rows[0].modelKey).toBe(rawId);
  expect(rows[0].metrics).toEqual([
    { metric: 'input_tokens', quantity: '1', unitPrice: inputPrice },
    { metric: 'input_cache_read_tokens', quantity: '1', unitPrice: cachePrice },
    { metric: 'output_tokens', quantity: '1', unitPrice: outputPrice },
  ]);
});
