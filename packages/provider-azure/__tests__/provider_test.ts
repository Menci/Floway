import { test } from 'vitest';

import { createAzureProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-public',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
        display_name: 'GPT Public',
        limits: { max_context_window_tokens: 128000 },
      },
      {
        upstreamModelId: 'gpt-small',
        publicModelId: ' ',
        endpoints: { openaiChatCompletions: {} },
      },
    ],
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    ...rest,
    config: overrideConfig ?? config,
  };
};

test('createAzureProvider projects configured models into upstream models', async () => {
  const instance = createAzureProvider(azureRecord({ flagOverrides: { 'vendor-kimi': true } }));
  const models = await instance.instance.getProvidedModels(directFetcher);

  assertEquals(models[0]?.enabledFlags.has('vendor-kimi'), true);
  assertEquals(
    models.map(model => ({ id: model.id, displayName: model.display_name, endpoints: model.endpoints, providerData: model.providerData })),
    [
      {
        id: 'gpt-public',
        displayName: 'GPT Public',
        endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
        providerData: { upstreamModelId: 'gpt-prod' },
      },
      {
        id: 'gpt-small',
        displayName: undefined,
        endpoints: { openaiChatCompletions: {} },
        providerData: { upstreamModelId: 'gpt-small' },
      },
    ],
  );
  assertEquals(models.map(model => model.opaqueBlobCompatibilityScope), [
    { bindToUpstream: true },
    { bindToUpstream: true },
  ]);
  assertEquals(models[0].limits.max_context_window_tokens, 128000);
});

test('createAzureProvider sends upstream model ids in OpenAI-shaped request bodies and model keys', async () => {
  const instance = createAzureProvider(azureRecord());
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
      });
      return sseResponse();
    },
    async () => {
      const chat = await instance.instance.callOpenAIChatCompletions(providerModel, { messages: [{ role: 'user', content: 'hello' }] }, undefined, noopUpstreamCallOptions());
      const responses = await instance.instance.callOpenAIResponses(providerModel, {
        input: [{
          type: 'additional_tools',
          role: 'developer',
          tools: [{
            type: 'namespace',
            name: 'functions',
            description: '',
            tools: [{ type: 'function', name: 'lookup', description: 'Look up a record.', parameters: { type: 'object', properties: {} } }],
          }],
        }],
      }, 'generate', undefined, noopUpstreamCallOptions());
      const embeddings = await instance.instance.callOpenAIEmbeddings(providerModel, { input: 'hello' }, undefined, noopUpstreamCallOptions());

      assertEquals(chat.modelKey, 'gpt-prod');
      assertEquals(responses.modelKey, 'gpt-prod');
      assertEquals(embeddings.modelKey, 'gpt-prod');
    },
  );

  assertEquals(
    seen.map(item => item.url),
    [
      'https://example.openai.azure.com/openai/v1/chat/completions',
      'https://example.openai.azure.com/openai/v1/responses',
      'https://example.openai.azure.com/openai/v1/embeddings',
    ],
  );
  assertEquals(
    seen.map(item => item.body.model),
    ['gpt-prod', 'gpt-prod', 'gpt-prod'],
  );
});

test.each(['compact'] as const)('createAzureProvider preserves %s upstream errors through the OpenAI Responses boundary', async action => {
  const instance = createAzureProvider(azureRecord());
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const upstreamResponse = new Response('{"error":"upstream rejected the request"}', {
    status: 418,
    headers: { 'content-type': 'application/json', 'x-upstream-error': action },
  });

  await withMockedFetch(
    () => Promise.resolve(upstreamResponse),
    async () => {
      const result = await instance.instance.callOpenAIResponses(
        providerModel,
        { input: [{ type: 'message', role: 'user', content: 'hello' }] },
        action,
        undefined,
        noopUpstreamCallOptions(),
      );
      assertEquals(result.action, action);
      assertEquals(result.ok, false);
      if (result.ok) throw new Error('expected upstream error');
      assertEquals(result.modelKey, 'gpt-prod');
      assertEquals(result.response, upstreamResponse);
      assertEquals(result.response.status, 418);
      assertEquals(result.response.headers.get('x-upstream-error'), action);
      assertEquals(await result.response.text(), '{"error":"upstream rejected the request"}');
    },
  );
});

test('createAzureProvider supports native Azure Anthropic Messages models', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.services.ai.azure.com/anthropic/v1',
        apiKey: 'az-key',
        models: [
          {
            upstreamModelId: 'claude-prod',
            publicModelId: 'claude-public',
            endpoints: { anthropicMessages: {} },
          },
        ],
      },
    }),
  );
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<{ url: string; xApiKey: string | null; version: string | null; body: Record<string, unknown>; beta: string | null }> = [];

  assertEquals(providerModel.id, 'claude-public');
  assertEquals(providerModel.endpoints, { anthropicMessages: {} });

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        xApiKey: request.headers.get('x-api-key'),
        version: request.headers.get('anthropic-version'),
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get('anthropic-beta'),
      });
      return sseResponse();
    },
    async () => {
      const messages = await instance.instance.callAnthropicMessages(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, { ...noopUpstreamCallOptions(), anthropicBeta: ['context-1m'] });
      const count = await instance.instance.callAnthropicMessagesCountTokens(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, { ...noopUpstreamCallOptions(), anthropicBeta: ['context-1m', 'advanced-tool-use'] });
      assertEquals(messages.modelKey, 'claude-prod');
      assertEquals(count.modelKey, 'claude-prod');
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      xApiKey: 'az-key',
      version: '2023-06-01',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], stream: true, model: 'claude-prod' },
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      xApiKey: 'az-key',
      version: '2023-06-01',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'claude-prod' },
      beta: 'context-1m,advanced-tool-use',
    },
  ]);
});

test('createAzureProvider callOpenAIImagesEdits posts multipart with model replaced by upstream model id and api-version=preview', async () => {
  const record: UpstreamRecord = {
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { openaiImagesEdits: {} },
      }],
    },
    state: null,
  };

  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      observedUrl = request.url;
      observedForm = await request.formData();
      return new Response(JSON.stringify({ data: [{ b64_json: 'x' }], usage: { input_tokens: 3, output_tokens: 4 } }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      const provider = createAzureProvider(record);
      const models = await provider.instance.getProvidedModels(directFetcher);
      const result = await provider.instance.callOpenAIImagesEdits(models[0], {
        parameters: { prompt: 'replace sky' },
        images: [{
          type: 'upload',
          file: new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
        }],
      }, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  assertEquals(observedForm?.get('prompt'), 'replace sky');
});
