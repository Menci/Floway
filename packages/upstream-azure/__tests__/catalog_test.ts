import { expect, test } from 'vitest';

import { azureUpstreamModule } from '../src/index.ts';
import type { Fetcher } from '@floway-dev/http';
import type { UpstreamRecord } from '@floway-dev/upstream';

const record: UpstreamRecord = {
  id: 'up_azure',
  kind: 'azure',
  name: 'Azure Resource',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  state: null,
  flagOverrides: { 'vendor-kimi': true },
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  hue: 210,
  config: { endpoint: 'https://example.openai.azure.com', apiKey: 'azure-key' },
};

const fetcher: Fetcher = async () => { throw new Error('Azure catalog must use configured deployments'); };

test('Azure catalog projects manual models with aliases, endpoint capabilities, scoped identity and effective flags', async () => {
  const [publicModel, fallbackModel] = await azureUpstreamModule.getModels(record, fetcher, [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-public',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
      display_name: 'GPT Public',
      limits: { max_context_window_tokens: 128000 },
    },
    {
      upstreamModelId: 'gpt-small',
      publicModelId: ' ',
      kind: 'chat',
      endpoints: { openaiChatCompletions: {} },
    },
  ]);
  expect(publicModel).toMatchObject({
    id: 'gpt-public', upstreamModelId: 'gpt-prod', display_name: 'GPT Public',
    endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    limits: { max_context_window_tokens: 128000 },
  });
  expect(publicModel.enabledFlags.has('vendor-kimi')).toBe(true);
  expect(fallbackModel).toMatchObject({
    id: 'gpt-small', upstreamModelId: 'gpt-small',
    endpoints: { openaiChatCompletions: {} }, opaqueBlobCompatibilityScope: { bindToUpstream: true },
  });
  expect(fallbackModel).not.toHaveProperty('display_name');
  await expect(azureUpstreamModule.getModels(record, fetcher)).resolves.toEqual([]);
});
