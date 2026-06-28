import { test } from 'vitest';

import { createOllamaProvider } from './provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_ollama',
  provider: 'ollama',
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
    const models = await instance.provider.getProvidedModels(directFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.kind, 'chat');
    assertEquals(Object.keys(gptoss.endpoints).sort(), ['chatCompletions', 'completions', 'messages', 'responses']);
    assertEquals(gptoss.owned_by, 'ollama');
    assertEquals(gptoss.limits.max_context_window_tokens, 131072);
    // OLLAMA_MODEL_PRICING covers gpt-oss:120b, so cost flows through into
    // the UpstreamModel on the auto path.
    assertEquals(gptoss.cost?.input, 0.15);
    assertEquals(gptoss.cost?.output, 0.6);
  });
});

test('getProvidedModels routes embedding-capability models to kind=embedding with only the embeddings endpoint', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.provider.getProvidedModels(directFetcher);
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
      }],
    },
  }));
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.provider.getProvidedModels(directFetcher);
    // Manual entry appears first; the auto duplicate is filtered out so the
    // public id resolves to the manual entry's narrower endpoints map.
    assertEquals(models[0].id, 'gpt-oss:120b');
    assertEquals(models[0].display_name, 'Pinned 120B');
    assertEquals(Object.keys(models[0].endpoints), ['chatCompletions']);
    // No duplicate gpt-oss:120b further down.
    assertEquals(models.filter(m => m.id === 'gpt-oss:120b').length, 1);
  });
});

test('getPricingForModelKey resolves manual cost first, then falls back to the OLLAMA_MODEL_PRICING table', () => {
  const instance = createOllamaProvider(buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{
        upstreamModelId: 'gpt-oss:120b',
        kind: 'chat',
        endpoints: { chatCompletions: {} },
        cost: { input: 99, output: 99 },
      }],
    },
  }));
  // Manual cost wins for the pinned id.
  assertEquals(instance.provider.getPricingForModelKey('gpt-oss:120b'), { input: 99, output: 99 });
  // Unpinned model falls back to the table.
  assertEquals(instance.provider.getPricingForModelKey('deepseek-v4-flash')?.input, 0.14);
  // Unknown model returns null rather than fabricating a guess.
  assertEquals(instance.provider.getPricingForModelKey('devstral-small-2:24b'), null);
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
      const [model] = await instance.provider.getProvidedModels(directFetcher);
      const result = await instance.provider.callChatCompletions(
        model,
        { messages: [{ role: 'user', content: 'hi' }] },
        undefined,
        { fetcher: directFetcher, recordUpstreamLatency: p => p, waitUntil: () => {}, headers: new Headers() },
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

test('getProvidedModels populates chat from capabilities: gpt-oss thinking → effort, vision → modalities', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.provider.getProvidedModels(directFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.chat, {
      reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
    });
    // Embedding model has no thinking/vision → no chat field.
    const embed = models.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.chat, undefined);
  });
});
