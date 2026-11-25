import { expect, test, vi } from 'vitest';

import { azurePipelines, projectAzureModels, toAzureUpstream, type AzureUpstream } from '../../src/index.ts';
import { type Fetcher, type FetchInit, type HttpHeaders, toRequestInit } from '@floway-dev/http';
import { run, Secret, type Pipeline, type RunEvent } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import { toProviderModelFact, type GatewayFacts, type ProviderOperation, type ProviderRequestFacts, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';

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
  modelsCache: null,
  hue: 210,
  config: {
    endpoint,
    apiKey: 'azure-key',
    models: [{
      upstreamModelId: 'private-deployment',
      publicModelId: 'public-model',
      display_name: 'Public Model',
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
      limits: { max_context_window_tokens: 128000 },
    }],
  },
});

const input = <Op extends ProviderOperation>(
  operation: Op,
  payload: GatewayFacts[`request.${NoInfer<Op>}`],
  upstream = record(),
  headers: HttpHeaders = [],
): ProviderRequestFacts<Op, AzureUpstream> => ({
  'request.http': { method: 'POST', url: 'https://gateway.example/v1/request', headers, body: new Uint8Array([99]) },
  'provider.upstream': toAzureUpstream(upstream),
  'provider.model': toProviderModelFact(projectAzureModels(upstream)[0]),
  [`request.${operation}`]: payload,
}) as ProviderRequestFacts<Op, AzureUpstream>;

const invoke = <I, O>(handle: Pipeline<I, O, ProviderServices>, facts: NoInfer<I>, fetcher: Fetcher, observe?: (event: RunEvent) => void) => {
  const controller = new AbortController();
  const running = run(handle, facts, {
    signal: controller.signal,
    waitUntil: () => { throw new Error('Azure should not schedule a detached worker'); },
    services: {
      fetcher: upstreamId => {
        expect(upstreamId).toBe('up_azure');
        return async (url, init) => ({ response: await fetcher(url, init) });
      },
    },
    ...(observe !== undefined && { events: observe }),
  });
  return { ...running, [Symbol.dispose]: () => controller.abort() };
};

const sse = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
const openAIError = (message: string) => ({ error: { type: 'invalid_request_error', message } });
const requestOf = (url: string, init: FetchInit): Request => {
  if (!(init.body instanceof Uint8Array)) throw new Error('Expected serialized request bytes');
  return new Request(url, toRequestInit(init, new Uint8Array(init.body)));
};

test('projects Azure model identity, limits, and effective flags independently of data-plane handles', () => {
  const upstream = { ...record(), flagOverrides: { 'vendor-kimi': true } };
  const [model] = projectAzureModels(upstream);
  expect(model).toMatchObject({
    id: 'public-model',
    upstreamModelId: 'private-deployment',
    display_name: 'Public Model',
    limits: { max_context_window_tokens: 128000 },
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
    endpoints: { openaiChatCompletions: {}, openaiResponses: {}, openaiEmbeddings: {} },
  });
  expect(model.enabledFlags.has('vendor-kimi')).toBe(true);
  expect(Object.isFrozen(azurePipelines)).toBe(true);
});

test('Chat Completions uses the deployment id, redacts the API key, and normalizes DeepSeek events through EOF', async () => {
  const upstream = { ...record(), flagOverrides: { 'vendor-deepseek': true } };
  const assistant: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'hello', reasoning_text: 'because' };
  const events: RunEvent[] = [];
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/chat/completions');
    expect(init.headers).toEqual([['api-key', 'azure-key'], ['content-type', 'application/json']]);
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-deployment',
      stream: true,
      messages: [{ role: 'assistant', content: 'hello', reasoning_content: 'because' }],
      thinking: { type: 'disabled' },
    });
    return sse('data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}],"usage":{"prompt_cache_hit_tokens":6,"prompt_cache_miss_tokens":1}}\n\n');
  });
  using running = invoke(azurePipelines.openaiChatCompletions, input('openaiChatCompletions', {
    model: 'public-model', messages: [assistant], reasoning_effort: 'none',
  }, upstream, [['authorization', 'client-key'], ['content-length', '999'], ['x-trace-id', 'client']]), fetcher, event => events.push(event));
  const result = await running.result;
  const outcome = result['response.openaiChatCompletions'];
  expect(result['response.http']).toMatchObject({ status: 200, body: null });
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{
    ok: true, value: { choices: [{ index: 0, delta: { reasoning_text: 'think' } }], usage: { prompt_tokens_details: { cached_tokens: 6 } } },
  }]);
  await running.done;
  expect(fetcher).toHaveBeenCalledTimes(1);
  const terminal = events.find(event => event.type === 'stage.entered' && event.name === 'http');
  expect(terminal).toMatchObject({ facts: { 'request.http': { headers: [['api-key', expect.any(Secret)], ['content-type', 'application/json']] } } });
});

const namespace = { type: 'namespace', name: 'functions', description: '', tools: [] } satisfies OpenAIResponsesTool;

test('Responses fills empty namespace descriptions in top-level and embedded tools before dialing', async () => {
  const completed = { type: 'response.completed', response: { id: 'resp_1', object: 'response', status: 'completed', created_at: 1, output: [] } };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses');
    const filled = { ...namespace, description: 'Tools in the functions namespace.' };
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-deployment', stream: true, tools: [filled, { ...namespace, description: 'Lookup tools' }],
      input: [{ type: 'additional_tools', role: 'developer', tools: [filled] }],
    });
    return sse(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
  });
  using running = invoke(azurePipelines.openaiResponses, input('openaiResponses', {
    model: 'public-model', tools: [namespace, { ...namespace, description: 'Lookup tools' }],
    input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }],
  }, record('https://example.services.ai.azure.com/api/projects/demo')), fetcher);
  const outcome = (await running.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected Responses stream');
  const events = await Array.fromAsync(running.read(outcome.stream));
  expect(events.every(event => event.ok)).toBe(true);
  expect(events.at(-1)).toMatchObject({ ok: true, value: completed });
  await running.done;
  expect(namespace.description).toBe('');
});

test('Responses Compact fills embedded namespaces, omits store, and preserves the upstream error answer', async () => {
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/responses/compact');
    expect(await requestOf(url, init).json()).toEqual({
      model: 'private-deployment',
      prompt_cache_options: null,
      input: [{
        type: 'additional_tools', role: 'developer',
        tools: [{ ...namespace, description: 'Tools in the functions namespace.' }],
      }],
    });
    return new Response('invalid namespace', { status: 418, headers: { 'x-upstream-error': 'compact' } });
  });
  using running = invoke(azurePipelines.openaiResponsesCompact, input('openaiResponsesCompact', {
    model: 'public-model', prompt_cache_options: null, store: false,
    input: [{ type: 'additional_tools', role: 'developer', tools: [namespace] }],
  }), fetcher);
  expect(await running.result).toMatchObject({
    'response.http': { status: 418, statusText: '', headers: [['content-type', 'text/plain;charset=UTF-8'], ['x-upstream-error', 'compact']], body: null },
    'response.openaiResponsesCompact': { kind: 'error', source: 'upstream', error: openAIError('invalid namespace') },
  });
  await running.done;
});

test('Anthropic Messages and count-tokens use the resource-scoped URL and keep only beta request values', async () => {
  const upstream = record('https://example.openai.azure.com');
  const headers: HttpHeaders = [['anthropic-beta', 'test-beta'], ['anthropic-version', 'client-version'], ['x-api-key', 'client-key']];
  const payload = { model: 'public-model', messages: [{ role: 'user' as const, content: 'hello' }] };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const isCount = url.endsWith('/count_tokens');
    expect(new URL(url).hostname).toBe('example.services.ai.azure.com');
    expect(init.headers).toEqual([['anthropic-beta', 'test-beta'], ['x-api-key', 'azure-key'], ['anthropic-version', '2023-06-01'], ['content-type', 'application/json']]);
    expect(await requestOf(url, init).json()).toEqual({
      ...payload, model: 'private-deployment', ...(!isCount && { max_tokens: 16, stream: true }),
    });
    return isCount ? Response.json({ input_tokens: 3 }) : sse('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  using generation = invoke(azurePipelines.anthropicMessages, input('anthropicMessages', { ...payload, max_tokens: 16 }, upstream, headers), fetcher);
  const outcome = (await generation.result)['response.anthropicMessages'];
  if (outcome.kind !== 'stream') throw new Error('Expected Anthropic Messages stream');
  expect(await Array.fromAsync(generation.read(outcome.stream))).toEqual([{ ok: true, value: { type: 'message_stop' } }]);
  using count = invoke(azurePipelines.anthropicMessagesCountTokens, input('anthropicMessagesCountTokens', payload, upstream, headers), fetcher);
  expect((await count.result)['response.anthropicMessagesCountTokens']).toEqual({ kind: 'result', result: { input_tokens: 3 } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://example.services.ai.azure.com/anthropic/v1/messages',
    'https://example.services.ai.azure.com/anthropic/v1/messages/count_tokens',
  ]);
  await Promise.all([generation.done, count.done]);
});

test.each([
  'https://example.services.ai.azure.com',
  'https://example.services.ai.azure.com/api/projects/demo',
  'https://example.services.ai.azure.com/api/projects/demo/openai/v1',
  'https://example.services.ai.azure.com/anthropic',
  'https://example.services.ai.azure.com/anthropic/v1',
  'https://example.services.ai.azure.com/anthropic/v1/messages',
])('audio transcription scopes deployment in the path for %s and omits the multipart model field', async endpoint => {
  const bytes = new Uint8Array([1, 2, 3]);
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.services.ai.azure.com/openai/deployments/private-deployment/audio/transcriptions?api-version=2025-04-01-preview');
    const form = await requestOf(url, init).formData();
    expect(form.has('model')).toBe(false);
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const file = form.get('file');
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) throw new Error('Expected audio file');
    expect(file).toMatchObject({ name: 'clip.wav', type: 'audio/wav' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return new Response('hello');
  });
  using running = invoke(azurePipelines.openaiAudioTranscriptions, input('openaiAudioTranscriptions', {
    entries: [
      { name: 'model', value: 'public-model' }, { name: 'file', value: { name: 'clip.wav', mediaType: 'audio/wav', bytes } },
      { name: 'timestamp_granularities[]', value: 'word' }, { name: 'timestamp_granularities[]', value: 'segment' },
    ],
  }, record(endpoint)), fetcher);
  expect((await running.result)['response.openaiAudioTranscriptions']).toEqual({ kind: 'result', result: new TextEncoder().encode('hello') });
  await running.done;
});

test('Images Edits negotiates multipart bytes and the Azure preview URL', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/images/edits?api-version=preview');
    const form = await requestOf(url, init).formData();
    expect(form.get('model')).toBe('private-deployment');
    expect(form.get('prompt')).toBe('replace sky');
    const file = form.get('image');
    if (!(file instanceof File)) throw new Error('Expected image file');
    expect(file).toMatchObject({ name: 'photo.png', type: 'image/png' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    return Response.json({ data: [{ b64_json: 'image' }] });
  });
  using running = invoke(azurePipelines.openaiImagesEdits, input('openaiImagesEdits', {
    parameters: { prompt: 'replace sky' }, images: [{ type: 'upload', file: { name: 'photo.png', mediaType: 'image/png', bytes } }],
  }), fetcher);
  expect((await running.result)['response.openaiImagesEdits']).toEqual({ kind: 'result', result: { data: [{ b64_json: 'image' }] } });
  await running.done;
});

test.each([
  { probability: '0.90', kind: 'result' },
  { probability: '"0.90"', kind: 'error' },
])('Decision classifies a native System One probability token $probability as $kind', async ({ probability, kind }) => {
  const body = `{ "answers": { "ok": { "type": "noul", "noul": ${probability} } }, "extension": "kept" }`;
  const upstream = record('https://example.services.ai.azure.com/api/projects/demo');
  const request = parseDecisionRequest('typesafe-systemone', {
    model: 'public-model', state: 'input', questions: { ok: { type: 'noul', criteria: { true: 'Yes' } } },
  }).request;
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.services.ai.azure.com/v1/systemone');
    expect(await requestOf(url, init).json()).toMatchObject({ model: 'private-deployment' });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  });
  using running = invoke(azurePipelines.decision, input('decision', request, upstream), fetcher);
  const result = await running.result;
  expect(result['response.http']).toMatchObject({ status: 200, body: null });
  if (kind === 'result') {
    expect(result['response.decision']).toEqual({ kind: 'result', result: new TextEncoder().encode(body) });
  } else {
    expect(result['response.decision']).toMatchObject({ kind: 'error', source: 'upstream' });
  }
  await running.done;
});

test('Completions classifies a malformed response choice as an upstream error', async () => {
  const fetcher: Fetcher = () => Promise.resolve(Response.json({
    id: 'output', object: 'text_completion', created: 1, model: 'private-deployment', choices: [null],
  }));
  using running = invoke(azurePipelines.openaiCompletions, input('openaiCompletions', { model: 'public-model', prompt: 'example' }), fetcher);
  expect(await running.result).toMatchObject({
    'response.http': { status: 200, body: null },
    'response.openaiCompletions': { kind: 'error', source: 'upstream' },
  });
  await running.done;
});

test.each([
  { flag: 'vendor-deepseek' as const, wire: { thinking: { type: 'disabled' } } },
  { flag: 'vendor-qwen' as const, wire: { enable_thinking: false } },
  { flag: undefined, wire: { reasoning: { effort: 'none' } } },
])('Responses builds the reasoning wire shape for flag $flag', async ({ flag, wire }) => {
  const upstream = { ...record(), flagOverrides: flag === undefined ? {} : { [flag]: true } };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-deployment', stream: true, input: [], ...wire });
    return Response.json({ error: 'request reached Azure' }, { status: 400 });
  });
  using running = invoke(azurePipelines.openaiResponses, input('openaiResponses', {
    model: 'public-model', input: [], reasoning: { effort: 'none' },
  }, upstream), fetcher);
  expect((await running.result)['response.openaiResponses']).toEqual({ kind: 'error', source: 'upstream', error: { error: 'request reached Azure' } });
  await running.done;
});

test.each([true, false])('Kimi cached-token normalization follows its model flag %s', async enabled => {
  const upstream = { ...record(), flagOverrides: { 'vendor-kimi': enabled } };
  const event = { choices: [], usage: { cached_tokens: 9, prompt_tokens_details: { audio_tokens: 2 } } };
  const fetcher: Fetcher = () => Promise.resolve(sse(`data: ${JSON.stringify(event)}\n\n`));
  using running = invoke(azurePipelines.openaiChatCompletions, input('openaiChatCompletions', { model: 'public-model', messages: [] }, upstream), fetcher);
  const outcome = (await running.result)['response.openaiChatCompletions'];
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const expected = enabled ? { choices: [], usage: { prompt_tokens_details: { audio_tokens: 2, cached_tokens: 9 } } } : event;
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: expected }]);
  await running.done;
});

test('Responses Compact publishes a scalar result from Azure', async () => {
  const result = { id: 'compact', object: 'response.compaction', output: [] };
  const fetcher: Fetcher = () => Promise.resolve(Response.json(result));
  using running = invoke(azurePipelines.openaiResponsesCompact, input('openaiResponsesCompact', { model: 'public-model', input: [] }), fetcher);
  expect((await running.result)['response.openaiResponsesCompact']).toEqual({ kind: 'result', result });
  await running.done;
});

test('Decision decodes a System One result for an OpenAI Decisions request', async () => {
  const request = parseDecisionRequest('openai-decisions', {
    model: 'public-model', input: 'input', questions: [{ name: 'ok', type: 'predicate', instructions: 'Is it valid?' }],
  }).request;
  const raw = { model: 'private-deployment', answers: { ok: { type: 'noul', noul: 0.9 } } };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(await requestOf(url, init).json()).toMatchObject({
      model: 'private-deployment', state: 'input', questions: { ok: { type: 'noul' } },
    });
    return Response.json(raw);
  });
  using running = invoke(azurePipelines.decision, input('decision', request), fetcher);
  expect((await running.result)['response.decision']).toEqual({
    kind: 'result', result: { raw, model: 'private-deployment', answers: [{ name: 'ok', type: 'noul', noul: 0.9 }] },
  });
  await running.done;
});

test.each([
  { stream: false, media: 'json', kind: 'result' },
  { stream: true, media: 'sse', kind: 'stream' },
  { stream: true, media: 'json', kind: 'error' },
  { stream: false, media: 'sse', kind: 'error' },
])('Images Generations with stream=$stream classifies media $media as $kind', async ({ stream, media, kind }) => {
  const event = { type: 'image_generation.completed', b64_json: 'image' };
  const result = { data: [{ b64_json: 'image' }] };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toBe('https://example.openai.azure.com/openai/v1/images/generations?api-version=preview');
    expect(await requestOf(url, init).json()).toEqual({ model: 'private-deployment', prompt: 'example', stream });
    if (media === 'json') return Response.json(result);
    return sse(`data: ${JSON.stringify(event)}\n\n`);
  });
  using running = invoke(azurePipelines.openaiImagesGenerations, input('openaiImagesGenerations', {
    model: 'public-model', prompt: 'example', stream,
  }), fetcher);
  const facts = await running.result;
  const outcome = facts['response.openaiImagesGenerations'];
  expect(facts['response.http']).toMatchObject({ status: 200, body: null });
  expect(outcome.kind).toBe(kind);
  if (outcome.kind === 'stream') {
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  } else if (outcome.kind === 'result') {
    expect(outcome.result).toEqual(result);
  } else {
    expect(outcome.source).toBe('upstream');
    expect(outcome.error).toMatchObject({
      error: { message: expect.stringContaining(stream ? 'stream is required' : 'a scalar response is required') },
    });
  }
  await running.done;
});

test('Images Edits respects the multipart stream field', async () => {
  const event = { type: 'image_edit.completed', b64_json: 'image' };
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const form = await requestOf(url, init).formData();
    expect(form.get('stream')).toBe('true');
    return sse(`data: ${JSON.stringify(event)}\n\n`);
  });
  using running = invoke(azurePipelines.openaiImagesEdits, input('openaiImagesEdits', {
    parameters: { prompt: 'replace sky', stream: 'true' },
    images: [{ type: 'upload', file: { name: 'photo.png', mediaType: 'image/png', bytes: new Uint8Array([1]) } }],
  }), fetcher);
  const outcome = (await running.result)['response.openaiImagesEdits'];
  if (outcome.kind !== 'stream') throw new Error('Expected Images Edits stream');
  expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
  await running.done;
});
