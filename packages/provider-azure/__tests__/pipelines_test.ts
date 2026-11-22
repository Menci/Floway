import { test } from 'vitest';

import { fillEmptyNamespaceDescriptions } from '../src/pipelines.ts';
import { createAzureProvider } from '../src/provider.ts';
import { createDumpEncoder, pipeline, runPipeline, secret, terminal } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import type { Fetcher, ProviderPipelineOpenAIResponsesInput, ProviderPipelineServices, ProviderModel, ProviderPipelines, UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, isReplayableBody, toProviderModelFacts } from '@floway-dev/provider';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

const testServices = (fetcher: Fetcher = directFetcher): ProviderPipelineServices => ({ fetcherFor: () => fetcher });

const requestBodyText = async (body: Parameters<Fetcher>[1]['body']): Promise<string> => {
  if (isReplayableBody(body)) return await new Response(body.open()).text();
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return '';
};

const model = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: 'public-model',
  upstreamModelId: 'upstream-model',
  limits: {},
  kind: 'chat',
  endpoints: { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {}, openaiEmbeddings: {}, openaiImagesGenerations: {}, openaiImagesEdits: {}, openaiAudioTranscriptions: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  enabledFlags: new Set(),
  ...overrides,
});

const record = (): UpstreamRecord => ({
  id: 'azure-test',
  kind: 'azure',
  name: 'Azure Test',
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'azure-secret-key',
    models: [{
      upstreamModelId: 'upstream-model',
      publicModelId: 'public-model',
      endpoints: { openaiCompletions: {}, openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {}, openaiEmbeddings: {}, openaiImagesGenerations: {}, openaiImagesEdits: {}, openaiAudioTranscriptions: {} },
    }],
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
});

const providerWithFetcher = (fetcher: Fetcher) => {
  const provider = createAzureProvider(record());
  const pipelines: ProviderPipelines | undefined = provider.pipelines;
  if (pipelines === undefined) throw new Error('Azure provider must expose pipelines');
  return { provider, pipelines: pipelines as ProviderPipelines & Required<Pick<ProviderPipelines, 'openaiCompletions' | 'openaiChatCompletions' | 'openaiResponses' | 'anthropicMessages' | 'anthropicMessagesCountTokens' | 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'openaiAudioTranscriptions' | 'decision'>>, services: testServices(fetcher) };
};

const readBytes = async (body: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> } | null): Promise<string> => {
  if (body === null) return '';
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const consumeOutcomeBody = async (body: { [Symbol.asyncIterator](): AsyncIterator<Uint8Array> } | null): Promise<void> => {
  await readBytes(body);
};

test('all Azure pipelines send the expected wire shape and carry the upstream model key', async () => {
  const seen: Array<{ url: string; method: string; headers: Headers; text: string }> = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    const text = await requestBodyText(init.body);
    seen.push({
      url,
      method: init.method ?? 'GET',
      headers,
      text,
    });
    return new URL(url).pathname.endsWith('/responses/compact')
      ? new Response(JSON.stringify({ id: 'resp', object: 'response.compaction', output: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : sseResponse('data: [DONE]\n\n');
  };
  const { pipelines, services } = providerWithFetcher(fetcher);
  const m = toProviderModelFacts(model());

  const completions = await runPipeline(pipelines.openaiCompletions, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { prompt: 'hello' },
  }, { services });
  assertEquals(completions.modelKey, 'upstream-model');
  await consumeOutcomeBody(completions.body);

  const chat = await runPipeline(pipelines.openaiChatCompletions, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { messages: [{ role: 'user', content: 'hello' }] },
  }, { services });
  assertEquals(chat.ok, true);
  if (chat.ok) for await (const _frame of chat.events) continue;
  assertEquals(chat.modelKey, 'upstream-model');

  const responses = await runPipeline(pipelines.openaiResponses, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.action': 'generate',
    'request.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }] },
  }, { services });
  assertEquals(responses.action, 'generate');
  assertEquals(responses.ok, true);
  if (responses.action === 'generate' && responses.ok) for await (const _frame of responses.events) continue;

  const compact = await runPipeline(pipelines.openaiResponses, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.action': 'compact',
    'request.payload': { input: [{ type: 'message', role: 'user', content: 'compact me' }], tools: [{ type: 'function', name: 'ignored', parameters: {} }] },
  }, { services });
  assertEquals(compact.action, 'compact');
  assertEquals(compact.ok, true);
  if (compact.action !== 'compact' || !compact.ok) throw new Error('expected compact success');
  assertEquals(compact.modelKey, 'upstream-model');

  const anthropic = await runPipeline(pipelines.anthropicMessages, {
    'provider.model': m,
    'request.inboundHeaders': [['x-api-key', secret('inbound-key')], ['anthropic-version', 'inbound-version'], ['anthropic-beta', 'inbound-beta']],
    'request.anthropicBeta': ['beta-one', '', 'beta-two'],
    'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
  }, { services });
  assertEquals(anthropic.ok, true);
  if (anthropic.ok) for await (const _frame of anthropic.events) continue;

  const count = await runPipeline(pipelines.anthropicMessagesCountTokens, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.anthropicBeta': [],
    'request.payload': { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] },
  }, { services });
  assertEquals(count.modelKey, 'upstream-model');
  await consumeOutcomeBody(count.body);

  const embeddings = await runPipeline(pipelines.openaiEmbeddings, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { input: 'hello' },
  }, { services });
  assertEquals(embeddings.modelKey, 'upstream-model');
  await consumeOutcomeBody(embeddings.body);

  const images = await runPipeline(pipelines.openaiImagesGenerations, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { prompt: 'hello' },
  }, { services });
  assertEquals(images.modelKey, 'upstream-model');
  await consumeOutcomeBody(images.body);

  const edits = await runPipeline(pipelines.openaiImagesEdits, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { parameters: { prompt: 'edit' }, images: [{ type: 'upload', bytes: new Uint8Array([1]), filename: 'x.png', contentType: 'image/png' }] },
  }, { services });
  assertEquals(edits.modelKey, 'upstream-model');
  await consumeOutcomeBody(edits.body);

  const audio = await runPipeline(pipelines.openaiAudioTranscriptions, {
    'provider.model': m,
    'request.inboundHeaders': [],
    'request.payload': { entries: [{ kind: 'file', name: 'file', bytes: new Uint8Array([1]), filename: 'x.wav', contentType: 'audio/wav' }] },
  }, { services });
  assertEquals(audio.modelKey, 'upstream-model');
  await consumeOutcomeBody(audio.body);

  const decisionModel = model({ kind: 'decision', endpoints: { decision: {} }, id: 'decision-public', upstreamModelId: 'decision-raw', decisionTarget: { protocol: 'typesafe-systemone' } });
  const decision = await runPipeline(pipelines.decision, {
    'provider.model': toProviderModelFacts(decisionModel),
    'request.inboundHeaders': [],
    'request.payload': { sourceProtocol: 'typesafe-systemone', raw: { model: 'client-model', state: { kind: 'text', value: 'x' }, questions: [] }, state: { kind: 'text', value: 'x' }, questions: [] },
  }, { services });
  assertEquals(decision.modelKey, 'decision-raw');
  assertEquals(decision.target.protocol, 'typesafe-systemone');
  assertEquals(decision.http.status, 200);
  await consumeOutcomeBody(decision.http.body);

  assertEquals(seen.length, 11);
  assertEquals(seen[0]?.url, 'https://example.openai.azure.com/openai/v1/completions');
  assertEquals(seen[1]?.url, 'https://example.openai.azure.com/openai/v1/chat/completions');
  assertEquals(seen[2]?.url, 'https://example.openai.azure.com/openai/v1/responses');
  assertEquals(seen[3]?.url, 'https://example.openai.azure.com/openai/v1/responses/compact');
  assertEquals(seen[4]?.url, 'https://example.services.ai.azure.com/anthropic/v1/messages');
  assertEquals(seen[5]?.url, 'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens');
  assertEquals(seen[6]?.url, 'https://example.openai.azure.com/openai/v1/embeddings');
  assertEquals(seen[7]?.url, 'https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
  assertEquals(seen[8]?.url, 'https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
  assertEquals(seen[9]?.url, 'https://example.openai.azure.com/openai/deployments/upstream-model/audio/transcriptions?api-version=2025-04-01-preview');
  assertEquals(seen[10]?.url, 'https://example.openai.azure.com/v1/systemone');
  assertEquals(seen.map(item => item.headers.get('content-type')?.startsWith('multipart/form-data') === true
    ? /name="model"\r\n\r\n([^\r]+)\r\n/.exec(item.text)?.[1]
    : JSON.parse(item.text).model), ['upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', 'upstream-model', undefined, 'decision-raw']);
  assertEquals(seen[5]?.headers.get('x-api-key'), 'azure-secret-key');
  assertEquals(seen[5]?.headers.get('anthropic-version'), '2023-06-01');
  assertEquals(seen[4]?.headers.get('x-api-key'), 'inbound-key');
  assertEquals(seen[4]?.headers.get('anthropic-version'), 'inbound-version');
  assertEquals(seen[4]?.headers.get('anthropic-beta'), 'beta-one,beta-two');
  assertEquals(seen[0]?.headers.get('api-key'), 'azure-secret-key');
});

test('fillEmptyNamespaceDescriptions keeps frozen input unchanged and fills only empty namespace descriptions', async () => {
  const payload = Object.freeze({
    input: Object.freeze([Object.freeze({
      type: 'additional_tools' as const,
      role: 'developer' as const,
      tools: Object.freeze([Object.freeze({ type: 'namespace' as const, name: 'functions', description: '', tools: Object.freeze([]) })]),
    })]),
  });
  const capture = pipeline<ProviderPipelineOpenAIResponsesInput>('capture')
    .use(fillEmptyNamespaceDescriptions)
    .end(terminal<ProviderPipelineOpenAIResponsesInput, ProviderPipelineOpenAIResponsesInput, ProviderPipelineServices>({
      name: 'capture-ending',
      execute: async facts => facts,
    }));
  const observed = await runPipeline(capture, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.action': 'generate',
    'request.payload': payload as never,
  }, { services: testServices() });
  assertEquals(payload.input[0]?.tools[0]?.description, '');
  assertEquals((observed['request.payload'] as unknown as typeof payload).input[0]?.tools[0]?.description, 'Tools in the functions namespace.');

  const topLevel = Object.freeze({
    input: Object.freeze([]),
    tools: Object.freeze([Object.freeze({ type: 'namespace' as const, name: 'billing', description: '', tools: Object.freeze([]) })]),
  });
  const topLevelResult = await runPipeline(capture, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.action': 'generate',
    'request.payload': topLevel as never,
  }, { services: testServices() });
  assertEquals(topLevel.tools[0]?.description, '');
  assertEquals((topLevelResult['request.payload'] as unknown as typeof topLevel).tools[0]?.description, 'Tools in the billing namespace.');

  const filled = Object.freeze({
    input: Object.freeze([Object.freeze({
      type: 'additional_tools' as const,
      role: 'developer' as const,
      tools: Object.freeze([Object.freeze({ type: 'namespace' as const, name: 'functions', description: 'Already documented.', tools: Object.freeze([]) })]),
    })]),
  });
  const unchanged = await runPipeline(capture, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.action': 'generate',
    'request.payload': filled as never,
  }, { services: testServices() });
  assertEquals(unchanged['request.payload'], filled);
});

test('pipeline requests keep multipart-shaped edits and audio bodies on the wire', async () => {
  const bodies: string[] = [];
  const { pipelines, services } = providerWithFetcher(async (_url, init) => {
    bodies.push(await requestBodyText(init.body));
    return new Response(null, { status: 204 });
  });
  await runPipeline(pipelines.openaiImagesEdits, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.payload': { parameters: { prompt: 'edit' }, images: [{ type: 'upload', bytes: new Uint8Array([1]), filename: 'x.png', contentType: 'image/png' }] },
  }, { services });
  await runPipeline(pipelines.openaiAudioTranscriptions, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.payload': { entries: [{ kind: 'file', name: 'file', bytes: new Uint8Array([1]), filename: 'x.wav', contentType: 'audio/wav' }] },
  }, { services });
  assertEquals(bodies[0]?.includes('name="image"'), true);
  assertEquals(bodies[0]?.includes('name="model"'), true);
  assertEquals(bodies[1]?.includes('name="file"'), true);
  assertEquals(bodies[1]?.includes('name="model"'), false);
});

test('pipeline dump encoding redacts the configured API key while the fetcher receives it', async () => {
  let seenKey = '';
  const { pipelines } = providerWithFetcher(async (_url, init) => {
    seenKey = new Headers(init.headers).get('api-key') ?? '';
    return new Response('{}', { status: 200 });
  });
  const encoder = createDumpEncoder({ detectRawSecretLeaks: true });
  const events: unknown[] = [];
  const traceSink: RunTraceSink = {
    push: event => { events.push(...encoder.encodeBatch([event])); },
    registerSecretPlaintext: plaintext => encoder.registerSecretPlaintext(plaintext),
  };
  await runPipeline(pipelines.openaiEmbeddings, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.payload': { input: 'hello' },
  }, {
    services: testServices(async (_url, init) => {
      seenKey = new Headers(init.headers).get('api-key') ?? '';
      return new Response('{}', { status: 200 });
    }), traceSink,
  });
  assertEquals(seenKey, 'azure-secret-key');
  assertEquals(JSON.stringify(events).includes('azure-secret-key'), false);
});

test('compact non-2xx preserves the upstream body without leaking a stream', async () => {
  const { pipelines } = providerWithFetcher(async () => new Response('{"error":"compact rejected"}', { status: 503, headers: { 'content-type': 'application/json' } }));
  const result = await runPipeline(pipelines.openaiResponses, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.action': 'compact',
    'request.payload': { input: [{ type: 'message', role: 'user', content: 'hello' }] },
  }, { services: testServices(async () => new Response('{"error":"compact rejected"}', { status: 503, headers: { 'content-type': 'application/json' } })) });
  assertEquals(result.action, 'compact');
  assertEquals(result.ok, false);
  if (result.ok) throw new Error('expected compact failure');
  assertEquals(await readBytes(result.http.body), '{"error":"compact rejected"}');
});

test('streaming non-2xx preserves the upstream body without leaking a stream', async () => {
  const { pipelines } = providerWithFetcher(async () => new Response('rate limited', {
    status: 429,
    headers: { 'content-type': 'text/plain', 'x-upstream-error': 'rate_limit' },
  }));
  const result = await runPipeline(pipelines.openaiChatCompletions, {
    'provider.model': toProviderModelFacts(model()),
    'request.inboundHeaders': [],
    'request.payload': { messages: [{ role: 'user', content: 'hello' }] },
  }, {
    services: testServices(async () => new Response('rate limited', {
      status: 429,
      headers: { 'content-type': 'text/plain', 'x-upstream-error': 'rate_limit' },
    })),
  });
  assertEquals(result.ok, false);
  if (result.ok) throw new Error('expected chat failure');
  assertEquals(result.modelKey, 'upstream-model');
  assertEquals(result.http.status, 429);
  assertEquals(result.http.headers.find(([name]) => name === 'x-upstream-error')?.[1], 'rate_limit');
  assertEquals(await readBytes(result.http.body), 'rate limited');
});

test('decision requires an outbound target', async () => {
  const { pipelines } = providerWithFetcher(async () => Response.json({}));
  const caught = await runPipeline(pipelines.decision, {
    'provider.model': toProviderModelFacts(model({ kind: 'decision', endpoints: { decision: {} } })),
    'request.inboundHeaders': [],
    'request.payload': { sourceProtocol: 'typesafe-systemone', raw: {}, state: { kind: 'text', value: 'x' }, questions: [] },
  }, { services: testServices() }).catch(error => error);
  assertEquals(caught instanceof Error, true);
  assertEquals((caught as Error).message, 'Decision model public-model has no outbound target');
});
