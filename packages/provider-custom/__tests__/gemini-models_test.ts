import { test } from 'vitest';

import { getCustomProvidedModels } from '../src/catalog.ts';
import { directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildUpstream = (): UpstreamRecord => ({
  id: 'up_gemini',
  kind: 'custom',
  name: 'Gemini',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z',
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  config: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'AIza-test',
    endpoints: { geminiGenerateContent: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [{ upstreamModelId: 'gemini-3-flash', kind: 'chat', endpoints: { geminiGenerateContent: {} } }],
  },
});

test('the catalog parser reads Gemini models and keeps only generateContent-capable entries', async () => {
  const record = buildUpstream();
  const catalogRecord = {
    ...record,
    config: { ...(record.config as Record<string, unknown>), modelsFetch: { enabled: true, authStyle: 'x-goog-api-key' }, models: [] },
  };

  await withMockedFetch(
    () => new Response(JSON.stringify({
      models: [
        {
          name: 'models/gemini-3-flash',
          displayName: 'Gemini 3 Flash',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    async () => {
      const models = await getCustomProvidedModels(catalogRecord, directFetcher);
      assertEquals(models.map(model => model.id), ['gemini-3-flash']);
      assertEquals(models[0].display_name, 'Gemini 3 Flash');
      assertEquals(models[0].limits, { max_prompt_tokens: 1048576, max_context_window_tokens: 1048576, max_output_tokens: 65536 });
      assertEquals(models[0].endpoints, { geminiGenerateContent: {} });
    },
  );
});

test('the catalog fetch follows nextPageToken until the Gemini listing is complete', async () => {
  const record = buildUpstream();
  const catalogRecord = {
    ...record,
    config: { ...(record.config as Record<string, unknown>), modelsFetch: { enabled: true, authStyle: 'x-goog-api-key', endpoint: '/v1beta/models' }, models: [] },
  };
  const urls: string[] = [];

  await withMockedFetch(
    observed => {
      urls.push(observed.url);
      return new URL(observed.url).searchParams.get('pageToken') === null
        ? jsonResponse({ models: [{ name: 'models/gemini-3-flash' }], nextPageToken: 'page-2' })
        : jsonResponse({ models: [{ name: 'models/gemini-3-pro' }] });
    },
    async () => {
      const models = await getCustomProvidedModels(catalogRecord, directFetcher);
      assertEquals(models.map(model => model.id), ['gemini-3-flash', 'gemini-3-pro']);
    },
  );

  assertEquals(urls, [
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2',
  ]);
});
