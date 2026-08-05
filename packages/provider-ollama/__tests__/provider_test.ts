import { test } from 'vitest';

import { createOllamaProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, noopMessagesUpstreamCallOptions, noopUpstreamCallOptions, withMockedFetch } from '@floway-dev/test-utils';

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_ollama',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: { baseUrl: 'https://ollama.com', apiKey: 'ollama_test' },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
  ...overrides,
});

const tagsAndShow = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (url.pathname === '/api/tags') {
    return jsonResponse({
      models: [
        { name: 'gpt-oss:120b', modified_at: '2025-08-05T00:00:00Z' },
        { name: 'nomic-embed-text:latest', modified_at: '2025-04-01T00:00:00Z' },
      ],
    });
  }
  if (url.pathname === '/api/show') {
    const body = await request.json() as { name?: string };
    if (body.name === 'gpt-oss:120b') {
      return jsonResponse({
        capabilities: ['completion', 'tools', 'thinking'],
        details: { family: 'gptoss' },
        model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
      });
    }
    if (body.name === 'nomic-embed-text:latest') {
      return jsonResponse({
        capabilities: ['embedding'],
        details: { family: 'nomic-bert' },
        model_info: { 'general.architecture': 'nomic-bert', 'nomic-bert.context_length': 8192 },
      });
    }
    return new Response('not found', { status: 404 });
  }
  return new Response('unexpected', { status: 500 });
};

test('getProvidedModels surfaces chat models with all three OpenAI/Anthropic-compat endpoints', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(directFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.kind, 'chat');
    assertEquals(Object.keys(gptoss.endpoints).sort(), ['chatCompletions', 'completions', 'messages', 'responses']);
    assertEquals(gptoss.owned_by, 'ollama');
    assertEquals(gptoss.limits.max_context_window_tokens, 131072);
    // OLLAMA_MODEL_PRICING covers gpt-oss:120b, so pricing flows through into
    // the ProviderModel on the auto path.
    assertEquals(gptoss.pricing?.entries[0]?.rates.input_tokens, '0.00000015');
    assertEquals(gptoss.pricing?.entries[0]?.rates.output_tokens, '0.0000006');
  });
});

test('getProvidedModels routes embedding-capability models to kind=embedding with only the embeddings endpoint', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(directFetcher);
    const embed = models.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.kind, 'embedding');
    assertEquals(Object.keys(embed.endpoints), ['embeddings']);
  });
});

test('getProvidedModels merges manual overrides in front of auto-fetched models and drops the auto duplicate', async () => {
  const instance = createOllamaProvider(buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{
        upstreamModelId: 'gpt-oss:120b',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
        display_name: 'Pinned 120B',
        pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] },
      }],
    },
  }));
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(directFetcher);
    // Manual entry appears first; the auto duplicate is filtered out so the
    // public id resolves to the manual entry's narrower endpoints map.
    assertEquals(models[0].id, 'gpt-oss:120b');
    assertEquals(models[0].display_name, 'Pinned 120B');
    assertEquals(Object.keys(models[0].endpoints), ['chatCompletions']);
    assertEquals(models[0].pricing, { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] });
    // No duplicate gpt-oss:120b further down.
    assertEquals(models.filter(m => m.id === 'gpt-oss:120b').length, 1);
  });
});

test('manual known models inherit built-in pricing when no override is configured', async () => {
  const instance = createOllamaProvider(buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{
        upstreamModelId: 'deepseek-v4-flash',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
      }],
    },
  }));
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(directFetcher);
    assertEquals(models.find(model => model.id === 'deepseek-v4-flash')?.pricing?.entries[0]?.rates.input_tokens, '0.00000014');
  });
});

test('manual transcription models call Ollama without auto-advertising the endpoint', async () => {
  const instance = createOllamaProvider(buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{ upstreamModelId: 'qwen-audio:latest', kind: 'transcription', endpoints: { audioTranscriptions: {} } }],
    },
  }));
  let transcription: Request | undefined;
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/tags') return jsonResponse({ models: [] });
      if (path === '/v1/audio/transcriptions') {
        transcription = request;
        return jsonResponse({ text: 'hello' });
      }
      throw new Error(`unexpected request ${request.url}`);
    },
    async () => {
      const models = await instance.instance.getProvidedModels(directFetcher);
      assertEquals(models.map(model => model.kind), ['transcription']);
      await instance.instance.callAudioTranscriptions(models[0], {
        entries: [
          { name: 'file', value: new File(['audio'], 'clip.wav', { type: 'audio/wav' }) },
          { name: 'model', value: 'public-model' },
        ],
      }, undefined, noopUpstreamCallOptions());
    },
  );
  assertExists(transcription);
  const form = await transcription.formData();
  assertEquals(form.get('model'), 'qwen-audio:latest');
  assertEquals(transcription.headers.get('authorization'), 'Bearer ollama_test');
});

test('call* methods POST to /v1/<endpoint> with the upstream model id and Bearer header', async () => {
  const instance = createOllamaProvider(buildRecord());
  let chatRequest: Request | null = null;
  let chatBody: unknown = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/api/tags') {
        return jsonResponse({ models: [{ name: 'gpt-oss:120b' }] });
      }
      if (url.pathname === '/api/show') {
        return jsonResponse({
          capabilities: ['completion'],
          details: { family: 'gptoss' },
          model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
        });
      }
      if (url.pathname === '/v1/chat/completions') {
        chatRequest = request;
        chatBody = await request.json();
        // SSE response so streamingProviderCall does not throw on the empty
        // body — we only assert the request shape.
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      const [providerModel] = await instance.instance.getProvidedModels(directFetcher);
      const result = await instance.instance.callChatCompletions(
        providerModel,
        { messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        noopUpstreamCallOptions({ fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall }),
      );
      assertEquals(result.modelKey, 'gpt-oss:120b');
    },
  );

  assertEquals(chatRequest!.url, 'https://ollama.com/v1/chat/completions');
  assertEquals(chatRequest!.headers.get('Authorization'), 'Bearer ollama_test');
  const body = chatBody as { model: string; stream: boolean };
  assertEquals(body.model, 'gpt-oss:120b');
  assertEquals(body.stream, true);
});

test('Messages methods serialize typed anthropic-beta metadata only on Messages wire calls', async () => {
  const instance = createOllamaProvider(buildRecord());
  const betas: Record<string, string | null> = {};

  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/api/tags') return jsonResponse({ models: [{ name: 'gpt-oss:120b' }] });
      if (path === '/api/show') {
        return jsonResponse({
          capabilities: ['completion'],
          details: { family: 'gptoss' },
          model_info: { 'general.architecture': 'gptoss', 'gptoss.context_length': 131072 },
        });
      }
      betas[path] = request.headers.get('anthropic-beta');
      if (path === '/v1/messages') {
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 1 });
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const [model] = await instance.instance.getProvidedModels(directFetcher);
      const opts = noopMessagesUpstreamCallOptions({ anthropicBeta: ['context-1m', 'advanced-tool-use'] });
      await instance.instance.callMessages(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
      await instance.instance.callMessagesCountTokens(model, { max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, undefined, opts);
    },
  );

  assertEquals(betas, {
    '/v1/messages': 'context-1m,advanced-tool-use',
    '/v1/messages/count_tokens': 'context-1m,advanced-tool-use',
  });
});

test('getProvidedModels populates chat from capabilities: gpt-oss thinking → effort, vision → modalities', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(directFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.chat, {
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
    });
    // Embedding model has no thinking/vision → no chat field.
    const embed = models.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.chat, undefined);
  });
});
