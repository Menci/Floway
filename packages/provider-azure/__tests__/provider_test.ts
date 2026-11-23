import { test } from 'vitest';

import { azureInput, callAzure } from './pipeline-fixture.ts';
import { azurePipelines, toAzureUpstreamFacts } from '../src/index.ts';
import { createAzureProvider } from '../src/provider.ts';
import { Bytes, isSecret, type RunEvent } from '@floway-dev/pipeline';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, sseResponse, stubProviderModel, withMockedFetch } from '@floway-dev/test-utils';

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

test('Azure sends deployment ids in OpenAI-shaped request bodies and model keys', async () => {
  const record = azureRecord();
  const upstream = toAzureUpstreamFacts(record);
  const instance = createAzureProvider(record);
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<{ url: string; apiKey: string | null; body: Record<string, unknown> }> = [];
  const events: RunEvent[] = [];

  await withMockedFetch(
    async request => {
      assertEquals(request.method, 'POST');
      assertEquals([...request.headers.keys()], ['api-key', 'content-type']);
      assertEquals(request.headers.get('content-type'), 'application/json');
      seen.push({
        url: request.url,
        apiKey: request.headers.get('api-key'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return sseResponse();
    },
    async () => {
      const chat = await callAzure(
        azurePipelines.openaiChatCompletions,
        azureInput(upstream, providerModel, { messages: [{ role: 'user', content: 'hello' }] }, [
          ['API-Key', 'client-key'], ['authorization', 'client-token'], ['content-type', 'text/plain'], ['x-client-header', 'client-value'],
        ]),
        directFetcher,
        event => events.push(event),
      );
      const responses = await callAzure(azurePipelines.openaiResponses, {
        ...azureInput(upstream, providerModel, {
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
      const embeddings = await callAzure(azurePipelines.openaiEmbeddings, azureInput(upstream, providerModel, { input: 'hello' }));

      assertEquals(chat['response.modelKey'], 'gpt-prod');
      assertEquals(responses['response.modelKey'], 'gpt-prod');
      assertEquals(embeddings['response.modelKey'], 'gpt-prod');
      assertEquals(chat['response.openaiChatCompletions'].kind, 'stream');
      assertEquals(responses['response.openaiResponses'].kind, 'stream');
      assertEquals(embeddings['response.openaiEmbeddings'], { kind: 'ok' });
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
  assertEquals(seen.map(item => item.body.stream), [true, true, undefined]);
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

test.each(['generate', 'compact'] as const)('Azure Responses represents %s upstream errors as values', async action => {
  const record = azureRecord();
  const upstream = toAzureUpstreamFacts(record);
  const instance = createAzureProvider(record);
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const upstreamResponse = new Response('{"error":"upstream rejected the request"}', {
    status: 418,
    headers: { 'content-type': 'application/json', 'x-upstream-error': action },
  });

  await withMockedFetch(
    () => Promise.resolve(upstreamResponse),
    async () => {
      const result = await callAzure(azurePipelines.openaiResponses, {
        ...azureInput(upstream, providerModel, { input: [{ type: 'message', role: 'user', content: 'hello' }] }),
        'request.action': action,
      });
      assertEquals(result['response.openaiResponses'], {
        kind: 'error',
        source: 'upstream',
        error: { error: 'upstream rejected the request' },
      });
      assertEquals(result['response.modelKey'], 'gpt-prod');
      assertEquals(result['response.http'].status, 418);
      assertEquals(result['response.http'].headers.find(([name]) => name === 'x-upstream-error')?.[1], action);
    },
  );
});

test('Azure Responses compact sends the compact payload and returns its result', async () => {
  const upstream = toAzureUpstreamFacts(azureRecord());
  const model = stubProviderModel({ upstreamModelId: 'gpt-prod' });
  const compact = { id: 'compact_1', object: 'response.compaction', output: [] };
  const input = {
    ...azureInput(upstream, model, { input: [], instructions: 'Summarize', store: true, stream: true, temperature: 0.1 }),
    'request.action': 'compact' as const,
  };
  const events: RunEvent[] = [];
  await withMockedFetch(
    async request => {
      assertEquals(request.url, 'https://example.openai.azure.com/openai/v1/responses/compact');
      assertEquals(await request.json(), { model: 'gpt-prod', input: [], instructions: 'Summarize' });
      return jsonResponse(compact);
    },
    async () => {
      const result = await callAzure(azurePipelines.openaiResponses, input, directFetcher, event => events.push(event));
      assertEquals(result['response.openaiResponses'], { kind: 'result', result: compact });
    },
  );
  const build = events.find(event => event.k === 'enter' && event.name === 'buildRequest');
  if (build?.k !== 'enter') throw new Error('Expected request builder entry');
  assertEquals(Object.is(build.facts['request.payload'], input['request.payload']), true);
});

test('Azure returns upstream transport failure when the error body connection drops', async () => {
  const upstream = toAzureUpstreamFacts(azureRecord());
  const model = stubProviderModel({ upstreamModelId: 'gpt-prod' });
  const failure = new Error('connection reset');
  const response = new Response(new ReadableStream({ start: controller => controller.error(failure) }), { status: 503 });
  const result = await callAzure(azurePipelines.openaiEmbeddings, azureInput(upstream, model, { input: 'hello' }), async () => response);
  assertEquals(result['response.http'].status, 502);
  assertEquals(result['response.http'].transportError?.message, failure.message);
  assertEquals(result['response.openaiEmbeddings'], {
    kind: 'error',
    source: 'upstream',
    error: { error: { type: 'upstream_transport_error', message: failure.message } },
  });
});

test('Azure supports native Anthropic Messages models', async () => {
  const record = azureRecord({
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
  });
  const upstream = toAzureUpstreamFacts(record);
  const instance = createAzureProvider(record);
  const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
  const seen: Array<{ url: string; xApiKey: string | null; version: string | null; body: Record<string, unknown>; beta: string | null }> = [];

  assertEquals(providerModel.id, 'claude-public');
  assertEquals(providerModel.endpoints, { anthropicMessages: {} });

  await withMockedFetch(
    async request => {
      assertEquals([...request.headers.keys()], ['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key']);
      seen.push({
        url: request.url,
        xApiKey: request.headers.get('x-api-key'),
        version: request.headers.get('anthropic-version'),
        body: (await request.json()) as Record<string, unknown>,
        beta: request.headers.get('anthropic-beta'),
      });
      return request.url.endsWith('/count_tokens') ? jsonResponse({ input_tokens: 5 }) : sseResponse();
    },
    async () => {
      const input = azureInput(upstream, providerModel, { max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] }, [
        ['anthropic-version', 'client-version'], ['anthropic-beta', 'client-beta'], ['api-key', 'client-key'], ['x-api-key', 'client-key'],
      ]);
      const messages = await callAzure(azurePipelines.anthropicMessages, { ...input, 'request.anthropicBeta': ['context-1m'] });
      const count = await callAzure(azurePipelines.anthropicMessagesCountTokens, { ...input, 'request.anthropicBeta': ['context-1m', 'advanced-tool-use'] });
      assertEquals(messages['response.modelKey'], 'claude-prod');
      assertEquals(count['response.modelKey'], 'claude-prod');
      assertEquals(messages['response.anthropicMessages'].kind, 'stream');
      assertEquals(count['response.anthropicMessagesCountTokens'], { kind: 'ok' });
      assertEquals(count.body.utf8(), '{"input_tokens":5}');
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
      const result = await callAzure(azurePipelines.openaiImagesEdits, azureInput(toAzureUpstreamFacts(record), models[0], {
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
      assertEquals(result['response.openaiImagesEdits'], { kind: 'ok' });
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
