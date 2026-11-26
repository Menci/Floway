import { expect, test, vi } from 'vitest';

import { assertCustomUpstreamRecord, type CustomUpstreamConfig } from '../../src/config.ts';
import { customPipelines, fetchCustomModels, projectCustomModels, toCustomUpstream, type CustomUpstream } from '../../src/index.ts';
import { toRequestInit, UpstreamTransportError, type Fetcher, type FetchInit, type HttpHeaders } from '@floway-dev/http';
import { run, Secret, type Pipeline, type RunEvent } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import { parseRerankRequest } from '@floway-dev/protocols/rerank';
import { toProviderModelFact, type GatewayFacts, type ProviderModelFact, type ProviderOperation, type ProviderRequestFacts, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

const record = (overrides: Partial<CustomUpstreamConfig> = {}): UpstreamRecord => ({
  id: 'up_custom', name: 'Custom Upstream', kind: 'custom',
  enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
  state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  modelPrefix: null, modelsCache: null, hue: 210,
  config: {
    baseUrl: 'https://custom.example.com',
    apiKey: 'operator-key',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false, authStyle: 'bearer' },
    models: [{ upstreamModelId: 'private-model', publicModelId: 'public-model', endpoints: { openaiChatCompletions: {} } }],
    ...overrides,
  },
});

interface InputOptions {
  upstream?: UpstreamRecord;
  headers?: HttpHeaders;
  model?: Partial<ProviderModelFact>;
}

const input = <Op extends ProviderOperation>(
  operation: Op,
  payload: GatewayFacts[`request.${NoInfer<Op>}`],
  { upstream = record(), headers = [], model = {} }: InputOptions = {},
): ProviderRequestFacts<Op, CustomUpstream> => ({
  'request.http': { method: 'POST', url: 'https://gateway.example/v1/request', headers, body: new Uint8Array([99]) },
  'provider.upstream': toCustomUpstream(upstream),
  'provider.model': { ...toProviderModelFact(projectCustomModels(upstream)[0]), ...model },
  [`request.${operation}`]: payload,
}) as ProviderRequestFacts<Op, CustomUpstream>;

const invoke = <I, O>(handle: Pipeline<I, O, ProviderServices>, facts: NoInfer<I>, fetcher: Fetcher, observe?: (event: RunEvent) => void) => {
  const controller = new AbortController();
  const running = run(handle, facts, {
    signal: controller.signal,
    waitUntil: () => { throw new Error('Custom should not schedule a detached worker'); },
    services: {
      fetcher: upstreamId => {
        expect(upstreamId).toBe('up_custom');
        return async (url, init) => ({ response: await fetcher(url, init) });
      },
    },
    ...(observe !== undefined && { events: observe }),
  });
  return { ...running, [Symbol.dispose]: () => controller.abort() };
};

const requestOf = (url: string, init: FetchInit): Request => {
  if (!(init.body instanceof Uint8Array)) throw new Error('Expected serialized request bytes');
  return new Request(url, toRequestInit(init, new Uint8Array(init.body)));
};

const sse = (event: object) => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

test.each([
  { rules: [{ key: 'x-route', value: null }], values: [], expected: [] },
  { rules: [{ key: 'x-route', value: null }], values: ['a', 'b'], expected: ['a', 'b'] },
  { rules: [{ key: 'x-route', value: 'one' }, { key: 'x-route', value: null }], values: [], expected: ['one'] },
  { rules: [{ key: 'x-route', value: 'one' }, { key: 'x-route', value: null }], values: ['a', 'b'], expected: ['one', 'a', 'b'] },
  { rules: [{ key: 'x-route', value: '' }, { key: 'x-route', value: 'one' }], values: [], expected: ['', 'one'] },
  { rules: [{ key: 'x-route', value: '' }, { key: 'x-route', value: 'one' }], values: ['a', 'b'], expected: ['', 'one'] },
])('admission rebuilds x-route values by rule order: $expected', async ({ rules, values, expected }) => {
  const events: RunEvent[] = [];
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/v1/chat/completions');
    expect(init.headers).toEqual([
      ...expected.map(value => ['x-route', value]),
      ['authorization', 'Bearer operator-key'], ['content-type', 'application/json'],
    ]);
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-model', messages: [], stream: true });
    return sse({ choices: [] });
  });
  using running = invoke(customPipelines.openaiChatCompletions, input('openaiChatCompletions', { model: 'public-model', messages: [] }, {
    upstream: record({ ingressHeadersRules: rules }),
    headers: [...values.map((value): [string, string] => ['X-Route', value]), ['x-untouched', 'unused'], ['authorization', 'client-key'], ['content-type', 'client-type']],
  }), fetcher, event => events.push(event));
  const facts = await running.result;
  expect(facts['response.usageModelKey']).toBe('private-model');
  const outcome = facts['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: { choices: [] } }]);
  await running.done;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const terminal = events.find(event => event.type === 'stage.entered' && event.name === 'http');
  expect(terminal).toMatchObject({
    facts: {
      'request.http': {
        headers: [
          ...expected.map(value => ['x-route', value]),
          ['authorization', expect.any(Secret)],
          ['content-type', 'application/json'],
        ],
      },
    },
  });
});

test('Anthropic generation and count-tokens share path overrides and keep protocol beta values', async () => {
  const upstream = record({
    pathOverrides: { '/messages': '/api/v1/messages' },
    ingressHeadersRules: [{ key: 'anthropic-version', value: 'operator-version' }],
  });
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(init.headers).toEqual([
      ['anthropic-beta', 'one,two'], ['anthropic-version', 'operator-version'], ['x-api-key', 'operator-key'], ['content-type', 'application/json'],
    ]);
    const count = url.endsWith('/count_tokens');
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-model', messages: [], ...(!count && { max_tokens: 2, stream: true }),
    });
    return count ? Response.json({ input_tokens: 5 }) : sse({ type: 'message_stop' });
  });
  const options = { upstream, headers: [['anthropic-beta', 'one,two'], ['x-api-key', 'client-key'], ['anthropic-version', 'client-version']] satisfies HttpHeaders };
  using generation = invoke(customPipelines.anthropicMessages, input('anthropicMessages', { model: 'public-model', max_tokens: 2, messages: [] }, options), fetcher);
  const outcome = (await generation.result)['response.anthropicMessages'];
  if (outcome.kind !== 'stream') throw new Error('Expected Anthropic Messages stream');
  expect(await Array.fromAsync(generation.read(outcome.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
  using count = invoke(customPipelines.anthropicMessagesCountTokens, input('anthropicMessagesCountTokens', { model: 'public-model', messages: [] }, options), fetcher);
  expect((await count.result)['response.anthropicMessagesCountTokens']).toEqual({ kind: 'result', result: { input_tokens: 5 } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://custom.example.com/api/v1/messages',
    'https://custom.example.com/api/v1/messages/count_tokens',
  ]);
  await Promise.all([generation.done, count.done]);
});

test('catalog credentials use their own auth style and empty inference keys send no credentials', async () => {
  const configured = record({ modelsFetch: { enabled: true, authStyle: 'bearer', endpoint: '/catalog' } });
  const { config } = assertCustomUpstreamRecord(configured);
  const catalog = vi.fn<Fetcher>((_url, init) => {
    expect(init.headers).toEqual([['authorization', 'Bearer operator-key']]);
    return Promise.resolve(Response.json({ data: [] }));
  });
  expect(await fetchCustomModels(config, catalog)).toEqual({ data: [] });
  expect(catalog.mock.calls.map(([url]) => url)).toEqual(['https://custom.example.com/catalog']);

  const fetcher = vi.fn<Fetcher>((_url, init) => {
    expect(init.headers).toEqual([['content-type', 'application/json']]);
    return Promise.resolve(Response.json({ input_tokens: 0 }));
  });
  const upstream = record({ apiKey: '' });
  using running = invoke(customPipelines.anthropicMessagesCountTokens, input('anthropicMessagesCountTokens', { model: 'public-model', messages: [] }, { upstream }), fetcher);
  expect((await running.result)['response.anthropicMessagesCountTokens']).toEqual({ kind: 'result', result: { input_tokens: 0 } });
  await running.done;
});

test('Compact and Alpha Search use operator path overrides and preserve the original upstream error JSON', async () => {
  const upstream = record({ pathOverrides: { '/responses': '/res', '/alpha/search': '/search' } });
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    if (url.endsWith('/compact')) {
      expect(await requestOf(url, init).json()).toEqual({ model: 'private-model', input: [] });
      return Response.json({ id: 'compact', object: 'response.compaction', output: [] });
    }
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-model', query: 'example' });
    return Response.json({ err: { type: 'rate_limit' } }, { status: 429, headers: { 'retry-after': '5' } });
  });
  const compactPayload = { model: 'public-model', input: [], store: false, tools: [] };
  using compact = invoke(customPipelines.openaiResponsesCompact, input('openaiResponsesCompact', compactPayload, { upstream }), fetcher);
  expect((await compact.result)['response.openaiResponsesCompact']).toEqual({ kind: 'result', result: { id: 'compact', object: 'response.compaction', output: [] } });
  using search = invoke(customPipelines.alphaSearch, input('alphaSearch', { query: 'example' }, { upstream }), fetcher);
  expect(await search.result).toMatchObject({
    'response.http': { status: 429, statusText: '', headers: [['content-type', 'application/json'], ['retry-after', '5']], body: null },
    'response.alphaSearch': { kind: 'error', source: 'upstream', error: { err: { type: 'rate_limit' } } },
  });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://custom.example.com/res/compact', 'https://custom.example.com/search']);
  await Promise.all([compact.done, search.done]);
});

test('Gemini places its model in the path and preserves the full count-tokens envelope', async () => {
  const upstream = record({ baseUrl: 'https://custom.example.com/gemini', pathOverrides: { '/v1beta/models': '/models' } });
  const options = { upstream, model: { upstreamModelId: 'models/private model' } };
  const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];
  const event = { candidates: [{ finishReason: 'STOP' }] };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(init.headers).toEqual([['x-goog-api-key', 'operator-key'], ['content-type', 'application/json']]);
    const count = url.endsWith(':countTokens');
    expect(await requestOf(url, init).json()).toEqual(count
      ? { generateContentRequest: { contents, model: 'models/private model', systemInstruction: { parts: [{ text: 'system' }] } } }
      : { contents });
    return count ? Response.json({ totalTokens: 7 }) : sse(event);
  });
  using generate = invoke(customPipelines.geminiGenerateContent, input('geminiGenerateContent', { contents }, options), fetcher);
  const generated = await generate.result;
  expect(generated['response.usageModelKey']).toBe('private model');
  const outcome = generated['response.geminiGenerateContent'];
  if (outcome.kind !== 'stream') throw new Error('Expected Gemini stream');
  expect(await Array.fromAsync(generate.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  using count = invoke(customPipelines.geminiGenerateContentCountTokens, input('geminiGenerateContentCountTokens', {
    generateContentRequest: { model: 'models/public-model', contents, systemInstruction: { parts: [{ text: 'system' }] } },
  }, options), fetcher);
  expect(await count.result).toMatchObject({
    'response.usageModelKey': 'private model',
    'response.geminiGenerateContentCountTokens': { kind: 'result', result: { totalTokens: 7 } },
  });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://custom.example.com/gemini/models/private%20model:streamGenerateContent?alt=sse',
    'https://custom.example.com/gemini/models/private%20model:countTokens',
  ]);
  await Promise.all([generate.done, count.done]);
});

test.each([
  { source: 'cohere-v2' as const, body: '{ "results": [{ "index": 0, "relevance_score": 0.80 }], "extension": "kept" }', kind: 'result' },
  { source: 'cohere-v1' as const, body: '{"results":[{"index":0,"relevance_score":0.8}]}', kind: 'result' },
  { source: 'cohere-v2' as const, body: '{"unexpected":42}', kind: 'error' },
  { source: 'cohere-v2' as const, body: '{invalid-json', kind: 'error' },
  { source: 'cohere-v1' as const, body: '{"results":[{"index":1,"relevance_score":0.8}]}', kind: 'error', outOfRange: true },
  { source: 'cohere-v2' as const, body: '{"results":[{"index":1,"relevance_score":0.8}]}', kind: 'error', outOfRange: true },
])('Rerank $source result $kind follows the requested dialect', async ({ source, body, kind, outOfRange }) => {
  const request = parseRerankRequest(source, { model: 'public-model', query: 'query', documents: ['one'] }).request;
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/v2/rerank');
    expect(await requestOf(url, init).json()).toMatchObject({ model: 'private-model', query: 'query', documents: ['one'] });
    return new Response(body, { headers: { 'content-type': 'application/json', 'x-upstream': 'rerank' } });
  });
  using running = invoke(customPipelines.rerank, input('rerank', request, { model: { rerankTarget: { protocol: 'cohere-v2' } } }), fetcher);
  const response = await running.result;
  expect(response['response.http']).toMatchObject({ status: 200, headers: [['content-type', 'application/json'], ['x-upstream', 'rerank']], body: null });
  const outcome = response['response.rerank'];
  if (kind === 'error') {
    expect(outcome).toMatchObject({
      kind: 'error', source: 'upstream',
      ...(outOfRange && { error: { error: { message: expect.stringContaining('outside the request documents array') } } }),
    });
  } else if (source === 'cohere-v2') {
    expect(outcome).toEqual({ kind: 'result', result: new TextEncoder().encode(body) });
  } else {
    expect(outcome).toMatchObject({ kind: 'result', result: { results: [{ index: 0, relevanceScore: 0.8 }] } });
  }
  await running.done;
});

test('Decision decodes the chosen model dialect and honors an operator target path', async () => {
  const request = parseDecisionRequest('typesafe-systemone', {
    model: 'public-model', state: 'input', questions: { ok: { type: 'noul', criteria: { true: 'Yes' } } },
  }).request;
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/decision/route');
    expect(await requestOf(url, init).json()).toMatchObject({ model: 'private-model' });
    return Response.json({ answers: [{ name: 'ok', type: 'predicate', probability: 0.9 }], model: 'private-model' });
  });
  using running = invoke(customPipelines.decision, input('decision', request, {
    model: { decisionTarget: { protocol: 'openai-decisions', path: '/decision/route' } },
  }), fetcher);
  expect((await running.result)['response.decision']).toMatchObject({
    kind: 'result', result: { model: 'private-model', answers: [{ name: 'ok', type: 'noul', noul: 0.9 }] },
  });
  await running.done;
});

test('Audio Transcriptions keeps repeated multipart values and replaces the model field', async () => {
  const bytes = new Uint8Array([1, 2]);
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/v1/audio/transcriptions');
    const form = await requestOf(url, init).formData();
    expect(form.get('model')).toBe('private-model');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Expected audio file');
    expect(file).toMatchObject({ type: 'audio/ogg', name: 'clip.ogg' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return new Response('transcript');
  });
  using running = invoke(customPipelines.openaiAudioTranscriptions, input('openaiAudioTranscriptions', {
    entries: [
      { name: 'model', value: 'public-model' }, { name: 'file', value: { name: 'clip.ogg', mediaType: 'audio/ogg', bytes } },
      { name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' },
    ],
  }), fetcher);
  expect(await running.result).toMatchObject({
    'response.usageModelKey': 'private-model',
    'response.openaiAudioTranscriptions': { kind: 'result', result: new TextEncoder().encode('transcript') },
  });
  await running.done;
});

test('Images Edits JSON fallback encodes byte uploads alongside file references', async () => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/v1/images/edits');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-model',
      images: [{ image_url: 'data:image/png;base64,AQI=' }, { file_id: 'file_reference' }],
      prompt: 'example',
    });
    return Response.json({ data: [] });
  });
  using running = invoke(customPipelines.openaiImagesEdits, input('openaiImagesEdits', {
    images: [
      { type: 'upload', file: { name: 'image.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2]) } },
      { type: 'reference', reference: { file_id: 'file_reference' } },
    ],
    parameters: { prompt: 'example' },
  }), fetcher);
  expect((await running.result)['response.openaiImagesEdits']).toEqual({ kind: 'result', result: { data: [] } });
  await running.done;
});

test('Embeddings consumes a pre-header transport failure and publishes an upstream protocol error', async () => {
  const fetcher: Fetcher = () => Promise.reject(new UpstreamTransportError(new Error('connection reset')));
  using running = invoke(customPipelines.openaiEmbeddings, input('openaiEmbeddings', { model: 'public-model', input: 'example' }), fetcher);
  expect(await running.result).toEqual({
    'response.http': null,
    'response.usageModelKey': 'private-model',
    'response.openaiEmbeddings': { kind: 'error', source: 'upstream', error: { error: { type: 'server_error', message: 'connection reset' } } },
  });
  await running.done;
});

test('Gemini counts require a numeric token count even when the upstream returns 2xx', async () => {
  const fetcher: Fetcher = () => Promise.resolve(Response.json({ totalTokens: '7' }));
  using running = invoke(customPipelines.geminiGenerateContentCountTokens, input('geminiGenerateContentCountTokens', {
    contents: [{ parts: [{ text: 'sample' }] }],
  }), fetcher);
  expect(await running.result).toMatchObject({
    'response.http': { status: 200, body: null },
    'response.geminiGenerateContentCountTokens': { kind: 'error', source: 'upstream' },
  });
  await running.done;
});

test.each([
  { status: 503, body: 'temporarily unavailable', expected: { error: { code: 503, status: 'UNAVAILABLE', message: 'temporarily unavailable' } } },
  { status: 418, body: 'unrecognized status', expected: { error: { code: 500, status: 'INTERNAL', message: 'unrecognized status' } } },
  {
    status: 409,
    body: '{"error":{"code":409,"status":"ABORTED","message":"conflict","details":[{"reason":"race"}]}}',
    expected: { error: { code: 409, status: 'ABORTED', message: 'conflict', details: [{ reason: 'race' }] } },
  },
])('Gemini preserves the upstream HTTP status and handles the error body for $status', async ({ status, body, expected }) => {
  const fetcher: Fetcher = () => Promise.resolve(new Response(body, { status, headers: { 'x-upstream-error': 'gemini' } }));
  using running = invoke(customPipelines.geminiGenerateContent, input('geminiGenerateContent', { contents: [] }), fetcher);
  expect(await running.result).toMatchObject({
    'response.http': { status, body: null, headers: [['content-type', 'text/plain;charset=UTF-8'], ['x-upstream-error', 'gemini']] },
    'response.geminiGenerateContent': { kind: 'error', source: 'upstream', error: expected },
  });
  await running.done;
});

test('Responses Compact classifies a malformed upstream output item as an upstream error', async () => {
  const fetcher: Fetcher = () => Promise.resolve(Response.json({ id: 'compact', object: 'response.compaction', output: [null] }));
  using running = invoke(customPipelines.openaiResponsesCompact, input('openaiResponsesCompact', { model: 'public-model', input: [] }), fetcher);
  expect(await running.result).toMatchObject({
    'response.http': { status: 200, body: null },
    'response.openaiResponsesCompact': { kind: 'error', source: 'upstream' },
  });
  await running.done;
});

test.each(['audio', 'sse'])('Speech sends the selected %s representation to the configured path', async streamFormat => {
  const audio = new Uint8Array([0x52, 0x49, 0x46, 0x46]);
  const event = { type: 'speech.audio.delta', audio: 'UklGRg==' };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://custom.example.com/speech/voice');
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-model', input: 'Say hello', voice: 'alloy', stream_format: streamFormat, response_format: 'wav',
    });
    return streamFormat === 'sse' ? sse(event) : new Response(audio, { headers: { 'content-type': 'audio/wav' } });
  });
  const upstream = record({ pathOverrides: { '/audio/speech': '/speech/voice' } });
  using running = invoke(customPipelines.openaiAudioSpeech, input('openaiAudioSpeech', {
    model: 'public-model', input: 'Say hello', voice: 'alloy', stream_format: streamFormat, response_format: 'wav',
  }, { upstream }), fetcher);
  const outcome = (await running.result)['response.openaiAudioSpeech'];
  expect(outcome.kind).toBe(streamFormat === 'sse' ? 'stream' : 'result');
  if (outcome.kind === 'stream') {
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  } else if (outcome.kind === 'result') {
    expect(outcome.result).toEqual(audio);
  }
  await running.done;
});

test.each([
  { body: '{ "hits": [{"score": 0.90}] }', status: 200 },
  { body: '[]', status: 200 },
  { body: 'opaque upstream result', status: 200 },
  { body: null, status: 204 },
])('Alpha Search preserves the upstream bytes for body $body', async ({ body, status }) => {
  const fetcher: Fetcher = () => Promise.resolve(new Response(body, { status, headers: { 'content-type': 'application/json' } }));
  using running = invoke(customPipelines.alphaSearch, input('alphaSearch', { query: 'example' }), fetcher);
  const facts = await running.result;
  expect(Object.hasOwn(facts, 'response.usageModelKey')).toBe(false);
  expect(facts['response.http']).toMatchObject({ status, body: null, headers: [['content-type', 'application/json']] });
  expect(facts['response.alphaSearch']).toEqual({ kind: 'result', result: new TextEncoder().encode(body ?? '') });
  await running.done;
});

test('Images Edits respects the JSON stream field', async () => {
  const event = { type: 'image_edit.completed', b64_json: 'image' };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-model', prompt: 'example', stream: true, images: [{ file_id: 'image-file' }],
    });
    return sse(event);
  });
  using running = invoke(customPipelines.openaiImagesEdits, input('openaiImagesEdits', {
    parameters: { prompt: 'example', stream: true },
    images: [{ type: 'reference', reference: { file_id: 'image-file' } }],
  }), fetcher);
  const outcome = (await running.result)['response.openaiImagesEdits'];
  if (outcome.kind !== 'stream') throw new Error('Expected Images Edits stream');
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  await running.done;
});

test.each([
  { flag: 'vendor-deepseek' as const, wire: { thinking: { type: 'disabled' } } },
  { flag: 'vendor-qwen' as const, wire: { enable_thinking: false } },
  { flag: undefined, wire: { reasoning: { effort: 'none' } } },
])('Responses builds the reasoning wire shape for flag $flag', async ({ flag, wire }) => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-model', stream: true, input: [], ...wire });
    return Response.json({ error: 'request reached the provider' }, { status: 400 });
  });
  using running = invoke(customPipelines.openaiResponses, input('openaiResponses', {
    model: 'public-model', input: [], reasoning: { effort: 'none' },
  }, { model: { enabledFlags: flag === undefined ? [] : [flag] } }), fetcher);
  expect((await running.result)['response.openaiResponses']).toEqual({ kind: 'error', source: 'upstream', error: { error: 'request reached the provider' } });
  await running.done;
});

const vendorChatEvent = {
  choices: [{ index: 0, delta: { reasoning_content: 'think' } }],
  usage: { cached_tokens: 9, prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 1 },
};

test.each([
  {
    flag: 'vendor-deepseek' as const, wire: { thinking: { type: 'disabled' } },
    event: {
      choices: [{ index: 0, delta: { reasoning_text: 'think' } }],
      usage: { cached_tokens: 9, prompt_tokens_details: { cached_tokens: 6 } },
    },
  },
  { flag: 'vendor-qwen' as const, wire: { enable_thinking: false }, event: vendorChatEvent },
  {
    flag: 'vendor-kimi' as const, wire: { reasoning_effort: 'none' },
    event: {
      ...vendorChatEvent,
      usage: { prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 1, prompt_tokens_details: { cached_tokens: 9 } },
    },
  },
  { flag: undefined, wire: { reasoning_effort: 'none' }, event: vendorChatEvent },
])('Chat Completions applies only the vendor shaping enabled by $flag', async ({ flag, wire, event }) => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-model', messages: [], stream: true, ...wire });
    return sse(vendorChatEvent);
  });
  using running = invoke(customPipelines.openaiChatCompletions, input('openaiChatCompletions', {
    model: 'public-model', messages: [], reasoning_effort: 'none',
  }, { model: { enabledFlags: flag === undefined ? [] : [flag] } }), fetcher);
  const outcome = (await running.result)['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  await running.done;
});
