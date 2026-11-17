import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/config.ts';
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

test('a Gemini-compatible upstream behind another host still uses the Google header', async () => {
  const provider = createCustomProvider(buildUpstream('https://gemini-proxy.example.com'));
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
  assertEquals(request.url, 'https://gemini-proxy.example.com/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse');
  // The outbound protocol selects the credential header: Gemini is not
  // OpenAI-compatible, so it never sends a bearer token.
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

test('the catalog fetch accepts x-goog-api-key alongside the other header schemes', () => {
  const record = buildUpstream();
  const { config } = assertCustomUpstreamRecord({
    ...record,
    config: { ...(record.config as Record<string, unknown>), modelsFetch: { enabled: true, authStyle: 'x-goog-api-key' } },
  });
  assertEquals(config.modelsFetch, { enabled: true, authStyle: 'x-goog-api-key' });
});

test('an empty api key makes the upstream anonymous for every scheme', async () => {
  const provider = createCustomProvider({
    ...buildUpstream(),
    config: { ...buildUpstream().config as Record<string, unknown>, apiKey: '' },
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
  assertEquals(request.headers.get('x-goog-api-key'), null);
  assertEquals(request.headers.get('authorization'), null);
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

test('a real Gemini SSE body parses into protocol frames through the provider call', async () => {
  const provider = createCustomProvider(buildUpstream());
  const sse = [
    `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }] })}`,
    '',
    `data: ${JSON.stringify({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } })}`,
    '',
    '',
  ].join('\n');

  const result = await withMockedFetch(
    () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      return await provider.instance.callGeminiGenerateContent(model, { contents: [] }, undefined, noopUpstreamCallOptions());
    },
  );

  assertEquals(result.ok, true);
  if (!result.ok) throw new Error('expected an event stream');
  assertEquals(result.modelKey, 'gemini-3-flash');

  const events = [];
  for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
  assertEquals(events, [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } },
  ]);
});
