import { expect, it, vi } from 'vitest';

import { OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS } from '../../src/account-probe.ts';
import { createOllamaActiveUsageService, ollamaPipelines, type OllamaPipelineServices } from '../../src/index.ts';
import { OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS } from '../../src/usage-probe.ts';
import { CREDIT_BALANCE, USAGE_TOTALS } from '../usage-fixture.ts';
import { HttpTransportError } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import { parseDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import type { Fetcher, UpstreamModelSnapshot, UpstreamOperation, UpstreamPipeline, UpstreamRecord, UpstreamRequest, UpstreamRuntimeRepo, UpstreamSnapshot } from '@floway-dev/upstream';

const config = { baseUrl: 'https://ollama.test/proxy', apiKey: 'ollama-key', cloudUsage: false };
const upstream: UpstreamSnapshot = { id: 'ollama-test', kind: 'ollama', name: 'Ollama', config };
const model: UpstreamModelSnapshot = {
  id: 'public', upstreamModelId: 'native:model', kind: 'chat', limits: {}, endpoints: { openaiChatCompletions: {} }, upstreamData: 'native:model',
  enabledFlags: [], opaqueBlobCompatibilityScope: { bindToUpstream: true },
};
const http = {
  url: 'https://floway.test/v1/chat/completions', method: 'POST', body: new Uint8Array(),
  headers: [['authorization', 'Bearer floway-key'], ['anthropic-beta', 'test-beta'], ['content-type', 'application/json']] satisfies UpstreamRequest<'openaiChatCompletions'>['http']['headers'],
};
const chatRequest: UpstreamRequest<'openaiChatCompletions'> = { upstream, model, http, openaiChatCompletions: { model: model.id, messages: [], max_completion_tokens: 321 } };
const embeddingsRequest: UpstreamRequest<'openaiEmbeddings'> = { upstream, model, http, openaiEmbeddings: { model: model.id, input: 'text' } };

const noRefresh: OllamaPipelineServices['ollama'] = {
  async refreshUsage() { throw new Error('Unexpected usage refresh'); },
  async refreshAccount() { throw new Error('Unexpected account refresh'); },
};

const execute = <Op extends UpstreamOperation>(
  pipeline: UpstreamPipeline<Op, OllamaPipelineServices>,
  facts: UpstreamRequest<Op>,
  fetcher: Fetcher,
  options: { ollama?: OllamaPipelineServices['ollama']; controller?: AbortController } = {},
) => {
  const background: Promise<unknown>[] = [];
  const execution = run(asEntry(pipeline), facts, {
    services: { fetcher: () => fetcher, ollama: options.ollama ?? noRefresh },
    signal: (options.controller ?? new AbortController()).signal,
    waitUntil(work) {
      background.push(work);
      void work.catch(() => {});
    },
  });
  return { execution, background };
};

it('preserves Ollama’s chat request shaping and consumes the HTTP body to native done', async () => {
  const { execution } = execute(ollamaPipelines.openaiChatCompletions, chatRequest, async (url, init) => {
    expect(url).toBe('https://ollama.test/proxy/v1/chat/completions');
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({ authorization: 'Bearer ollama-key', 'content-type': 'application/json' });
    expect(init.body).toBe('{"model":"native:model","messages":[],"max_tokens":321,"stream":true}');
    return new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const answer = await execution.result;
  expect(answer).toMatchObject({ http: { status: 200, body: null } });
  expect(answer).not.toHaveProperty('usageModelKey');
  expect(chatRequest.openaiChatCompletions.max_completion_tokens).toBe(321);
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  expect(await cursor.next()).toEqual({ done: false, value: { ok: true, value: { choices: [] } } });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
});

it('projects DeepSeek request controls and cache usage through the same chat pipeline', async () => {
  const assistant: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: null, reasoning_text: 'prior reasoning' };
  const request: UpstreamRequest<'openaiChatCompletions'> = {
    ...chatRequest,
    model: { ...model, enabledFlags: ['vendor-deepseek'] },
    openaiChatCompletions: {
      ...chatRequest.openaiChatCompletions,
      messages: [assistant],
      reasoning_effort: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' } } },
    },
  };
  const { execution } = execute(ollamaPipelines.openaiChatCompletions, request, async (_url, init) => {
    expect(typeof init.body).toBe('string');
    if (typeof init.body !== 'string') throw new Error('Expected serialized Ollama JSON request');
    expect(JSON.parse(init.body)).toEqual({
      messages: [{ role: 'assistant', content: null, reasoning_content: 'prior reasoning' }],
      model: 'native:model', max_tokens: 321, stream: true, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
    });
    const event = { choices: [{ index: 0, delta: { reasoning_content: 'output' } }], usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const answer = await execution.result;
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  expect(await cursor.next()).toEqual({
    done: false,
    value: { ok: true, value: { choices: [{ index: 0, delta: { reasoning_text: 'output' } }], usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } } } },
  });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
  expect(request.openaiChatCompletions.reasoning_effort).toBe('none');
});

it.each([
  { limits: { max_completion_tokens: 0 }, expected: { max_tokens: 0 } },
  { limits: { max_tokens: null, max_completion_tokens: 128000 }, expected: { max_tokens: null, max_completion_tokens: 128000 } },
])('uses the existing output cap precedence for $limits without forwarding client authorization to a local daemon', async ({ limits, expected }) => {
  const { execution } = execute(ollamaPipelines.openaiChatCompletions, {
    ...chatRequest,
    upstream: { ...upstream, config: { baseUrl: 'http://127.0.0.1:11434' } },
    openaiChatCompletions: { model: model.id, messages: [], ...limits },
  }, async (url, init) => {
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    if (typeof init.body !== 'string') throw new Error('Expected Ollama JSON request');
    expect(JSON.parse(init.body)).toEqual({ model: 'native:model', messages: [], stream: true, ...expected });
    return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  const outcome = (await execution.result).openaiChatCompletions;
  expect(outcome.kind).toBe('stream');
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  expect(await Array.fromAsync(execution.read(outcome.stream))).toEqual([]);
});

it('sends the Anthropic beta header to token counting without refreshing account usage', async () => {
  const request: UpstreamRequest<'anthropicMessagesCountTokens'> = {
    upstream: { ...upstream, config: { ...config, cloudUsage: true } }, model, http,
    anthropicMessagesCountTokens: { model: 'public', messages: [] },
  };
  const { execution, background } = execute(ollamaPipelines.anthropicMessagesCountTokens, request, async (url, init) => {
    expect(url).toBe('https://ollama.test/proxy/v1/messages/count_tokens');
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('test-beta');
    expect(init.body).toBe('{"model":"native:model","messages":[]}');
    return Response.json({ input_tokens: 12 });
  });
  await expect(execution.result).resolves.toMatchObject({ anthropicMessagesCountTokens: { kind: 'result', result: { input_tokens: 12 } } });
  expect(background).toHaveLength(0);
});

it.each([
  { status: 204, outcome: { kind: 'result', result: null } },
  { status: 205, outcome: { kind: 'result', result: null } },
  { status: 200, outcome: { kind: 'error', source: 'upstream' } },
])('classifies an empty count_tokens response with HTTP $status', async ({ status, outcome }) => {
  const { execution } = execute(ollamaPipelines.anthropicMessagesCountTokens, {
    upstream, model, http, anthropicMessagesCountTokens: { model: 'public', messages: [] },
  }, async () => new Response(null, { status }));
  const answer = await execution.result;
  expect(answer).toMatchObject({ http: { status, body: null }, anthropicMessagesCountTokens: outcome });
  expect(answer).not.toHaveProperty('usageModelKey');
});

it('projects compact-specific request fields and reads the compaction resource', async () => {
  const request: UpstreamRequest<'openaiResponsesCompact'> = {
    upstream, model, http, openaiResponsesCompact: { model: 'public', input: [], store: true, prompt_cache_options: null },
  };
  const result = { id: 'compaction', object: 'response.compaction', output: [] };
  const { execution } = execute(ollamaPipelines.openaiResponsesCompact, request, async (url, init) => {
    expect(url).toBe('https://ollama.test/proxy/v1/responses/compact');
    if (typeof init.body !== 'string') throw new Error('Expected Ollama JSON request');
    expect(JSON.parse(init.body)).toEqual({ model: 'native:model', input: [], prompt_cache_options: null });
    return Response.json(result);
  });
  await expect(execution.result).resolves.toMatchObject({ openaiResponsesCompact: { kind: 'result', result } });
});

it('dials Ollama Decision as System One and preserves cross-dialect bytes for metering', async () => {
  const { request } = parseDecisionRequest('typesafe-systemone', {
    model: 'public', state: 'input', questions: { ok: { type: 'noul', criteria: { true: 'Yes' } } },
  });
  const response = '{ "answers": null, "usage": { "input_tokens": 37 } }';
  const { execution } = execute(ollamaPipelines.decision, {
    upstream,
    model: { ...model, kind: 'decision', endpoints: { decision: {} }, decisionTarget: { protocol: 'typesafe-systemone' } },
    http,
    decision: { ...request, sourceProtocol: 'openai-decisions' },
  }, async (url, init) => {
    expect(url).toBe('https://ollama.test/proxy/v1/systemone');
    expect(init.body).toContain('"model":"native:model"');
    return new Response(response, { status: 201 });
  });
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 201, body: null },
    decision: { kind: 'result', result: new TextEncoder().encode(response) },
  });
});

it('rebuilds multipart with the Ollama model and preserves the returned transcription bytes', async () => {
  const bytes = new Uint8Array([0, 1, 255]);
  const request: UpstreamRequest<'openaiAudioTranscriptions'> = {
    upstream, model, http,
    openaiAudioTranscriptions: {
      entries: [
        { name: 'model', value: 'public' },
        { name: 'file', value: { name: 'audio.wav', mediaType: 'audio/wav', bytes } },
        { name: 'timestamp_granularities[]', value: 'word' },
        { name: 'timestamp_granularities[]', value: 'segment' },
      ],
    },
  };
  const { execution } = execute(ollamaPipelines.openaiAudioTranscriptions, request, async (url, init) => {
    expect(url).toBe('https://ollama.test/proxy/v1/audio/transcriptions');
    expect(init.body).toBeInstanceOf(Uint8Array);
    if (!(init.body instanceof Uint8Array)) throw new Error('Expected serialized multipart body');
    const form = await new Response(new Uint8Array(init.body), { headers: new Headers(init.headers) }).formData();
    expect(form.get('model')).toBe('native:model');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Expected a multipart file');
    expect([file.name, file.type, new Uint8Array(await file.arrayBuffer())]).toEqual(['audio.wav', 'audio/wav', bytes]);
    return new Response('transcript\n', { headers: { 'content-type': 'text/plain' } });
  });
  expect(await execution.result).toMatchObject({
    http: { status: 200, body: null },
    openaiAudioTranscriptions: { kind: 'result', result: new TextEncoder().encode('transcript\n') },
  });
});

it('consumes pre-header transport and abort outcomes and propagates an unexpected panic by identity', async () => {
  const outage = execute(ollamaPipelines.openaiEmbeddings, embeddingsRequest, async () => { throw new HttpTransportError(new Error('unreachable')); });
  await expect(outage.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: {
      kind: 'error', source: 'upstream', error: {
        error: {
          type: 'api_error', message: 'unreachable', provider_specific_fields: {
            name: 'HttpTransportError', stack: expect.any(String),
            cause: { name: 'Error', message: 'unreachable', stack: expect.any(String) },
          },
        },
      },
    },
  });

  const controller = new AbortController();
  controller.abort(new Error('caller left'));
  const fetcher = vi.fn<Fetcher>();
  const cancelled = execute(ollamaPipelines.openaiEmbeddings, embeddingsRequest, fetcher, { controller });
  await expect(cancelled.execution.result).resolves.toEqual({
    http: null,
    openaiEmbeddings: { kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message: 'Upstream request cancelled' } } },
  });
  expect(fetcher).not.toHaveBeenCalled();

  const panic = new TypeError('fetcher bug');
  const unexpected = execute(ollamaPipelines.openaiEmbeddings, embeddingsRequest, async () => { throw panic; });
  await expect(unexpected.execution.result).rejects.toBe(panic);
});

it('delivers the original HTTP 429 before detached usage and account probes finish', async () => {
  const usage = Promise.withResolvers<void>();
  const account = Promise.withResolvers<void>();
  const ollama = { refreshUsage: vi.fn(() => usage.promise), refreshAccount: vi.fn(() => account.promise) };
  const controller = new AbortController();
  const cloud = { ...upstream, config: { ...config, cloudUsage: true } };
  const { execution, background } = execute(ollamaPipelines.openaiEmbeddings, { ...embeddingsRequest, upstream: cloud }, async () =>
    Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '5' } }), { ollama, controller });
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 429, body: null, headers: expect.arrayContaining([['retry-after', '5']]) },
    openaiEmbeddings: { kind: 'error', source: 'upstream', error: { error: { message: 'quota' } } },
  });
  expect(ollama.refreshUsage).toHaveBeenCalledWith({ id: cloud.id, config: cloud.config }, expect.any(Function));
  expect(ollama.refreshAccount).toHaveBeenCalledOnce();
  expect(background).toHaveLength(2);
  controller.abort(new Error('response delivered'));
  const failure = new Error('storage failed', { cause: new Error('disk full') });
  const worker = expect(background[0]).rejects.toBe(failure);
  usage.reject(failure);
  account.resolve();
  await worker;
  await Promise.resolve(background[1]);
});

it('deduplicates active probes and guards persistence against upstream configuration changes', async () => {
  const cloud = { ...config, cloudUsage: true };
  let state: unknown = null;
  let version = 1;
  const record: UpstreamRecord = {
    ...upstream, config: cloud, enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0, createdAt: '', updatedAt: '',
    state, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, hue: 0,
  };
  const repo: UpstreamRuntimeRepo = {
    async recordUpstreamMetric() {},
    upstreams: {
      async getById() { return { ...record, state, version }; },
      async saveState(_id, mutate) { state = mutate(state, version); },
    },
  };
  const service = createOllamaActiveUsageService(repo);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const fetcher = vi.fn<Fetcher>(async () => {
    started.resolve();
    await release.promise;
    return Response.json({ Name: 'Ollama account' });
  });
  const target = { id: upstream.id, config: cloud };
  const pending = service.refreshAccount(target, fetcher);
  try {
    await started.promise;
    await service.refreshAccount(target, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    version++;
  } finally {
    release.resolve();
    await pending;
  }
  expect(state).toBeNull();
  await service.refreshAccount(target, fetcher);
  await service.refreshAccount(target, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(state).toMatchObject({ account: { name: 'Ollama account' }, usageProbe: null });
});

it('refreshes usage and account at their own intervals after inference', async () => {
  const now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const cloud = { ...config, cloudUsage: true };
  let state: unknown = null;
  const record: UpstreamRecord = {
    ...upstream, config: cloud, enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0, createdAt: '', updatedAt: '',
    state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, hue: 0,
  };
  const service = createOllamaActiveUsageService({
    async recordUpstreamMetric() {},
    upstreams: {
      async getById() { return { ...record, state, version: 1 }; },
      async saveState(_id, mutate) { state = mutate(state, 1); },
    },
  });
  const paths: string[] = [];
  const infer = async () => {
    paths.length = 0;
    const { execution, background } = execute(ollamaPipelines.openaiChatCompletions, { ...chatRequest, upstream: { ...upstream, config: cloud } }, async url => {
      const path = new URL(url).pathname.replace(/^\/proxy/u, '');
      paths.push(path);
      if (path === '/api/usage') return Response.json(USAGE_TOTALS);
      if (path === '/api/balance') return Response.json(CREDIT_BALANCE);
      if (path === '/api/me') return Response.json({ Name: 'Ollama account', Plan: 'free' });
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }, { ollama: service });
    const answer = await execution.result;
    if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected Chat Completions stream');
    expect(await Array.fromAsync(execution.read(answer.openaiChatCompletions.stream))).toEqual([]);
    await Promise.all(background);
    return paths.toSorted();
  };
  try {
    expect(await infer()).toEqual(['/api/balance', '/api/me', '/api/usage', '/v1/chat/completions']);
    expect(await infer()).toEqual(['/v1/chat/completions']);
    clock.mockReturnValue(now + OLLAMA_USAGE_PROBE_MIN_INTERVAL_MS);
    expect(await infer()).toEqual(['/api/balance', '/api/usage', '/v1/chat/completions']);
    clock.mockReturnValue(now + OLLAMA_ACCOUNT_PROBE_MIN_INTERVAL_MS);
    expect(await infer()).toEqual(['/api/balance', '/api/me', '/api/usage', '/v1/chat/completions']);
  } finally {
    clock.mockRestore();
  }
});
