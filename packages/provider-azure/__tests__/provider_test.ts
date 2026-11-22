import { test } from 'vitest';

import { azureInput, callAzure } from './pipeline-fixture.ts';
import { createAzureProvider } from '../src/provider.ts';
import { Bytes, isSecret, type RunEvent } from '@floway-dev/pipeline';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, sseResponse, withMockedFetch } from '@floway-dev/test-utils';

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
  const seen: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];
  const events: RunEvent[] = [];

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
      const chat = await callAzure(
        instance.pipelines.openaiChatCompletions,
        azureInput(providerModel, { messages: [{ role: 'user', content: 'hello' }] }),
        directFetcher,
        event => events.push(event),
      );
      const responses = await callAzure(instance.pipelines.openaiResponses, {
        ...azureInput(providerModel, {
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
        }),
        'request.action': 'generate',
      });
      const embeddings = await callAzure(instance.pipelines.openaiEmbeddings, azureInput(providerModel, { input: 'hello' }));

      assertEquals(chat['response.modelKey'], 'gpt-prod');
      assertEquals(responses['response.modelKey'], 'gpt-prod');
      assertEquals(embeddings['response.modelKey'], 'gpt-prod');
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
  assertEquals(seen.map(item => item.apiKey), ['az-key', 'az-key', 'az-key']);
  const dispatch = events.find(event => event.k === 'enter' && event.name === 'http');
  if (dispatch?.k !== 'enter') throw new Error('Expected HTTP terminal entry');
  assertEquals(JSON.stringify(dispatch).includes('az-key'), false);
  const outbound = dispatch.facts['request.http'];
  assertEquals(typeof outbound === 'object' && outbound !== null && 'headers' in outbound && Array.isArray(outbound.headers)
    && outbound.headers.some(entry => Array.isArray(entry) && entry[0] === 'api-key' && isSecret(entry[1])), true);
  assertEquals(seen[1].body.input, [{
    type: 'additional_tools',
    role: 'developer',
    tools: [{
      type: 'namespace',
      name: 'functions',
      description: 'Tools in the functions namespace.',
      tools: [{ type: 'function', name: 'lookup', description: 'Look up a record.', parameters: { type: 'object', properties: {} } }],
    }],
  }]);
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
      const result = await callAzure(instance.pipelines.openaiResponses, {
        ...azureInput(providerModel, { input: [{ type: 'message', role: 'user', content: 'hello' }] }),
        'request.action': action,
      });
      assertEquals(result['response.events'], undefined);
      assertEquals(result['response.result'], undefined);
      assertEquals(result['response.modelKey'], 'gpt-prod');
      assertEquals(result['response.http'].status, 418);
      assertEquals(result['response.http'].headers.find(([name]) => name === 'x-upstream-error')?.[1], action);
      assertEquals(result.body.utf8(), '{"error":"upstream rejected the request"}');
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
      const input = azureInput(providerModel, { max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] });
      const messages = await callAzure(instance.pipelines.anthropicMessages, { ...input, 'request.anthropicBeta': ['context-1m'] });
      const count = await callAzure(instance.pipelines.anthropicMessagesCountTokens, { ...input, 'request.anthropicBeta': ['context-1m', 'advanced-tool-use'] });
      assertEquals(messages['response.modelKey'], 'claude-prod');
      assertEquals(count['response.modelKey'], 'claude-prod');
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

test('Azure image edits post multipart with the deployment model and api-version=preview', async () => {
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
      const result = await callAzure(provider.pipelines.openaiImagesEdits, azureInput(models[0], {
        parameters: { prompt: 'replace sky' },
        images: [{
          type: 'upload',
          bytes: Bytes.adopt(new Uint8Array([1, 2, 3])),
          filename: 'photo.png',
          contentType: 'image/png',
        }],
      }));
      assertEquals(result['response.modelKey'], 'gpt-image-2');
      assertEquals(result['response.http'].status, 200);
    },
  );
  assertEquals(observedUrl, 'https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  assertEquals(observedForm?.get('prompt'), 'replace sky');
  const image = observedForm?.get('image');
  assertExists(image);
  if (!(image instanceof File)) throw new Error('Expected multipart image file');
  assertEquals(image.name, 'photo.png');
  assertEquals(image.type, 'image/png');
  assertEquals(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]));
});
