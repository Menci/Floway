import { expect, test } from 'vitest';

import { azurePipelines, projectAzureModels } from '../src/index.ts';
import { azureRequest, jsonBody, MAX_AZURE_ERROR_BODY_BYTES, MAX_AZURE_RESULT_BODY_BYTES } from '../src/pipelines/http.ts';
import { HttpTransportError, type FetchInit, type Fetcher, type HttpHeaderLines, type HttpHeaders } from '@floway-dev/http';
import { asEntry, run, type Pipeline } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { toUpstreamModelSnapshot, toUpstreamSnapshot, type UpstreamHttpServices, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

const record = (endpoint = 'https://example.openai.azure.com'): UpstreamRecord => ({
  id: 'up_azure',
  name: 'Azure Resource',
  kind: 'azure',
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
  hue: 210,
  config: { endpoint, apiKey: 'azure-key' },
});

const chatModel: UpstreamModelConfig = {
  kind: 'chat',
  upstreamModelId: 'private-deployment',
  publicModelId: 'public-model',
  endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
  limits: { max_context_window_tokens: 128000 },
};

const base = (upstream = record(), headers: HttpHeaders = [], config = chatModel) => ({
  upstream: toUpstreamSnapshot(upstream),
  model: toUpstreamModelSnapshot(projectAzureModels(upstream, [config])[0]),
  http: { method: 'POST', url: 'https://floway.test/v1/request', headers, body: new Uint8Array([99]) },
});

const open = <Request extends object, Response extends object>(
  pipeline: Pipeline<Request, Response, UpstreamHttpServices>,
  request: NoInfer<Request>,
  fetcher: Fetcher,
  signal = new AbortController().signal,
) => {
  const background: Promise<unknown>[] = [];
  const execution = run(asEntry(pipeline), request, {
    signal,
    services: {
      fetcher(id) {
        expect(id).toBe('up_azure');
        return fetcher;
      },
    },
    waitUntil: work => { background.push(work); },
  });
  return { execution, background };
};

const wireResponse = ({ body, headers }: FetchInit): Response => {
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) throw new Error('Expected serialized Azure request body');
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), headers === undefined ? undefined : { headers });
};

const sse = (body: string): Response => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('Azure catalogs the configured deployment and seals every operation handle', () => {
  const { model, http } = base({ ...record(), flagOverrides: { 'vendor-kimi': true } });
  expect(model).toMatchObject({
    id: 'public-model', upstreamModelId: 'private-deployment',
    limits: { max_context_window_tokens: 128000 },
  });
  expect(model.enabledFlags).toContain('vendor-kimi');
  expect(Object.isFrozen(azurePipelines)).toBe(true);
  expect(Object.keys(azurePipelines).sort()).toEqual([
    'anthropicMessages', 'anthropicMessagesCountTokens', 'decision', 'openaiAudioTranscriptions',
    'openaiChatCompletions', 'openaiCompletions', 'openaiEmbeddings', 'openaiImagesEdits',
    'openaiImagesGenerations', 'openaiResponses', 'openaiResponsesCompact',
  ]);
  expect(Object.values(azurePipelines).every(Object.isFrozen)).toBe(true);
  const request = azureRequest(http, 'https://example.openai.azure.com/openai/v1/embeddings', 'azure-key', jsonBody({}));
  expect(JSON.stringify(request.headers)).toContain('[secret]');
  expect(JSON.stringify(request.headers)).not.toContain('azure-key');
});

test('Azure Chat Completions normalizes DeepSeek request and stream data through EOF', async () => {
  const assistant: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'hello', reasoning_text: 'because' };
  const request = {
    ...base({ ...record(), flagOverrides: { 'vendor-deepseek': true, 'vendor-kimi': true } }, [['authorization', 'client-key'], ['x-trace-id', 'trace']]),
    openaiChatCompletions: { model: 'public-model', messages: [assistant], reasoning_effort: 'none' as const },
  };
  const { execution } = open(azurePipelines.openaiChatCompletions, request, async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ 'api-key': 'azure-key', 'content-type': 'application/json' });
    expect(await wireResponse(init).json()).toEqual({
      model: 'private-deployment', stream: true, thinking: { type: 'disabled' },
      messages: [{ role: 'assistant', content: 'hello', reasoning_content: 'because' }],
    });
    return sse('data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}],"usage":{"cached_tokens":5,"prompt_cache_hit_tokens":6,"prompt_cache_miss_tokens":1}}\n\n');
  });
  const { http, openaiChatCompletions: outcome } = await execution.result;
  expect(http).toMatchObject({ status: 200, body: null });
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Chat Completions stream');
  const cursor = execution.read(outcome.stream);
  await expect(cursor.next()).resolves.toEqual({
    done: false,
    value: { ok: true, value: { choices: [{ index: 0, delta: { reasoning_text: 'think' } }], usage: { prompt_tokens_details: { cached_tokens: 6 } } } },
  });
  await expect(cursor.next()).resolves.toEqual({ done: true, value: undefined });
  expect(assistant.reasoning_text).toBe('because');
});

test('Azure Chat Completions applies Mistral field and token-cap policy to the serialized request', async () => {
  const { execution } = open(azurePipelines.openaiChatCompletions, {
    ...base({ ...record(), flagOverrides: { 'vendor-mistral': true } }),
    openaiChatCompletions: {
      model: 'public-model', max_completion_tokens: 19, user: 'private-user',
      messages: [{ role: 'assistant', content: 'hello', refusal: 'unused' }],
      stream_options: { include_usage: true, continuous_usage_stats: true },
    },
  }, async (_url, init) => {
    expect(await wireResponse(init).json()).toEqual({
      model: 'private-deployment', stream: true, max_tokens: 19,
      messages: [{ role: 'assistant', content: 'hello' }], stream_options: { include_usage: true },
    });
    return sse('data: [DONE]\n\n');
  });
  const { openaiChatCompletions: outcome } = await execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Chat Completions stream');
  expect(await Array.fromAsync(execution.read(outcome.stream))).toEqual([]);
});

test.each([false, true])('Azure Chat Completions serializes its selected model policy with Qwen enabled=%s', async qwen => {
  const { execution } = open(azurePipelines.openaiChatCompletions, {
    ...base({ ...record(), flagOverrides: qwen ? { 'vendor-qwen': true } : {} }),
    openaiChatCompletions: { model: 'public-model', messages: [], reasoning_effort: 'none' },
  }, async (_url, init) => {
    const reasoning = qwen ? { enable_thinking: false } : { reasoning_effort: 'none' };
    expect(await wireResponse(init).json()).toEqual({ model: 'private-deployment', stream: true, messages: [], ...reasoning });
    return sse('data: [DONE]\n\n');
  });
  const { openaiChatCompletions: outcome } = await execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Chat Completions stream');
  expect(await Array.fromAsync(execution.read(outcome.stream))).toEqual([]);
});

test('Azure vendor stream normalization forwards a post-head transport error followed by native done', async () => {
  const failure = new HttpTransportError(new Error('read failed'));
  const body = new ReadableStream<Uint8Array>({ start: controller => { controller.error(failure); } });
  const { execution, background } = open(azurePipelines.openaiChatCompletions, {
    ...base({ ...record(), flagOverrides: { 'vendor-kimi': true } }),
    openaiChatCompletions: { model: 'public-model', messages: [] },
  }, async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const { http, openaiChatCompletions: outcome } = await execution.result;
  expect(http).toMatchObject({ status: 200, body: null });
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Chat Completions stream');
  const cursor = execution.read(outcome.stream);
  const failed = await cursor.next();
  if (failed.done || failed.value.ok) throw new Error('Expected Azure transport failure');
  expect(failed.value.error.kind).toBe('transport');
  expect(failed.value.error.cause).toBe(failure);
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
  await Promise.all(background);
});

const namespace: OpenAIResponsesTool = { type: 'namespace', name: 'functions', description: '', tools: [] };
const filledNamespace = { ...namespace, description: 'Tools in the functions namespace.' };

test.each([
  'https://example.services.ai.azure.com/api/projects/demo',
  'https://example.services.ai.azure.com/api/projects/demo/openai/v1',
])('Azure Responses fills namespaces and emits Qwen thinking options for the project endpoint %s', async endpoint => {
  const completed = { type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', created_at: 1, output: [] } };
  const { execution } = open(azurePipelines.openaiResponses, {
    ...base({ ...record(endpoint), flagOverrides: { 'vendor-qwen': true } }),
    openaiResponses: {
      model: 'public-model', reasoning: { effort: 'none' }, tools: [namespace],
      input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }],
    },
  }, async (url, init) => {
    expect(url).toBe('https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses');
    expect(await wireResponse(init).json()).toEqual({
      model: 'private-deployment', stream: true, tools: [filledNamespace], enable_thinking: false,
      input: [{ type: 'additional_tools', role: 'developer', tools: [filledNamespace] }],
    });
    return sse(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
  });
  const { openaiResponses: outcome } = await execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Responses stream');
  expect((await Array.fromAsync(execution.read(outcome.stream))).at(-1)).toMatchObject({ ok: true, value: completed });
  expect(namespace.description).toBe('');
});

test('Azure Responses Compact projects compact fields and decodes the success result', async () => {
  const result = { id: 'cmp_1', object: 'response.compaction', output: [] };
  const { execution } = open(azurePipelines.openaiResponsesCompact, {
    ...base(), openaiResponsesCompact: {
      model: 'public-model', store: false, prompt_cache_options: null,
      input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }],
    },
  }, async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/responses/compact');
    expect(await wireResponse(init).json()).toEqual({
      model: 'private-deployment', prompt_cache_options: null,
      input: [{ type: 'additional_tools', role: 'developer', tools: [filledNamespace] }],
    });
    return Response.json(result);
  });
  await expect(execution.result).resolves.toMatchObject({ openaiResponsesCompact: { kind: 'result', result } });
});

test('Azure Responses Compact preserves the upstream error body and response headers', async () => {
  const error = { error: 'upstream rejected the request' };
  const { execution } = open(azurePipelines.openaiResponsesCompact, {
    ...base(), openaiResponsesCompact: { model: 'public-model', input: [] },
  }, async () => Response.json(error, { status: 418, headers: { 'x-upstream-error': 'compact' } }));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 418, headers: [['content-type', 'application/json'], ['x-upstream-error', 'compact']], body: null },
    openaiResponsesCompact: { kind: 'error', source: 'upstream', error },
  });
});

test.each([
  'https://example.openai.azure.com/openai/v1',
  'https://example.services.ai.azure.com/api/projects/demo/openai/v1',
  'https://example.services.ai.azure.com/anthropic/v1',
])('Azure Anthropic operations use the resource host and preserve beta headers for %s', async endpoint => {
  const shared = base(record(endpoint), [
    ['Anthropic-Beta', 'one'], ['anthropic-beta', 'two'], ['anthropic-version', 'client-version'], ['x-api-key', 'client-key'],
  ]);
  const payload = { model: 'public-model', messages: [{ role: 'user' as const, content: 'hello' }] };
  const fetcher: Fetcher = async (url, init) => {
    const count = url.endsWith('/count_tokens');
    expect(url).toBe(`https://example.services.ai.azure.com/anthropic/v1/messages${count ? '/count_tokens' : ''}`);
    const headers = new Headers(init.headers);
    expect(Object.fromEntries(headers)).toEqual({
      'anthropic-beta': 'one, two', 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'x-api-key': 'azure-key',
    });
    expect(await wireResponse(init).json()).toEqual({
      ...payload, model: 'private-deployment', ...(!count && { max_tokens: 16, stream: true }),
    });
    return count ? Response.json({ input_tokens: 3 }) : sse('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  };
  const generate = open(azurePipelines.anthropicMessages, { ...shared, anthropicMessages: { ...payload, max_tokens: 16 } }, fetcher);
  const { anthropicMessages: outcome } = await generate.execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Anthropic Messages stream');
  expect(await Array.fromAsync(generate.execution.read(outcome.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);

  const count = open(azurePipelines.anthropicMessagesCountTokens, { ...shared, anthropicMessagesCountTokens: payload }, fetcher);
  await expect(count.execution.result).resolves.toMatchObject({ anthropicMessagesCountTokens: { kind: 'result', result: { input_tokens: 3 } } });
});

test('Azure Anthropic Count Tokens carries a no-content response as a null result', async () => {
  const { execution } = open(azurePipelines.anthropicMessagesCountTokens, {
    ...base(), anthropicMessagesCountTokens: { model: 'public-model', messages: [] },
  }, async () => new Response(null, { status: 204 }));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 204, body: null }, anthropicMessagesCountTokens: { kind: 'result', result: null },
  });
});

test('Azure Completions delivers both a typed scalar and a stream through its canonical operation', async () => {
  const payload = { model: 'public-model', prompt: 'example' };
  const result = { id: 'output', object: 'text_completion', created: 1, model: 'private-deployment', choices: [{ index: 0, text: 'result', finish_reason: 'stop' }] };
  const fetcher: Fetcher = async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/completions');
    const body = await wireResponse(init).json();
    expect(body).toMatchObject({ model: 'private-deployment', prompt: 'example' });
    return body.stream === true ? sse(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`) : Response.json(result);
  };
  const scalar = open(azurePipelines.openaiCompletions, { ...base(), openaiCompletions: payload }, fetcher);
  await expect(scalar.execution.result).resolves.toMatchObject({ openaiCompletions: { kind: 'result', result } });

  const streamed = open(azurePipelines.openaiCompletions, { ...base(), openaiCompletions: { ...payload, stream: true } }, fetcher);
  const { openaiCompletions: outcome } = await streamed.execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Completions stream');
  expect(await Array.fromAsync(streamed.execution.read(outcome.stream))).toEqual([{ ok: true, value: result }]);
});

test('Azure Images uses preview routes for JSON generation and multipart edits', async () => {
  const generation = { type: 'image_generation.completed', b64_json: 'image' };
  const generate = open(azurePipelines.openaiImagesGenerations, {
    ...base(), openaiImagesGenerations: { model: 'public-model', prompt: 'a sky', stream: true },
  }, async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
    expect(await wireResponse(init).json()).toEqual({ model: 'private-deployment', prompt: 'a sky', stream: true });
    return sse(`data: ${JSON.stringify(generation)}\n\n`);
  });
  const { openaiImagesGenerations: outcome } = await generate.execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Images Generations stream');
  expect(await Array.fromAsync(generate.execution.read(outcome.stream))).toEqual([{ ok: true, value: { data: generation } }]);

  const bytes = new Uint8Array([1, 2, 3]);
  const result = { data: [{ b64_json: 'image' }] };
  const edit = open(azurePipelines.openaiImagesEdits, {
    ...base(), openaiImagesEdits: {
      parameters: { prompt: 'replace sky' },
      images: [{ type: 'upload', file: { name: 'photo.png', mediaType: 'image/png', bytes } }],
    },
  }, async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
    const form = await wireResponse(init).formData();
    expect(form.get('model')).toBe('private-deployment');
    expect(form.get('prompt')).toBe('replace sky');
    const file = form.get('image');
    if (!(file instanceof File)) throw new Error('Expected uploaded image');
    expect(file).toMatchObject({ name: 'photo.png', type: 'image/png' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return Response.json(result);
  });
  await expect(edit.execution.result).resolves.toMatchObject({ openaiImagesEdits: { kind: 'result', result } });
});

test.each([
  'https://example.openai.azure.com/',
  'https://example.openai.azure.com/openai/v1/',
  'https://example.services.ai.azure.com/',
  'https://example.services.ai.azure.com/api/projects/demo/',
  'https://example.services.ai.azure.com/api/projects/demo/openai/v1',
  'https://example.services.ai.azure.com/anthropic',
  'https://example.services.ai.azure.com/anthropic/v1',
  'https://example.services.ai.azure.com/anthropic/v1/messages',
])('Azure Audio Transcriptions omits the model form field and uses a resource-scoped deployment for %s', async endpoint => {
  const bytes = new Uint8Array([1, 2, 3]);
  const response = '{ "text": "hello", "duration": 1.00 }\n';
  const { execution } = open(azurePipelines.openaiAudioTranscriptions, {
    ...base(record(endpoint), [], { ...chatModel, upstreamModelId: 'private deployment/variant' }),
    openaiAudioTranscriptions: {
      entries: [
        { name: 'model', value: 'public-model' }, { name: 'file', value: { name: 'clip.wav', mediaType: 'audio/wav', bytes } },
        { name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' },
      ],
    },
  }, async (url, init) => {
    expect(url).toBe(`${new URL(endpoint).origin}/openai/deployments/private%20deployment%2Fvariant/audio/transcriptions?api-version=2025-04-01-preview`);
    const form = await wireResponse(init).formData();
    expect(form.has('model')).toBe(false);
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Expected audio file');
    expect(file).toMatchObject({ name: 'clip.wav', type: 'audio/wav' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return new Response(response, { headers: { 'content-type': 'application/json' } });
  });
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 200, body: null },
    openaiAudioTranscriptions: { kind: 'result', result: new TextEncoder().encode(response) },
  });
});

test('Azure Audio Transcriptions returns decoded SSE event names and payloads', async () => {
  const event = { type: 'transcript.text.done', text: 'hello' };
  const { execution } = open(azurePipelines.openaiAudioTranscriptions, { ...base(), openaiAudioTranscriptions: { entries: [] } }, async () =>
    sse(`event: transcript.text.done\ndata: ${JSON.stringify(event)}\n\n`));
  const { openaiAudioTranscriptions: outcome } = await execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Azure Audio Transcriptions stream');
  expect(await Array.fromAsync(execution.read(outcome.stream))).toEqual([{ ok: true, value: { data: event, eventName: 'transcript.text.done' } }]);
});

const decisionBase = base(record('https://example.services.ai.azure.com/api/projects/demo'), [], {
  kind: 'decision', upstreamModelId: 'private-deployment', endpoints: { decision: {} },
});
const decisionRequest = parseDecisionRequest('typesafe-systemone', {
  model: 'public-model', state: 'input', questions: { ok: { type: 'noul', criteria: { true: 'Yes' } } },
}).request;

test('Azure Decision targets resource-scoped System One and preserves its native result bytes', async () => {
  const response = '{ "answers": { "ok": { "type": "noul", "noul": 0.90 } }, "extension": "kept" }';
  const { execution } = open(azurePipelines.decision, { ...decisionBase, decision: decisionRequest }, async (url, init) => {
    expect(url).toBe('https://example.services.ai.azure.com/providers/microsoft/v1/systemone');
    expect(new Headers(init.headers).get('api-key')).toBe('azure-key');
    expect(await wireResponse(init).json()).toMatchObject({ model: 'private-deployment' });
    return new Response(response, { headers: { 'content-type': 'application/json' } });
  });
  await expect(execution.result).resolves.toMatchObject({ decision: { kind: 'result', result: new TextEncoder().encode(response) } });
});

test('Azure Decision preserves cross-dialect response bytes for metering before validation', async () => {
  const { raw: _raw, ...canonical } = decisionRequest;
  const response = '{ "answers": { "ok": { "type": "noul", "noul": "0.90" } }, "usage": { "input_tokens": 37 } }';
  const { execution } = open(azurePipelines.decision, {
    ...decisionBase, decision: { ...canonical, sourceProtocol: 'openai-decisions', raw: {} },
  }, async () => new Response(response, { status: 201, headers: { 'content-type': 'application/json' } }));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 201, body: null, headers: [['content-type', 'application/json']] },
    decision: { kind: 'result', result: new TextEncoder().encode(response) },
  });
});

const embeddingsRequest = { ...base(), openaiEmbeddings: { model: 'public-model', input: 'example' } };

test('Azure Embeddings dials its selected deployment and decodes the JSON result', async () => {
  const result = { object: 'list', data: [] };
  const { execution } = open(azurePipelines.openaiEmbeddings, embeddingsRequest, async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/embeddings');
    expect(await wireResponse(init).json()).toEqual({ model: 'private-deployment', input: 'example' });
    return Response.json(result);
  });
  await expect(execution.result).resolves.toMatchObject({ openaiEmbeddings: { kind: 'result', result } });
});

test('Azure consumes pre-head transport and abort outcomes and propagates the original panic', async () => {
  const transport = open(azurePipelines.openaiEmbeddings, embeddingsRequest, async () => {
    throw new HttpTransportError(new Error('connection reset'));
  });
  await expect(transport.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: {
      kind: 'error', source: 'upstream', error: {
        error: {
          type: 'server_error', message: 'connection reset', provider_specific_fields: {
            name: 'HttpTransportError', stack: expect.any(String),
            cause: { name: 'Error', message: 'connection reset', stack: expect.any(String) },
          },
        },
      },
    },
  });

  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const aborted = open(azurePipelines.openaiEmbeddings, embeddingsRequest, (_url, { signal }) => {
    if (signal == null) throw new Error('Expected Azure request abort signal');
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      entered.resolve();
    });
  }, controller.signal);
  await entered.promise;
  controller.abort(new Error('stop'));
  await expect(aborted.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: { kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message: 'Upstream request cancelled' } } },
  });

  const bug = new TypeError('unexpected fetch bug');
  const panicked = open(azurePipelines.openaiEmbeddings, embeddingsRequest, async () => { throw bug; });
  await expect(panicked.execution.result).rejects.toBe(bug);
});

test('Azure preserves HTTP error heads and JSON tokens while wrapping a plain error with the protocol envelope', async () => {
  const headerLines: HttpHeaderLines = [['x-upstream', 'a'], ['x-upstream', 'b']];
  const json = open(azurePipelines.openaiEmbeddings, embeddingsRequest, async () =>
    Object.assign(new Response('{"error":{"code":9007199254740993}}', { status: 429, statusText: 'Rate Limited' }), { headerLines }));
  const answer = await json.execution.result;
  expect(answer.http).toEqual({ status: 429, statusText: 'Rate Limited', headers: headerLines, startedAt: expect.any(Number), body: null });
  const outcome = answer.openaiEmbeddings;
  if (outcome.kind !== 'error') throw new Error('Expected Azure Embeddings error');
  expect(JSON.stringify(outcome.error)).toBe('{"error":{"code":9007199254740993}}');

  const plain = open(azurePipelines.anthropicMessagesCountTokens, {
    ...base(), anthropicMessagesCountTokens: { model: 'public-model', messages: [] },
  }, async () => new Response('provider rejection', { status: 400 }));
  await expect(plain.execution.result).resolves.toMatchObject({
    http: { status: 400, body: null },
    anthropicMessagesCountTokens: {
      kind: 'error', source: 'upstream', error: { type: 'error', error: { type: 'invalid_request_error', message: 'provider rejection' } },
    },
  });
});

test.each([
  { status: 200, limit: MAX_AZURE_RESULT_BODY_BYTES },
  { status: 429, limit: MAX_AZURE_ERROR_BODY_BYTES },
])('Azure bounds buffered bodies with status $status to $limit bytes', async ({ status, limit }) => {
  const chunk = new Uint8Array(limit);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(new Uint8Array([0]));
      controller.close();
    },
  });
  const { execution, background } = open(azurePipelines.openaiEmbeddings, embeddingsRequest, async () => new Response(body, { status }));
  await expect(execution.result).rejects.toThrow(`Upstream response body exceeds ${limit} bytes`);
  expect(background).toHaveLength(1);
  await Promise.all(background);
});
