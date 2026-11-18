import { test } from 'vitest';

import { createCustomProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildUpstream = (baseUrl = 'https://generativelanguage.googleapis.com'): UpstreamRecord => ({
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
    baseUrl,
    apiKey: 'AIza-test',
    endpoints: { geminiGenerateContent: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [{ upstreamModelId: 'gemini-3-flash', kind: 'chat', endpoints: { geminiGenerateContent: {} } }],
  },
});

test('Gemini generation posts to the model action path with alt=sse and the x-goog-api-key header', async () => {
  const provider = createCustomProvider(buildUpstream());
  let request: Request | undefined;

  await withMockedFetch(
    observed => {
      request = observed;
      return sseResponse();
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      await provider.instance.callGeminiGenerateContent(
        model,
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
        undefined,
        noopUpstreamCallOptions(),
      );
    },
  );

  assertExists(request);
  assertEquals(request.method, 'POST');
  assertEquals(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse');
  // The model and the action travel in the path; the body must not repeat them.
  assertEquals(await request.json(), { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
  assertEquals(request.headers.get('x-goog-api-key'), 'AIza-test');
  assertEquals(request.headers.get('authorization'), null);
});

test('baseUrl places the generation root, and a stored models/ prefix is stripped', async () => {
  // The root itself is fixed; a deployment that serves the API under a prefix
  // states it once in baseUrl, which the catalog fetch shares.
  const record = buildUpstream('https://gemini-proxy.example.com/api/gemini');
  const provider = createCustomProvider({
    ...record,
    config: {
      ...(record.config as Record<string, unknown>),
      models: [{ upstreamModelId: 'models/gemini-3-flash', kind: 'chat', endpoints: { geminiGenerateContent: {} } }],
    },
  });
  let request: Request | undefined;

  await withMockedFetch(
    observed => {
      request = observed;
      return sseResponse();
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      await provider.instance.callGeminiGenerateContent(model, { contents: [] }, undefined, noopUpstreamCallOptions());
    },
  );

  assertExists(request);
  assertEquals(request.url, 'https://gemini-proxy.example.com/api/gemini/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse');
});

test('countTokens posts the generate payload inside the generateContentRequest envelope', async () => {
  const provider = createCustomProvider(buildUpstream());
  let request: Request | undefined;

  await withMockedFetch(
    observed => {
      request = observed;
      return jsonResponse({ totalTokens: 12 });
    },
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const { response } = await provider.instance.callGeminiGenerateContentCountTokens(
        model,
        { contents: [{ role: 'user', parts: [{ text: 'hello' }] }], systemInstruction: { parts: [{ text: 'be brief' }] } },
        undefined,
        noopUpstreamCallOptions(),
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { totalTokens: 12 });
    },
  );

  assertExists(request);
  assertEquals(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:countTokens');
  // The countTokens body has no top-level slot for generate fields; Google
  // rejects `systemInstruction` there as an unknown name.
  assertEquals(await request.json(), {
    generateContentRequest: {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      systemInstruction: { parts: [{ text: 'be brief' }] },
      model: 'models/gemini-3-flash',
    },
  });
});

test('the catalog parser reads Gemini models and keeps only generateContent-capable entries', async () => {
  const record = buildUpstream();
  const provider = createCustomProvider({
    ...record,
    config: { ...(record.config as Record<string, unknown>), modelsFetch: { enabled: true, authStyle: 'x-goog-api-key' }, models: [] },
  });

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
      const models = await provider.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(model => model.id), ['gemini-3-flash']);
      assertEquals(models[0].display_name, 'Gemini 3 Flash');
      assertEquals(models[0].limits, { max_prompt_tokens: 1048576, max_context_window_tokens: 1048576, max_output_tokens: 65536 });
      assertEquals(models[0].endpoints, { geminiGenerateContent: {} });
    },
  );
});

test('the catalog fetch follows nextPageToken until the Gemini listing is complete', async () => {
  const record = buildUpstream();
  const provider = createCustomProvider({
    ...record,
    config: { ...(record.config as Record<string, unknown>), modelsFetch: { enabled: true, authStyle: 'x-goog-api-key', endpoint: '/v1beta/models' }, models: [] },
  });
  const urls: string[] = [];

  await withMockedFetch(
    observed => {
      urls.push(observed.url);
      return new URL(observed.url).searchParams.get('pageToken') === null
        ? jsonResponse({ models: [{ name: 'models/gemini-3-flash' }], nextPageToken: 'page-2' })
        : jsonResponse({ models: [{ name: 'models/gemini-3-pro' }] });
    },
    async () => {
      const models = await provider.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(model => model.id), ['gemini-3-flash', 'gemini-3-pro']);
    },
  );

  assertEquals(urls, [
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-2',
  ]);
});
