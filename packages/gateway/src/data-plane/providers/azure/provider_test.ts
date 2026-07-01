import { test } from 'vitest';

import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { createAzureProvider } from '@floway-dev/provider-azure';
import { assertEquals, noopUpstreamCallOptions, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'gpt-prod',
        publicModelId: 'gpt-public',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
        display_name: 'GPT Public',
        limits: { max_context_window_tokens: 128000 },
      },
      {
        upstreamModelId: 'gpt-small',
        publicModelId: ' ',
        endpoints: { chatCompletions: {} },
      },
    ],
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    ...rest,
    config: overrideConfig ?? config,
  };
};

test('createAzureProvider projects configured models into upstream models', async () => {
  const instance = createAzureProvider(azureRecord({ flagOverrides: { 'vendor-kimi': true } }));
  const models = await instance.instance.getProvidedModels(directFetcher);

  assertEquals(instance.upstream, 'up_azure');
  assertEquals(instance.name, 'Azure Resource');
  assertEquals(instance.supportsResponsesItemReference, true);
  assertEquals(models[0]?.enabledFlags.has('vendor-kimi'), true);
  assertEquals(
    models.map(model => ({ id: model.id, displayName: model.display_name, endpoints: model.endpoints, providerData: model.providerData })),
    [
      {
        id: 'gpt-public',
        displayName: 'GPT Public',
        endpoints: { chatCompletions: {}, responses: {}, embeddings: {} },
        providerData: { upstreamModelId: 'gpt-prod' },
      },
      {
        id: 'gpt-small',
        displayName: undefined,
        endpoints: { chatCompletions: {} },
        providerData: { upstreamModelId: 'gpt-small' },
      },
    ],
  );
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
      const chat = await instance.instance.callChatCompletions(providerModel, { messages: [{ role: 'user', content: 'hello' }] }, undefined, noopUpstreamCallOptions());
      const responses = await instance.instance.callResponses(providerModel, { input: 'hello' }, 'generate', undefined, noopUpstreamCallOptions());
      const embeddings = await instance.instance.callEmbeddings(providerModel, { input: 'hello' }, undefined, noopUpstreamCallOptions());

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

test('createAzureProvider supports Azure AI cross-provider models with explicit endpoint capabilities', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        models: [
          {
            upstreamModelId: 'deepseek-v4-pro',
            endpoints: { chatCompletions: {} },
          },
          {
            upstreamModelId: 'gpt-5.4-pro',
            publicModelId: '',
            endpoints: { responses: {} },
          },
        ],
      },
    }),
  );
  const [chatProviderModel, responsesProviderModel] = await instance.instance.getProvidedModels(directFetcher);
  const chatOpts = noopUpstreamCallOptions();
  const responsesOpts = noopUpstreamCallOptions();
  const seen: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];

  assertEquals(chatProviderModel.id, 'deepseek-v4-pro');
  assertEquals(chatProviderModel.endpoints, { chatCompletions: {} });
  assertEquals(responsesProviderModel.id, 'gpt-5.4-pro');
  assertEquals(responsesProviderModel.endpoints, { responses: {} });

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return sseResponse();
    },
    async () => {
      const chat = await instance.instance.callChatCompletions(chatProviderModel, { messages: [{ role: 'user', content: 'hello' }] }, undefined, chatOpts);
      const responses = await instance.instance.callResponses(responsesProviderModel, { input: 'hello' }, 'generate', undefined, responsesOpts);
      assertEquals(chat.modelKey, 'deepseek-v4-pro');
      assertEquals(responses.modelKey, 'gpt-5.4-pro');
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.openai.azure.com/openai/v1/chat/completions',
      apiKey: 'az-key',
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        model: 'deepseek-v4-pro',
      },
    },
    {
      url: 'https://example.openai.azure.com/openai/v1/responses',
      apiKey: 'az-key',
      body: {
        input: 'hello',
        stream: true,
        model: 'gpt-5.4-pro',
      },
    },
  ]);
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
            endpoints: { messages: {} },
          },
        ],
      },
    }),
  );
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<{ url: string; xApiKey: string | null; body: Record<string, unknown>; beta: string | null }> = [];

  assertEquals(providerModel.id, 'claude-public');
  assertEquals(providerModel.endpoints, { messages: {} });

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        xApiKey: request.headers.get('x-api-key'),
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get('anthropic-beta'),
      });
      return sseResponse();
    },
    async () => {
      const messages = await instance.instance.callMessages(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, { ...noopUpstreamCallOptions(), headers: new Headers({ 'anthropic-beta': 'context-1m' }) });
      const count = await instance.instance.callMessagesCountTokens(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, noopUpstreamCallOptions());
      assertEquals(messages.modelKey, 'claude-prod');
      assertEquals(count.modelKey, 'claude-prod');
    },
  );

  assertEquals(seen, [
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages',
      xApiKey: 'az-key',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], stream: true, model: 'claude-prod' },
      beta: 'context-1m',
    },
    {
      url: 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
      xApiKey: 'az-key',
      body: { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'claude-prod' },
      beta: null,
    },
  ]);
});

test('createAzureProvider forwards inbound anthropic-beta header through opts.headers', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.services.ai.azure.com/anthropic/v1',
        apiKey: 'az-key',
        models: [{ upstreamModelId: 'claude-prod', endpoints: { messages: {} } }],
      },
    }),
  );
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<string | null> = [];

  await withMockedFetch(
    request => {
      seen.push(request.headers.get('anthropic-beta'));
      return Promise.resolve(sseResponse());
    },
    async () => {
      // The data plane plumbs the inbound `anthropic-beta` header straight
      // through `opts.headers`. Azure has no boundary filter, so whatever
      // arrives on `opts.headers` is what the wire sees.
      await instance.instance.callMessages(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, { ...noopUpstreamCallOptions(), headers: new Headers({ 'anthropic-beta': 'context-1m-2025-08-07,interleaved-thinking-2025-05-14' }) });
      await instance.instance.callMessagesCountTokens(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, { ...noopUpstreamCallOptions(), headers: new Headers({ 'anthropic-beta': 'context-1m-2025-08-07' }) });
      // No beta header → no header on the wire (the regression guard for the
      // pre-86ef9aa drop).
      await instance.instance.callMessages(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, noopUpstreamCallOptions());
      await instance.instance.callMessages(providerModel, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, noopUpstreamCallOptions());
    },
  );

  assertEquals(seen, ['context-1m-2025-08-07,interleaved-thinking-2025-05-14', 'context-1m-2025-08-07', null, null]);
});

test('createAzureProvider applies per-model flag overrides on top of the upstream layer', async () => {
  const instance = createAzureProvider(
    azureRecord({
      flagOverrides: { 'vendor-deepseek': true },
      disabledPublicModelIds: [],
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        models: [
          { upstreamModelId: 'd1', endpoints: { chatCompletions: {} } },
          {
            upstreamModelId: 'd2',
            endpoints: { chatCompletions: {} },
            flagOverrides: { enabled: true, values: { 'vendor-deepseek': false, 'vendor-kimi': true } },
          },
        ],
      },
    }),
  );
  const models = await instance.instance.getProvidedModels(directFetcher);
  const d1 = models.find(model => (model.providerData as { upstreamModelId: string }).upstreamModelId === 'd1');
  const d2 = models.find(model => (model.providerData as { upstreamModelId: string }).upstreamModelId === 'd2');
  if (!d1 || !d2) throw new Error('expected both models');

  assertEquals(d1.enabledFlags.has('vendor-deepseek'), true);
  assertEquals(d1.enabledFlags.has('vendor-kimi'), false);
  assertEquals(d2.enabledFlags.has('vendor-deepseek'), false);
  assertEquals(d2.enabledFlags.has('vendor-kimi'), true);
});

test('createAzureProvider skips the per-model layer when flagOverrides.enabled is false', async () => {
  const instance = createAzureProvider(
    azureRecord({
      flagOverrides: { 'vendor-deepseek': true },
      disabledPublicModelIds: [],
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        models: [
          {
            upstreamModelId: 'd1',
            endpoints: { chatCompletions: {} },
            flagOverrides: { enabled: false, values: { 'vendor-deepseek': false } },
          },
        ],
      },
    }),
  );
  const [model] = await instance.instance.getProvidedModels(directFetcher);

  assertEquals(model.enabledFlags.has('vendor-deepseek'), true);
});

test('createAzureProvider attaches cost field from model config', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'az-key',
        models: [
          {
            upstreamModelId: 'gpt-prod',
            publicModelId: 'gpt-public',
            endpoints: { chatCompletions: {} },
            cost: { input: 2.5, output: 15, input_cache_read: 0.25 },
          },
          {
            upstreamModelId: 'gpt-small',
            endpoints: { chatCompletions: {} },
          },
        ],
      },
    }),
  );
  const models = await instance.instance.getProvidedModels(directFetcher);
  assertEquals(models[0].cost, { input: 2.5, output: 15, input_cache_read: 0.25 });
  assertEquals(models[1].cost, undefined);
});

test('createAzureProvider getPricingForModelKey resolves by upstream model id', () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'az-key',
        models: [
          {
            upstreamModelId: 'gpt-prod',
            endpoints: { chatCompletions: {} },
            cost: { input: 2.5, output: 15 },
          },
          {
            upstreamModelId: 'gpt-small',
            endpoints: { chatCompletions: {} },
          },
        ],
      },
    }),
  );
  assertEquals(instance.instance.getPricingForModelKey('gpt-prod'), { input: 2.5, output: 15 });
  assertEquals(instance.instance.getPricingForModelKey('gpt-small'), null);
  assertEquals(instance.instance.getPricingForModelKey('unknown'), null);
});

test('createAzureProvider exposes image models and routes generations with api-version=preview', async () => {
  const record: UpstreamRecord = {
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { imagesGenerations: {}, imagesEdits: {} },
      }],
    },
    state: null,
  };

  let observedUrl: string | undefined;
  let observedBody: { model?: unknown; prompt?: unknown } | undefined;
  await withMockedFetch(
    async request => {
      observedUrl = request.url;
      observedBody = await request.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ b64_json: 'x' }], usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) });
    },
    async () => {
      const provider = createAzureProvider(record);
      const models = await provider.instance.getProvidedModels(directFetcher);
      assertEquals(models[0].kind, 'image');
      assertEquals(models[0].endpoints, { imagesGenerations: {}, imagesEdits: {} });
      const result = await provider.instance.callImagesGenerations(models[0], { prompt: 'hello' }, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
  assertEquals(observedBody?.model, 'gpt-image-2');
  assertEquals(observedBody?.prompt, 'hello');
});

test('createAzureProvider callImagesEdits posts multipart with model replaced by upstream model id and api-version=preview', async () => {
  const record: UpstreamRecord = {
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { imagesEdits: {} },
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
      const form = new FormData();
      form.append('prompt', 'replace sky');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const result = await provider.instance.callImagesEdits(models[0], form, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  assertEquals(observedForm?.get('prompt'), 'replace sky');
});
