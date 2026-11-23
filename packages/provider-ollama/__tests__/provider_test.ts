import { expect, test, vi } from 'vitest';

import { callOllama, ollamaInput, ollamaServices } from './pipeline-fixture.ts';
import { createOllamaProvider, ollamaPipelines } from '../src/index.ts';
import { Bytes, isSecret, type RunEvent } from '@floway-dev/pipeline';
import { DEFAULT_DECISION_PATHS, parseDecisionRequest } from '@floway-dev/protocols/decision';
import { UpstreamTransportError, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, sseResponse, stubProviderModel, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const buildRecord = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_ollama',
  kind: 'ollama',
  name: 'Ollama',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
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

test('getProvidedModels projects chat and embedding models from their capabilities', async () => {
  const instance = createOllamaProvider(buildRecord());
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    const gptoss = models.find(m => m.id === 'gpt-oss:120b')!;
    assertEquals(gptoss.kind, 'chat');
    assertEquals(Object.keys(gptoss.endpoints).sort(), ['anthropicMessages', 'openaiChatCompletions', 'openaiCompletions', 'openaiResponses']);
    assertEquals(gptoss.limits.max_context_window_tokens, 131072);
    assertEquals(gptoss.opaqueBlobCompatibilityScope, { bindToUpstream: true });
    // OLLAMA_MODEL_PRICING covers gpt-oss:120b, so pricing flows through into
    // the ProviderModel on the auto path.
    assertEquals(gptoss.pricing?.entries[0]?.rates.input_tokens, '0.00000015');
    assertEquals(gptoss.pricing?.entries[0]?.rates.output_tokens, '0.0000006');
    const embed = models.find(m => m.id === 'nomic-embed-text:latest')!;
    assertEquals(embed.kind, 'embedding');
    assertEquals(Object.keys(embed.endpoints), ['openaiEmbeddings']);
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
        endpoints: { openaiChatCompletions: {} },
        display_name: 'Pinned 120B',
        chat: { image_detail_original: true },
        pricing: { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] },
      }],
    },
  }));
  await withMockedFetch(tagsAndShow, async () => {
    const models = await instance.instance.getProvidedModels(testFetcher);
    // Manual entry appears first; the auto duplicate is filtered out so the
    // public id resolves to the manual entry's narrower endpoints map.
    assertEquals(models[0].id, 'gpt-oss:120b');
    assertEquals(models[0].display_name, 'Pinned 120B');
    assertEquals(Object.keys(models[0].endpoints), ['openaiChatCompletions']);
    assertEquals(models[0].chat, { image_detail_original: true });
    assertEquals(models[0].opaqueBlobCompatibilityScope, { bindToUpstream: true });
    assertEquals(models[0].pricing, { entries: [{ rates: { input_tokens: '99', output_tokens: '99' } }] });
    // No duplicate gpt-oss:120b further down.
    assertEquals(models.filter(m => m.id === 'gpt-oss:120b').length, 1);
  });
});

test('manual transcription models call Ollama without auto-advertising the endpoint', async () => {
  const record = buildRecord({
    config: {
      baseUrl: 'https://ollama.com',
      apiKey: 'ollama_test',
      models: [{ upstreamModelId: 'qwen-audio:latest', kind: 'chat', endpoints: { openaiAudioTranscriptions: {} }, chat: { image_detail_original: true } }],
    },
  });
  const instance = createOllamaProvider(record);
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
      const models = await instance.instance.getProvidedModels(testFetcher);
      assertEquals(models.map(model => model.kind), ['transcription']);
      assertEquals(models[0]?.chat, undefined);
      const result = await callOllama(ollamaPipelines.openaiAudioTranscriptions, ollamaInput(record, models[0], {
        entries: [
          { kind: 'file', name: 'file', bytes: Bytes.fromUtf8('audio'), filename: 'clip.wav', contentType: 'audio/wav' },
          { kind: 'text', name: 'model', value: 'public-model' },
        ],
      }));
      expect(result['response.openaiAudioTranscriptions']).toEqual({ kind: 'ok' });
    },
  );
  assertExists(transcription);
  const form = await transcription.formData();
  assertEquals(form.get('model'), 'qwen-audio:latest');
  assertEquals(transcription.headers.get('authorization'), 'Bearer ollama_test');
  const file = form.get('file');
  if (!(file instanceof File)) throw new Error('Expected multipart audio file');
  assertEquals(file.name, 'clip.wav');
  assertEquals(file.type, 'audio/wav');
  assertEquals(await file.text(), 'audio');
});

test('the chat pipeline posts the upstream model ID and bearer header', async () => {
  const record = buildRecord();
  const instance = createOllamaProvider(record);
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
        return sseResponse();
      }
      return new Response('unexpected', { status: 500 });
    },
    async () => {
      const [providerModel] = await instance.instance.getProvidedModels(testFetcher);
      const input = ollamaInput(record, providerModel, { messages: [{ role: 'user' as const, content: 'hi' }], max_completion_tokens: 32000 }, [
        ['authorization', 'Bearer client-key'],
        ['content-type', 'text/plain'],
        ['anthropic-version', 'client-version'],
        ['anthropic-beta', 'client-beta'],
        ['x-client-header', 'client-value'],
      ]);
      expect(isSecret(input['provider.upstream'].config.apiKey)).toBe(true);
      expect(input['provider.upstream']).toEqual({
        id: record.id, kind: 'ollama', name: record.name,
        config: { baseUrl: 'https://ollama.com', apiKey: expect.any(Object), cloudUsage: false },
      });
      const result = await callOllama(
        ollamaPipelines.openaiChatCompletions,
        input,
      );
      assertEquals(result['response.modelKey'], 'gpt-oss:120b');
      expect(result['response.openaiChatCompletions'].kind).toBe('stream');
    },
  );

  assertEquals(chatRequest!.url, 'https://ollama.com/v1/chat/completions');
  assertEquals([...chatRequest!.headers], [['authorization', 'Bearer ollama_test'], ['content-type', 'application/json']]);
  const body = chatBody as { model: string; stream: boolean; max_tokens?: number; max_completion_tokens?: number };
  assertEquals(body.model, 'gpt-oss:120b');
  assertEquals(body.stream, true);
  // Ollama reads only `max_tokens` into `num_predict`.
  assertEquals(body.max_tokens, 32000);
  assertEquals('max_completion_tokens' in body, false);
});

test.each([
  { limits: { max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_tokens: null, max_completion_tokens: 128000 }, expected: { max_tokens: null, max_completion_tokens: 128000 } },
])('Ollama sends $expected for the requested output caps $limits', async ({ limits, expected }) => {
  const model = stubProviderModel({ upstreamModelId: 'gpt-oss:120b' });
  const messages = [{ role: 'user' as const, content: 'hi' }];
  let observed: unknown;
  await withMockedFetch(
    async request => {
      observed = await request.json();
      return sseResponse();
    },
    () => callOllama(ollamaPipelines.openaiChatCompletions, ollamaInput(buildRecord(), model, { messages, ...limits })),
  );
  assertEquals(observed, { messages, ...expected, stream: true, model: 'gpt-oss:120b' });
});

test.each([
  {
    response: () => { throw new UpstreamTransportError(new Error('socket disconnected')); },
    type: 'upstream_transport_error',
    message: 'socket disconnected',
  },
  {
    response: () => new Response('expected event stream'),
    type: 'upstream_invalid_stream',
    message: 'expected event stream',
  },
])('the chat pipeline returns $type as an upstream error value', async ({ response, type, message }) => {
  const result = await callOllama(
    ollamaPipelines.openaiChatCompletions,
    ollamaInput(buildRecord(), stubProviderModel(), { messages: [] }),
    ollamaServices(async () => response()),
  );
  expect(result['response.http'].status).toBe(502);
  expect(result['response.openaiChatCompletions']).toEqual({
    kind: 'error', source: 'upstream', error: { error: { type, message: expect.stringContaining(message) } },
  });
});

test('count-tokens sends provider-owned Anthropic headers and bypasses the probes', async () => {
  const probeAfterResponse = vi.fn(async () => ({}));
  const services = { ...ollamaServices(), ollama: { probeAfterResponse } };
  const model = stubProviderModel({ upstreamModelId: 'claude-upstream' });
  const input = {
    ...ollamaInput(buildRecord(), model, { messages: [], max_tokens: 32 }, [
      ['anthropic-version', 'client-version'],
      ['anthropic-beta', 'client-beta'],
      ['x-client-header', 'client-value'],
    ]),
    'request.anthropicBeta': ['beta-from-facts'],
  };
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/v1/messages/count_tokens');
    expect([...request.headers]).toEqual([
      ['anthropic-beta', 'beta-from-facts'], ['anthropic-version', '2023-06-01'],
      ['authorization', 'Bearer ollama_test'], ['content-type', 'application/json'],
    ]);
    expect(await request.json()).toEqual({ model: 'claude-upstream', messages: [], max_tokens: 32 });
    return Response.json({ input_tokens: 3 });
  }, async () => {
    const result = await callOllama(ollamaPipelines.anthropicMessagesCountTokens, input, services);
    expect(result['response.anthropicMessagesCountTokens']).toEqual({ kind: 'ok' });
    expect(result.body).toEqual({ ok: true, bytes: Bytes.fromUtf8('{"input_tokens":3}') });
  });
  expect(probeAfterResponse).not.toHaveBeenCalled();
});

test('decision returns the System One target and bypasses the probes', async () => {
  const probeAfterResponse = vi.fn(async () => ({}));
  const services = { ...ollamaServices(), ollama: { probeAfterResponse } };
  const target = { protocol: 'typesafe-systemone' } as const;
  const model = stubProviderModel({ upstreamModelId: 'jev-1.13', decisionTarget: target });
  const body = { model: 'public-model', state: 's', questions: { is_bug: { type: 'noul', instructions: 'Is it a bug?' } } };
  const input = ollamaInput(buildRecord(), model, parseDecisionRequest(target.protocol, body).request);
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe(DEFAULT_DECISION_PATHS[target.protocol]);
    expect(await request.json()).toEqual({ ...body, model: 'jev-1.13' });
    return Response.json({ answers: {} });
  }, async () => {
    const result = await callOllama(ollamaPipelines.decision, input, services);
    expect(result['response.decision']).toEqual({ kind: 'ok', target });
  });
  expect(probeAfterResponse).not.toHaveBeenCalled();
});

test.each([
  { action: 'generate', path: '/v1/responses', response: () => sseResponse(), kind: 'stream' },
  { action: 'compact', path: '/v1/responses/compact', response: () => Response.json({ output: [] }), kind: 'result' },
] as const)('Responses $action triggers probes at the correct point relative to parsing', async ({ action, path, response, kind }) => {
  const services = ollamaServices(async url => {
    expect(new URL(url).pathname).toBe(path);
    return response();
  });
  const events: RunEvent[] = [];
  const input = { ...ollamaInput(buildRecord(), stubProviderModel(), { input: [] }), 'request.action': action };
  const result = await callOllama(ollamaPipelines.openaiResponses, input, {
    ...services,
    ollama: { probeAfterResponse: async () => ({ usage: Promise.resolve({ persisted: true }) }) },
  }, event => events.push(event));
  expect(result['response.openaiResponses'].kind).toBe(kind);
  const parse = events.filter(event => event.k === 'enter').find(event => event.name === 'parseResponses');
  assertExists(parse);
  const parsed = events.find(event => event.k === 'leave' && event.stageId === parse.stageId);
  const probe = events.find(event => event.k === 'deferred' && event.name === 'ollama.usageProbe');
  assertExists(parsed);
  assertExists(probe);
  if (action === 'generate') expect(probe.seq).toBeGreaterThan(parsed.seq);
  else expect(probe.seq).toBeLessThan(parsed.seq);
  expect(events.filter(event => event.k === 'deferred')).toEqual([probe]);
});
