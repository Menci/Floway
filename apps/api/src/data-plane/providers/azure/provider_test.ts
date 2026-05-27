import { test } from 'vitest';

import { createAzureProvider } from './provider.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { assertEquals } from '../../../test-assert.ts';
import { withMockedFetch } from '../../../test-helpers.ts';

const azureRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => {
  const config = {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    deployments: [
      {
        deployment: 'gpt-prod',
        publicModelId: 'gpt-public',
        supportedEndpoints: ['/chat/completions', '/responses', '/embeddings'],
        display_name: 'GPT Public',
        limits: { max_context_window_tokens: 128000 },
      },
      {
        deployment: 'gpt-small',
        publicModelId: ' ',
        supportedEndpoints: ['/chat/completions'],
      },
    ],
  };
  const { config: overrideConfig, ...rest } = overrides;

  return {
    id: 'up_azure',
    provider: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    flagOverrides: {},
    ...rest,
    config: overrideConfig ?? config,
  };
};

test('createAzureProvider projects configured deployments into upstream models', async () => {
  const instance = createAzureProvider(azureRecord({ flagOverrides: { 'deepseek-reasoning-dialect': true } }));
  const models = await instance.provider.getProvidedModels();

  assertEquals(instance.upstream, 'up_azure');
  assertEquals(instance.name, 'Azure Resource');
  assertEquals(models[0]?.enabledFlags.has('deepseek-reasoning-dialect'), true);
  assertEquals(
    models.map(model => ({ id: model.id, displayName: model.display_name, endpoints: model.upstreamEndpoints, providerData: model.providerData })),
    [
      {
        id: 'gpt-public',
        displayName: 'GPT Public',
        endpoints: ['chat_completions', 'responses', 'embeddings'],
        providerData: { deployment: 'gpt-prod' },
      },
      {
        id: 'gpt-small',
        displayName: undefined,
        endpoints: ['chat_completions'],
        providerData: { deployment: 'gpt-small' },
      },
    ],
  );
  assertEquals(models[0].limits.max_context_window_tokens, 128000);
});

test('createAzureProvider sends deployment names in OpenAI-shaped request bodies and model keys', async () => {
  const instance = createAzureProvider(azureRecord());
  const [model] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const chat = await instance.provider.callChatCompletions(model, { messages: [{ role: 'user', content: 'hello' }] });
      const responses = await instance.provider.callResponses(model, { input: 'hello' });
      const embeddings = await instance.provider.callEmbeddings(model, { input: 'hello' });

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

test('createAzureProvider supports Azure AI cross-provider deployments with explicit endpoint capabilities', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'deepseek-v4-pro',
            supportedEndpoints: ['/chat/completions'],
          },
          {
            deployment: 'gpt-5.4-pro',
            publicModelId: '',
            supportedEndpoints: ['/responses'],
          },
        ],
      },
    }),
  );
  const [chatModel, responsesModel] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];

  assertEquals(chatModel.id, 'deepseek-v4-pro');
  assertEquals(chatModel.upstreamEndpoints, ['chat_completions']);
  assertEquals(responsesModel.id, 'gpt-5.4-pro');
  assertEquals(responsesModel.upstreamEndpoints, ['responses']);

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const chat = await instance.provider.callChatCompletions(chatModel, { messages: [{ role: 'user', content: 'hello' }] });
      const responses = await instance.provider.callResponses(responsesModel, { input: 'hello' });
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

test('createAzureProvider supports native Azure Anthropic Messages deployments', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.services.ai.azure.com/anthropic/v1',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'claude-prod',
            publicModelId: 'claude-public',
            supportedEndpoints: ['/v1/messages'],
          },
        ],
      },
    }),
  );
  const [model] = await instance.provider.getProvidedModels();
  const seen: Array<{ url: string; xApiKey: string | null; body: Record<string, unknown>; beta: string | null }> = [];

  assertEquals(model.id, 'claude-public');
  assertEquals(model.upstreamEndpoints, ['messages', 'messages_count_tokens']);

  await withMockedFetch(
    async request => {
      seen.push({
        url: request.url,
        xApiKey: request.headers.get('x-api-key'),
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get('anthropic-beta'),
      });
      return new Response('{}', { status: 200 });
    },
    async () => {
      const messages = await instance.provider.callMessages(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] }, undefined, { 'anthropic-beta': 'context-1m' });
      const count = await instance.provider.callMessagesCountTokens(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] });
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

test('createAzureProvider applies per-deployment flag overrides on top of the upstream layer', async () => {
  const instance = createAzureProvider(
    azureRecord({
      flagOverrides: { 'vendor-deepseek': true },
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        deployments: [
          { deployment: 'd1', supportedEndpoints: ['/chat/completions'] },
          {
            deployment: 'd2',
            supportedEndpoints: ['/chat/completions'],
            flagOverrides: { enabled: true, values: { 'vendor-deepseek': false, 'deepseek-reasoning-dialect': true } },
          },
        ],
      },
    }),
  );
  const models = await instance.provider.getProvidedModels();
  const d1 = models.find(model => (model.providerData as { deployment: string }).deployment === 'd1');
  const d2 = models.find(model => (model.providerData as { deployment: string }).deployment === 'd2');
  if (!d1 || !d2) throw new Error('expected both deployments');

  assertEquals(d1.enabledFlags.has('vendor-deepseek'), true);
  assertEquals(d1.enabledFlags.has('deepseek-reasoning-dialect'), false);
  assertEquals(d2.enabledFlags.has('vendor-deepseek'), false);
  assertEquals(d2.enabledFlags.has('deepseek-reasoning-dialect'), true);
});

test('createAzureProvider skips the per-deployment layer when flagOverrides.enabled is false', async () => {
  const instance = createAzureProvider(
    azureRecord({
      flagOverrides: { 'vendor-deepseek': true },
      config: {
        endpoint: 'https://example.openai.azure.com/openai/v1',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'd1',
            supportedEndpoints: ['/chat/completions'],
            flagOverrides: { enabled: false, values: { 'vendor-deepseek': false } },
          },
        ],
      },
    }),
  );
  const [model] = await instance.provider.getProvidedModels();

  assertEquals(model.enabledFlags.has('vendor-deepseek'), true);
});

test('createAzureProvider attaches cost field from deployment config', async () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'gpt-prod',
            publicModelId: 'gpt-public',
            supportedEndpoints: ['/chat/completions'],
            cost: { input: 2.5, output: 15, cache_read: 0.25 },
          },
          {
            deployment: 'gpt-small',
            supportedEndpoints: ['/chat/completions'],
          },
        ],
      },
    }),
  );
  const models = await instance.provider.getProvidedModels();
  assertEquals(models[0].cost, { input: 2.5, output: 15, cache_read: 0.25 });
  assertEquals(models[1].cost, undefined);
});

test('createAzureProvider getPricingForModelKey resolves by deployment name', () => {
  const instance = createAzureProvider(
    azureRecord({
      config: {
        endpoint: 'https://example.openai.azure.com',
        apiKey: 'az-key',
        deployments: [
          {
            deployment: 'gpt-prod',
            supportedEndpoints: ['/chat/completions'],
            cost: { input: 2.5, output: 15 },
          },
          {
            deployment: 'gpt-small',
            supportedEndpoints: ['/chat/completions'],
          },
        ],
      },
    }),
  );
  assertEquals(instance.provider.getPricingForModelKey('gpt-prod'), { input: 2.5, output: 15 });
  assertEquals(instance.provider.getPricingForModelKey('gpt-small'), null);
  assertEquals(instance.provider.getPricingForModelKey('unknown'), null);
});

test('createAzureProvider exposes image deployments and routes generations with api-version=preview', async () => {
  const record: UpstreamRecord = {
    id: 'az-image',
    provider: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      deployments: [{
        deployment: 'gpt-image-2',
        supportedEndpoints: ['/v1/images/generations', '/v1/images/edits'],
      }],
    },
  };

  let observedUrl: string | undefined;
  let observedBody: { model?: unknown; prompt?: unknown } | undefined;
  await withMockedFetch(
    async request => {
      observedUrl = request.url;
      observedBody = await request.json() as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ b64_json: 'x' }], usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      const provider = createAzureProvider(record).provider;
      const models = await provider.getProvidedModels();
      assertEquals(models[0].kind, 'image');
      assertEquals([...models[0].upstreamEndpoints].sort(), ['images_edits', 'images_generations']);
      const result = await provider.callImagesGenerations(models[0], { prompt: 'hello' });
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
  assertEquals(observedBody?.model, 'gpt-image-2');
  assertEquals(observedBody?.prompt, 'hello');
});

test('createAzureProvider callImagesEdits posts multipart with model replaced by deployment id and api-version=preview', async () => {
  const record: UpstreamRecord = {
    id: 'az-image',
    provider: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      deployments: [{
        deployment: 'gpt-image-2',
        supportedEndpoints: ['/v1/images/edits'],
      }],
    },
  };

  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      observedUrl = request.url;
      observedForm = await request.formData();
      return new Response(JSON.stringify({ data: [{ b64_json: 'x' }], usage: { input_tokens: 3, output_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      const provider = createAzureProvider(record).provider;
      const models = await provider.getProvidedModels();
      const form = new FormData();
      form.append('prompt', 'replace sky');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const result = await provider.callImagesEdits(models[0], form);
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  assertEquals(observedForm?.get('prompt'), 'replace sky');
});
