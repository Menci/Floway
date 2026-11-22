import { expect, test } from 'vitest';

import { createCustomPipelines } from '../src/pipelines.ts';
import { createCustomProvider } from '../src/provider.ts';
import {
  createDumpDecoder,
  createDumpEncoder,
  isSecret,
  projectWireView,
  runPipeline,
  SecretLeakError,
  type RawRunEvent,
  type RunTraceSink,
} from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import {
  isReplayableBody,
  readManagedBytes,
  toProviderModelFacts,
  type Fetcher,
  type FetchInit,
  type HttpOutcome,
  type ProviderModel,
  type ProviderPipelineServices,
} from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, sseResponse } from '@floway-dev/test-utils';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const config = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: 'https://custom.example.com',
  apiKey: 'sk-provider-auth',
  endpoints: {},
  ingressHeadersRules: [],
  modelsFetch: { enabled: false, authStyle: 'bearer' as const },
  models: [],
  ...overrides,
});

const model = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: 'public-model',
  upstreamModelId: 'raw-model',
  limits: {},
  kind: 'chat',
  endpoints: { openaiChatCompletions: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  enabledFlags: new Set(),
  ...overrides,
});

const headers = (entries: readonly (readonly [string, string])[] = []) => entries;

const providerFacts = (modelValue: ProviderModel, inboundHeaders: readonly (readonly [string, string])[] = []) => ({
  'provider.model': toProviderModelFacts(modelValue),
  'request.inboundHeaders': inboundHeaders,
});

const services = (fetcher: Fetcher): ProviderPipelineServices => ({ fetcherFor: () => fetcher });

const drain = async (body: HttpOutcome['body']): Promise<string> => decoder.decode(await readManagedBytes(body));

const readBody = async (init: FetchInit): Promise<Record<string, unknown> | null> => {
  if (init.body === undefined) return null;
  const body = isReplayableBody(init.body) ? init.body.open() : init.body;
  return await new Response(body).json() as Record<string, unknown>;
};

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

const captureFetch = (respond: (request: Request) => Response | Promise<Response> = () => jsonResponse({ ok: true })) => {
  const requests: Request[] = [];
  const headerLines: Array<readonly (readonly [string, string])[]> = [];
  const fetcher: Fetcher = async (url, init) => {
    headerLines.push((init.headers ?? []) as readonly (readonly [string, string])[]);
    const body = isReplayableBody(init.body) ? init.body.open() : init.body;
    const request = new Request(url, { ...init, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
    requests.push(request);
    return await respond(request);
  };
  return { requests, headerLines, fetcher };
};

test('provider exposes all 14 pipelines and retains the provider instance', () => {
  const provider = createCustomProvider({
    id: 'up_custom_pipeline',
    kind: 'custom',
    name: 'Custom pipeline',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 0,
    createdAt: '2026-11-22T00:00:00.000Z',
    updatedAt: '2026-11-22T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: config(),
  });
  const expected = [
    'alphaSearch', 'openaiCompletions', 'openaiChatCompletions', 'openaiResponses',
    'anthropicMessages', 'anthropicMessagesCountTokens', 'geminiGenerateContent',
    'geminiGenerateContentCountTokens', 'openaiEmbeddings', 'openaiImagesGenerations',
    'openaiImagesEdits', 'openaiAudioTranscriptions', 'rerank', 'decision',
  ] as const;
  assertExists(provider.pipelines);
  for (const name of expected) assertExists(provider.pipelines[name]);
  assertExists(provider.instance.callAlphaSearch);
  assertEquals(provider.instance.getProvidedModels instanceof Function, true);
});

test('all non-streaming OpenAI-compatible pipelines use the expected paths, model ids, and auth', async () => {
  const { requests, fetcher } = captureFetch();
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const currentModel = model({ upstreamModelId: 'raw-public-model' });

  await drain((await runPipeline(pipelines.alphaSearch!, {
    ...providerFacts(currentModel), 'request.payload': { query: 'hello' },
  }, { services: services(fetcher) })).body);
  await drain((await runPipeline(pipelines.openaiCompletions!, {
    ...providerFacts(currentModel), 'request.payload': { prompt: 'hello' },
  }, { services: services(fetcher) })).body);
  await drain((await runPipeline(pipelines.openaiEmbeddings!, {
    ...providerFacts(currentModel), 'request.payload': { input: ['hello'] },
  }, { services: services(fetcher) })).body);
  await drain((await runPipeline(pipelines.openaiImagesGenerations!, {
    ...providerFacts(currentModel), 'request.payload': { prompt: 'image' },
  }, { services: services(fetcher) })).body);

  assertEquals(requests.map(request => new URL(request.url).pathname), [
    '/v1/alpha/search', '/v1/completions', '/v1/embeddings', '/v1/images/generations',
  ]);
  assertEquals(await readBody(requests[0]!), { query: 'hello', model: 'raw-public-model' });
  assertEquals(await readBody(requests[1]!), { prompt: 'hello', model: 'raw-public-model' });
  assertEquals(requests.map(request => request.headers.get('authorization')), [
    'Bearer sk-provider-auth', 'Bearer sk-provider-auth', 'Bearer sk-provider-auth', 'Bearer sk-provider-auth',
  ]);
});

test('OpenAI chat streaming exposes wire projection status and protocol frames through Dump V2', async () => {
  const streamBody = 'data: {"id":"chat-1","object":"chat.completion.chunk","created":1,"model":"raw-model","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const { requests, fetcher } = captureFetch(() => sseResponse(streamBody));
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const body = { messages: [{ role: 'user' as const, content: 'hello' }] };
  const dumpEncoder = createDumpEncoder({ detectRawSecretLeaks: true });
  const encoded: string[] = [];
  const traceSink: RunTraceSink = {
    push: event => {
      for (const item of dumpEncoder.encodeBatch([event])) encoded.push(`${JSON.stringify(item)}\n`);
    },
    registerSecretPlaintext: plaintext => dumpEncoder.registerSecretPlaintext(plaintext),
  };
  const outcome = await runPipeline(pipelines.openaiChatCompletions!, {
    ...providerFacts(model()), 'request.payload': body,
  }, { services: services(fetcher), traceSink });
  assertEquals(outcome.ok, true);
  if (!outcome.ok) throw new Error('expected chat stream');
  const frames = await collect(outcome.events);
  assertEquals(frames.map(frame => frame.type), ['event', 'done']);
  assertEquals(await readBody(requests[0]!), { messages: [{ role: 'user', content: 'hello' }], model: 'raw-model', stream: true });
  assertEquals(outcome.http.status, 200);

  const decoder = createDumpDecoder();
  const dumpModel = decoder.pushNdjsonChunk(encoded.join(''), { final: true });
  const wire = projectWireView(dumpModel);
  assertEquals(wire.upstreamAttempts[0]?.response?.status, 200);
  expect(wire.upstreamAttempts[0]?.response?.protocolFrames.length).toBeGreaterThan(0);
  assertEquals(wire.upstreamAttempts[0]?.response?.protocolFrames[0]?.value, {
    type: 'event',
    event: {
      id: 'chat-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'raw-model',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
    },
  });
});

test('OpenAI Responses generate streams and compact follows the response override with the compact shape', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({ pathOverrides: { '/responses': '/custom/responses' } }));
  const { requests, fetcher } = captureFetch(request => request.url.endsWith('/compact')
    ? jsonResponse({ id: 'compact-1', object: 'response.compaction', output: [] })
    : sseResponse());
  const generate = await runPipeline(pipelines.openaiResponses!, {
    ...providerFacts(model()), 'request.payload': { input: [] }, 'request.action': 'generate',
  }, { services: services(fetcher) });
  assertEquals(generate.action, 'generate');
  assertEquals(generate.ok, true);
  if (generate.action === 'generate' && generate.ok) await collect(generate.events);

  const compact = await runPipeline(pipelines.openaiResponses!, {
    ...providerFacts(model()),
    'request.payload': { input: [], tools: [], temperature: 1 },
    'request.action': 'compact',
  }, { services: services(fetcher) });
  assertEquals(compact.action, 'compact');
  assertEquals(compact.ok, true);
  if (compact.action === 'compact' && compact.ok) assertEquals(compact.result, { id: 'compact-1', object: 'response.compaction', output: [] });
  assertEquals(requests.map(request => new URL(request.url).pathname), ['/custom/responses', '/custom/responses/compact']);
  assertEquals(await readBody(requests[0]!), { input: [], model: 'raw-model', stream: true });
  assertEquals(await readBody(requests[1]!), { input: [], model: 'raw-model' });
});

test('Anthropic messages and count-token derive from the messages override and replace beta headers', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({ pathOverrides: { '/messages': '/anthropic/messages' } }));
  const { requests, fetcher } = captureFetch(request => request.url.endsWith('/count_tokens') ? jsonResponse({ input_tokens: 1 }) : sseResponse());
  const requestBody = { max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] };
  const messageOutcome = await runPipeline(pipelines.anthropicMessages!, {
    ...providerFacts(model()),
    'request.payload': requestBody,
    'request.anthropicBeta': ['context-1m', 'advanced-tool-use'],
  }, { services: services(fetcher) });
  assertEquals(messageOutcome.ok, true);
  if (messageOutcome.ok) await collect(messageOutcome.events);
  const countOutcome = await runPipeline(pipelines.anthropicMessagesCountTokens!, {
    ...providerFacts(model()),
    'request.payload': requestBody,
    'request.anthropicBeta': ['context-1m'],
  }, { services: services(fetcher) });
  await drain(countOutcome.body);
  assertEquals(requests.map(request => new URL(request.url).pathname), ['/anthropic/messages', '/anthropic/messages/count_tokens']);
  assertEquals(await readBody(requests[0]!), { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'raw-model', stream: true });
  assertEquals(await readBody(requests[1]!), { max_tokens: 16, messages: [{ role: 'user', content: 'hello' }], model: 'raw-model' });
  assertEquals(requests[0]!.headers.get('x-api-key'), 'sk-provider-auth');
  assertEquals(requests[0]!.headers.get('anthropic-version'), '2023-06-01');
  assertEquals(requests[0]!.headers.get('anthropic-beta'), 'context-1m,advanced-tool-use');
  assertEquals(requests[1]!.headers.get('anthropic-beta'), 'context-1m');
});

test('Gemini strips models/ from the path and wraps countTokens in generateContentRequest', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({ pathOverrides: { '/v1beta/models': '/gemini/models' } }));
  const { requests, fetcher } = captureFetch(request => request.url.includes(':streamGenerateContent') ? sseResponse() : jsonResponse({ totalTokens: 2 }));
  const geminiModel = model({ upstreamModelId: 'models/gemini-3-flash' });
  const generate = await runPipeline(pipelines.geminiGenerateContent!, {
    ...providerFacts(geminiModel),
    'request.payload': { contents: [], generationConfig: { temperature: 0.2 } },
    'request.action': 'generate',
  }, { services: services(fetcher) });
  assertEquals(generate.ok, true);
  if (generate.ok) await collect(generate.events);
  const count = await runPipeline(pipelines.geminiGenerateContentCountTokens!, {
    ...providerFacts(geminiModel),
    'request.payload': { contents: [], systemInstruction: { parts: [{ text: 'be brief' }] } },
    'request.action': 'countTokens',
  }, { services: services(fetcher) });
  await drain(count.body);
  assertEquals(requests[0]!.url, 'https://custom.example.com/gemini/models/gemini-3-flash:streamGenerateContent?alt=sse');
  assertEquals(requests[1]!.url, 'https://custom.example.com/gemini/models/gemini-3-flash:countTokens');
  assertEquals(await readBody(requests[0]!), { contents: [], generationConfig: { temperature: 0.2 } });
  assertEquals(await readBody(requests[1]!), { generateContentRequest: { contents: [], systemInstruction: { parts: [{ text: 'be brief' }] }, model: 'models/gemini-3-flash' } });
  assertEquals(requests[0]!.headers.get('x-goog-api-key'), 'sk-provider-auth');
  assertEquals(count.modelKey, 'gemini-3-flash');
});

test('image edits and audio transcription retain pure-data multipart bodies', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const { requests, fetcher } = captureFetch(request => jsonResponse(request.url.endsWith('/audio/transcriptions') ? { text: 'hello' } : { data: [] }));
  const editOutcome = await runPipeline(pipelines.openaiImagesEdits!, {
    ...providerFacts(model()),
    'request.payload': {
      images: [{ type: 'upload', bytes: encoder.encode('PNGDATA'), filename: 'in.png', contentType: 'image/png' }],
      parameters: { prompt: 'edit this' },
    },
  }, { services: services(fetcher) });
  await drain(editOutcome.body);
  const audioOutcome = await runPipeline(pipelines.openaiAudioTranscriptions!, {
    ...providerFacts(model()),
    'request.payload': {
      entries: [
        { kind: 'text', name: 'model', value: 'client-model' },
        { kind: 'file', name: 'file', bytes: encoder.encode('RIFFDATA'), filename: 'clip.wav', contentType: 'audio/wav' },
      ],
    },
  }, { services: services(fetcher) });
  await drain(audioOutcome.body);
  assertEquals(requests.map(request => new URL(request.url).pathname), ['/v1/images/edits', '/v1/audio/transcriptions']);
  expect(requests[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
  expect(requests[1]!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
  const editText = await requests[0]!.text();
  const audioText = await requests[1]!.text();
  expect(editText).toContain('PNGDATA');
  expect(editText).toContain('raw-model');
  expect(audioText).toContain('RIFFDATA');
  expect(audioText).toContain('raw-model');
  expect(audioText).not.toContain('client-model');
});

test('rerank and decision use model targets, raw model ids, and canonical paths', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const { requests, fetcher } = captureFetch();
  const rerankModel = model({ kind: 'rerank', upstreamModelId: 'raw-rerank', rerankTarget: { protocol: 'cohere-v2' } });
  const decisionModel = model({ kind: 'decision', upstreamModelId: 'raw-decision', decisionTarget: { protocol: 'openai-decisions' } });
  const rerank = await runPipeline(pipelines.rerank!, {
    ...providerFacts(rerankModel),
    'request.payload': parseRerankRequest('cohere-v1', { model: 'request-model', query: 'query', documents: ['document'] }).request,
  }, { services: services(fetcher) });
  await drain(rerank.http.body);
  const decision = await runPipeline(pipelines.decision!, {
    ...providerFacts(decisionModel),
    'request.payload': parseDecisionRequest('typesafe-systemone', {
      model: 'request-model',
      state: 'state',
      questions: { answer: { type: 'noul', criteria: { true: 'yes', false: 'no' } } },
    }).request,
  }, { services: services(fetcher) });
  await drain(decision.http.body);
  assertEquals(rerank.target, { protocol: 'cohere-v2' });
  assertEquals(decision.target, { protocol: 'openai-decisions' });
  assertEquals(rerank.modelKey, 'raw-rerank');
  assertEquals(decision.modelKey, 'raw-decision');
  assertEquals(requests.map(request => new URL(request.url).pathname), ['/v2/rerank', '/v1/decisions']);
  assertEquals((await readBody(requests[0]!))?.model, 'raw-rerank');
  assertEquals((await readBody(requests[1]!))?.model, 'raw-decision');
});

test('ingress rules preserve repeated values and caller lines replace matching auth names', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({
    ingressHeadersRules: [
      { key: 'x-route', value: 'first' },
      { key: 'x-route', value: null },
      { key: 'x-route', value: 'second' },
    ],
  }));
  const { headerLines, fetcher } = captureFetch();
  const outcome = await runPipeline(pipelines.openaiEmbeddings!, {
    ...providerFacts(model(), headers([['x-route', 'client-a'], ['x-route', 'client-b']])),
    'request.payload': { input: [] },
  }, { services: services(fetcher) });
  await drain(outcome.body);
  assertEquals(headerLines[0]!.filter(([name]) => name === 'x-route').map(([, value]) => value), [
    'first', 'client-a, client-b', 'second',
  ]);
  assertEquals(headerLines[0]!.find(([name]) => name === 'authorization')?.[1], 'Bearer sk-provider-auth');
});

test('a configured ingress header value replaces its base auth line', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({
    ingressHeadersRules: [{ key: 'x-api-key', value: 'vendor-key' }],
  }));
  const { requests, headerLines, fetcher } = captureFetch();
  const outcome = await runPipeline(pipelines.anthropicMessagesCountTokens!, {
    ...providerFacts(model()),
    'request.payload': { max_tokens: 1, messages: [] },
    'request.anthropicBeta': [],
  }, { services: services(fetcher) });
  await drain(outcome.body);
  assertEquals(requests[0]!.headers.get('x-api-key'), 'vendor-key');
  assertEquals(headerLines[0]!.find(([name]) => name === 'x-api-key')?.[1], 'vendor-key');
});

test('request facts wrap configured ingress values as secrets without collapsing repeated line order', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({
    ingressHeadersRules: [
      { key: 'x-route', value: 'first' },
      { key: 'x-route', value: null },
      { key: 'x-route', value: 'second' },
    ],
  }));
  const observed: RawRunEvent[] = [];
  const fetcher: Fetcher = async () => jsonResponse({ ok: true });
  const traceSink: RunTraceSink = { push: event => { observed.push(event); } };
  const outcome = await runPipeline(pipelines.openaiEmbeddings!, {
    ...providerFacts(model(), [['x-route', 'client-a'], ['x-route', 'client-b']]),
    'request.payload': { input: [] },
  }, { services: services(fetcher), traceSink });
  await drain(outcome.body);
  const terminalFacts = observed.find(event => event.k === 'enter' && event.tap === 'upstream');
  assertExists(terminalFacts);
  if (terminalFacts.k !== 'enter') throw new Error('expected terminal facts');
  const http = terminalFacts.facts['request.http'] as { readonly headers: readonly (readonly [string, unknown])[] };
  const routes = http.headers.filter(([name]) => name === 'x-route');
  assertEquals(routes.map(([, value]) => isSecret(value)), [true, false, true]);
  assertEquals(routes.map(([, value]) => isSecret(value) ? value.reveal() : value), ['first', 'client-a, client-b', 'second']);
});

test('compact failures retain the upstream response body for the serve layer', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const fetcher: Fetcher = async () => jsonResponse({ error: 'compact failed' }, 400);
  const outcome = await runPipeline(pipelines.openaiResponses!, {
    ...providerFacts(model()),
    'request.payload': { input: [] },
    'request.action': 'compact',
  }, { services: services(fetcher) });
  assertEquals(outcome.action, 'compact');
  assertEquals(outcome.ok, false);
  if (outcome.action !== 'compact' || outcome.ok) throw new Error('expected compact failure');
  assertEquals(outcome.modelKey, 'raw-model');
  assertEquals(JSON.parse(await drain(outcome.http.body)), { error: 'compact failed' });
});

test('dump encoding redacts auth, base URL query values, and configured ingress values while the fetcher sees plaintext', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config({
    baseUrl: 'https://proxy.example.com/v1?secret_token=top-secret-query',
    apiKey: 'provider-auth-secret',
    ingressHeadersRules: [{ key: 'x-custom-vendor-secret', value: 'super-secret-rule' }],
  }));
  const dumpEncoder = createDumpEncoder({ detectRawSecretLeaks: true });
  dumpEncoder.registerSecretPlaintext('provider-auth-secret');
  expect(() => dumpEncoder.encodeBatch([{
    k: 'run', seq: 1, tMs: 1, runId: 'leak-probe', pipelineName: 'leak-probe', startedAt: 1,
    meta: { leaked: 'provider-auth-secret' },
  }])).toThrow(SecretLeakError);
  const encoded: unknown[] = [];
  const traceSink: RunTraceSink = {
    push: (event: RawRunEvent) => { encoded.push(...dumpEncoder.encodeBatch([event])); },
    registerSecretPlaintext: plaintext => dumpEncoder.registerSecretPlaintext(plaintext),
  };
  let outboundUrl = '';
  let outboundHeaders: Headers | undefined;
  const fetcher: Fetcher = async (url, init) => {
    outboundUrl = url;
    outboundHeaders = new Headers(init.headers);
    return jsonResponse({ ok: true });
  };
  const outcome = await runPipeline(pipelines.openaiEmbeddings!, {
    ...providerFacts(model()), 'request.payload': { input: [] },
  }, { services: services(fetcher), traceSink });
  await drain(outcome.body);
  assertEquals(outboundUrl, 'https://proxy.example.com/v1/v1/embeddings?secret_token=top-secret-query');
  assertEquals(outboundHeaders?.get('authorization'), 'Bearer provider-auth-secret');
  assertEquals(outboundHeaders?.get('x-custom-vendor-secret'), 'super-secret-rule');
  const serialized = JSON.stringify(encoded);
  for (const plaintext of ['provider-auth-secret', 'top-secret-query', 'super-secret-rule']) {
    assertEquals(serialized.includes(plaintext), false);
  }
});

test('missing model targets fail loudly', async () => {
  const pipelines = createCustomPipelines('up_custom_pipeline', config());
  const { fetcher } = captureFetch();
  await runPipeline(pipelines.rerank!, {
    ...providerFacts(model({ kind: 'rerank' })),
    'request.payload': parseRerankRequest('cohere-v1', { model: 'request-model', query: 'q', documents: ['d'] }).request,
  }, { services: services(fetcher) }).then(
    () => { throw new Error('expected rerank failure'); },
    error => assertEquals((error as Error).message, 'Rerank model public-model has no outbound target'),
  );
  await runPipeline(pipelines.decision!, {
    ...providerFacts(model({ kind: 'decision' })),
    'request.payload': parseDecisionRequest('typesafe-systemone', {
      model: 'request-model',
      state: 's',
      questions: { answer: { type: 'noul', criteria: { true: 'yes', false: 'no' } } },
    }).request,
  }, { services: services(fetcher) }).then(
    () => { throw new Error('expected decision failure'); },
    error => assertEquals((error as Error).message, 'Decision model public-model has no outbound target'),
  );
});
