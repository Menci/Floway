import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest, sseOpenAIChatCompletionsResponse, sseOpenAIResponsesResponse, sseAnthropicMessagesResponse } from '../../test-utils/app.ts';
import { assertEquals, withMockedFetch } from '@floway-dev/test-utils';

test('listCatalog returns enabled upstreams in sort order and silently drops deleted whitelist ids', async () => {
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
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    hue: 210,
    state: null,
  }, {
    manualModels: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
  });
  await saveUpstreamForTest(repo.upstreams, buildCopilotUpstreamRecord(githubAccount, { id: 'up_copilot', name: 'Copilot Row', sortOrder: 3 }));
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, usageRefreshIntervalMinutes: 0, sortOrder: 0 }));

  const all = await repo.upstreamModels.listCatalog(null);
  assertEquals(all.upstreams.map(upstream => upstream.id), ['up_custom', 'up_azure', 'up_copilot']);

  // Deleting an upstream does not prune the caps that reference it, so a
  // dangling id narrows the cap instead of failing the principal's requests.
  const filtered = await repo.upstreamModels.listCatalog({
    include: ['up_ghost', 'up_copilot', 'up_custom'],
    preserveIncludeOrder: true,
  });
  assertEquals(filtered.upstreams.map(upstream => upstream.id), ['up_copilot', 'up_custom']);
});

// Lane selection and per-model prices belong to provider-kimi-code; this
// proves each client protocol carries the selected lane through to the
// recorded usage prices. The K3.1 rates are published by Moonshot.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://platform.kimi.ai/docs/pricing/chat
for (const protocol of ['chat/completions', 'responses', 'messages'] as const) test(`Floway routes Kimi Code ${protocol} fast lane and records its native lane prices`, async () => {
  const [rawId, displayName, publicId, speed, inputPrice, cachePrice, outputPrice] = ['k3.1-pro-highspeed', 'K3.1 Pro Highspeed', 'kimi-k3.1-pro', 'fast', '0.000004', '0.0000002', '0.00002'];
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
    const lane = protocol === 'messages' ? { speed } : { service_tier: speed };
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
