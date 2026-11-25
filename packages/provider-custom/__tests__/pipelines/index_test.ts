import { assert, expect, test, vi } from 'vitest';

import type { CustomUpstreamConfig } from '../../src/config.ts';
import { customPipelines } from '../../src/pipelines/index.ts';
import { customUpstreamFact } from '../../src/upstream.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret, type Pipeline } from '@floway-dev/pipeline';
import * as decisions from '@floway-dev/protocols/decision';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import * as rerankProtocol from '@floway-dev/protocols/rerank';
import { toProviderModelFact, type OpenAIImagesEditsRequest, type ProtocolOutcome, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const config: CustomUpstreamConfig = {
  apiKey: 'configured-key',
  baseUrl: 'https://custom.example.test/prefix',
  endpoints: {},
  pathOverrides: { '/embeddings': '/my-embeddings', '/messages': '/native/messages', '/v1beta/models': '/native/models' },
  ingressHeadersRules: [
    { key: 'x-tenant', value: 'before' },
    { key: 'x-tenant', value: null },
    { key: 'x-tenant', value: 'after' },
    { key: 'x-empty', value: '' },
    { key: 'anthropic-version', value: 'operator-version' },
  ],
  modelsFetch: { enabled: false, authStyle: 'bearer' },
  models: [],
};

const record: UpstreamRecord = {
  id: 'custom-upstream',
  name: 'Custom upstream',
  kind: 'custom',
  config,
  state: null,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};
const upstream = customUpstreamFact(record);

const facts = {
  'request.http': move<HttpRequestFact>({
    method: 'POST',
    url: 'https://floway.example.test/v1/client',
    headers: [
      ['X-Tenant', 'first'],
      ['x-tenant', 'second'],
      ['x-empty', 'caller-value'],
      ['x-unconfigured', 'removed'],
      ['authorization', 'Bearer client-key'],
      ['anthropic-beta', 'one,two'],
    ],
    body: { ingress: true },
  }),
  'provider.upstream': move(upstream),
  'provider.model': move(toProviderModelFact(stubProviderModel({ upstreamModelId: 'publisher/model' }))),
};

const transport = (value: Response) => {
  const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({ ok: true, value });
  return { fetch, services: { fetcher: () => fetch } };
};

test.each([true, false])('applies DeepSeek Chat Completions normalization when enabled is %s', async enabled => {
  const prompt = {
    role: 'assistant' as const,
    content: 'replay',
    reasoning_opaque: 'opaque-replay',
    reasoning_items: [{ type: 'reasoning' as const, summary: [{ type: 'summary_text' as const, text: 'past thought' }] }],
  };
  const chunk = {
    id: 'vendor-turn',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'raw-model',
    choices: [{ index: 0, delta: { reasoning_content: 'next thought', content: 'next' }, finish_reason: null }],
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 },
  };
  const upstream = new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  const { services, fetch: fetcher } = transport(upstream);
  const model = facts['provider.model'];
  const exchange = run(customPipelines.openaiChatCompletions, {
    ...facts,
    'provider.model': move({ ...model, enabledFlags: enabled ? ['vendor-deepseek' as const] : [] }),
    'request.openaiChatCompletions': move<OpenAIChatCompletionsPayloadEx>({
      model: 'public',
      messages: [prompt],
      reasoning_effort: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema: { type: 'object' } } },
    }),
  }, { services });
  const result = (await exchange.result)['response.openaiChatCompletions'];
  if (result.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const items = await Array.fromAsync(result.stream);
  await exchange.done;

  const wire = JSON.parse(String(fetcher.mock.calls[0][1].body)) as Record<string, unknown>;
  expect(fetcher.mock.calls[0][0]).toBe('https://custom.example.test/prefix/v1/chat/completions');
  expect(wire).toMatchObject({ model: 'publisher/model', stream: true });
  if (enabled) {
    expect(wire).toMatchObject({
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages: [{ role: 'assistant', content: 'replay', reasoning_content: 'past thought' }],
    });
    expect(wire).not.toHaveProperty('reasoning_effort');
    expect(wire).not.toHaveProperty('messages.0.reasoning_opaque');
    expect(wire).not.toHaveProperty('messages.0.reasoning_items');
    expect(items).toMatchObject([{
      ok: true,
      value: {
        choices: [{ delta: { reasoning_text: 'next thought', content: 'next' } }],
        usage: { prompt_tokens_details: { cached_tokens: 4 } },
      },
    }]);
    expect(items[0]).not.toHaveProperty('value.choices.0.delta.reasoning_content');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_cache_hit_tokens');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_cache_miss_tokens');
  } else {
    expect(wire).toMatchObject({
      reasoning_effort: 'none',
      response_format: { type: 'json_schema' },
      messages: [prompt],
    });
    expect(wire).not.toHaveProperty('thinking');
    expect(items).toMatchObject([{ ok: true, value: chunk }]);
    expect(items[0]).not.toHaveProperty('value.choices.0.delta.reasoning_text');
    expect(items[0]).not.toHaveProperty('value.usage.prompt_tokens_details');
  }
});

test('keeps a bodyless Anthropic count-tokens success', async () => {
  const upstream = new Response(null, { status: 204, headers: { 'x-upstream': 'empty-count' } });
  const { services } = transport(upstream);
  const exchange = run(customPipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public', messages: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.http']).toMatchObject({ status: 204, headers: [['x-upstream', 'empty-count']], body: null });
  expect(answer['response.anthropicMessages']).toEqual({ kind: 'result', result: null });
});

test.each([
  { status: 204, body: null },
  { status: 205, body: null },
  { status: 200, body: '' },
  { status: 200, body: 'null' },
])('distinguishes an empty Gemini count-tokens body from JSON null at $status', async ({ status, body }) => {
  const { services } = transport(new Response(body, { status, headers: { 'x-upstream': 'count' } }));
  const exchange = run(customPipelines.geminiGenerateContentCountTokens, {
    ...facts,
    'request.geminiGenerateContent': move({ contents: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.http']).toMatchObject({ status, headers: expect.arrayContaining([['x-upstream', 'count']]), body: null });
  if (body === 'null') expect(answer['response.geminiGenerateContent']).toMatchObject({ kind: 'error', source: 'upstream' });
  else expect(answer['response.geminiGenerateContent']).toEqual({ kind: 'result', result: null });
});

test.each([
  { flags: ['vendor-deepseek'] as const, wire: { thinking: { type: 'disabled' } } },
  { flags: ['vendor-qwen'] as const, wire: { enable_thinking: false } },
  { flags: ['vendor-deepseek', 'vendor-qwen'] as const, wire: { thinking: { type: 'disabled' } } },
  { flags: [] as const, wire: { reasoning: { effort: 'none', summary: 'detailed' } } },
])('shapes Responses reasoning for $flags', async ({ flags, wire }) => {
  const { fetch, services } = transport(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const exchange = run(customPipelines.openaiResponses, {
    ...facts,
    'provider.model': move({ ...facts['provider.model'], enabledFlags: flags }),
    'request.openaiResponses': move({ model: 'public', input: [], reasoning: { effort: 'none' as const, summary: 'detailed' as const } }),
  }, { services });
  const outcome = (await exchange.result)['response.openaiResponses'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toEqual([]);
  await exchange.done;

  const body = JSON.parse(String(fetch.mock.calls[0][1].body)) as Record<string, unknown>;
  expect(body).toEqual({ model: 'publisher/model', input: [], stream: true, ...wire });
});

test('Qwen disables thinking without rewriting Chat Completions response fields', async () => {
  const chunk = { id: 'unit', object: 'chat.completion.chunk', created: 1, model: 'publisher/model', choices: [], usage: { cached_tokens: 4 } };
  const { fetch, services } = transport(new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const exchange = run(customPipelines.openaiChatCompletions, {
    ...facts,
    'provider.model': move({ ...facts['provider.model'], enabledFlags: ['vendor-qwen' as const] }),
    'request.openaiChatCompletions': move<OpenAIChatCompletionsPayloadEx>({ model: 'public', messages: [], reasoning_effort: 'none' }),
  }, { services });
  const outcome = (await exchange.result)['response.openaiChatCompletions'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toEqual([{ ok: true, value: chunk }]);
  await exchange.done;
  expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toEqual({ model: 'publisher/model', messages: [], stream: true, enable_thinking: false });
});

test('embeddings rebuilds repeated header fields and carries a non-JSON upstream error', async () => {
  expect(upstream.config.apiKey).toBeInstanceOf(Secret);
  expect(JSON.stringify(upstream)).not.toContain('configured-key');
  expect(upstream.config.ingressHeadersRules).toEqual(config.ingressHeadersRules);
  const { fetch, services } = transport(new Response('<p>Over quota</p>', { status: 429, headers: { 'retry-after': '5' } }));
  const exchange = run(customPipelines.openaiEmbeddings, {
    ...facts,
    'request.openaiEmbeddings': move({ model: 'public-model', input: 'text' }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;

  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://custom.example.test/prefix/my-embeddings');
  expect(options.headers).toEqual([
    ['x-tenant', 'before'],
    ['x-tenant', 'first'],
    ['x-tenant', 'second'],
    ['x-tenant', 'after'],
    ['x-empty', ''],
    ['anthropic-version', 'operator-version'],
    ['content-type', 'application/json'],
    ['authorization', 'Bearer configured-key'],
  ]);
  expect(JSON.parse(String(options.body))).toEqual({ model: 'publisher/model', input: 'text' });
  expect(answer).toMatchObject({
    'response.http': { status: 429, body: null, headers: expect.arrayContaining([['retry-after', '5']]) },
    'response.openaiEmbeddings': { kind: 'error', source: 'upstream', error: { error: { message: '<p>Over quota</p>' } } },
    'response.modelKey': 'publisher/model',
  });
  expect(answer).not.toHaveProperty('response.transport');
});

test('Anthropic count-tokens preserves its beta header and uses the overridden messages path', async () => {
  const { fetch, services } = transport(Response.json({ input_tokens: 14, vendor: 'extension' }));
  const exchange = run(customPipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public-model', messages: [] }),
  }, { services });

  expect((await exchange.result)['response.anthropicMessages']).toEqual({ kind: 'result', result: { input_tokens: 14, vendor: 'extension' } });
  await exchange.done;
  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://custom.example.test/prefix/native/messages/count_tokens');
  expect(options.headers).toEqual(expect.arrayContaining([
    ['x-api-key', 'configured-key'],
    ['anthropic-version', 'operator-version'],
    ['anthropic-beta', 'one,two'],
  ]));
  expect(JSON.parse(String(options.body))).toEqual({ model: 'publisher/model', messages: [] });
});

test('Gemini count-tokens writes the qualified model in the generation envelope', async () => {
  const { fetch, services } = transport(Response.json({ totalTokens: 7 }));
  const exchange = run(customPipelines.geminiGenerateContentCountTokens, {
    ...facts,
    'provider.model': move(toProviderModelFact(stubProviderModel({ upstreamModelId: 'models/model/id' }))),
    'request.geminiGenerateContent': move({ generateContentRequest: { model: 'models/public', contents: [], systemInstruction: { parts: [{ text: 'Count this too' }] } } }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer).toMatchObject({
    'response.geminiGenerateContent': { kind: 'result', result: { totalTokens: 7 } },
    'response.modelKey': 'model/id',
  });
  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://custom.example.test/prefix/native/models/model%2Fid:countTokens');
  expect(options.headers).toContainEqual(['x-goog-api-key', 'configured-key']);
  expect(JSON.parse(String(options.body))).toEqual({
    generateContentRequest: { model: 'models/model/id', contents: [], systemInstruction: { parts: [{ text: 'Count this too' }] } },
  });
});

test('rerank parses vendor scores with ordinary number semantics and rejects malformed success', async () => {
  const request = {
    ...facts,
    'provider.model': move(toProviderModelFact(stubProviderModel({
      upstreamModelId: 'vendor/reranker',
      rerankTarget: { protocol: 'cohere-v2', path: '/rerank' },
    }))),
    'request.rerank': move<CanonicalRerankRequest>({
      sourceProtocol: 'cohere-v2',
      raw: { query: 'best match', documents: ['one', 'two'] },
      query: 'best match',
      documents: ['one', 'two'],
    }),
  };
  const valid = transport(new Response('{"results":[{"index":1,"relevance_score":0.9000}]}'));
  const succeeded = run(customPipelines.rerank, request, { services: valid.services });
  expect((await succeeded.result)['response.rerank']).toMatchObject({
    kind: 'result', result: { results: [{ index: 1, relevanceScore: 0.9 }], raw: { results: [{ index: 1, relevance_score: 0.9 }] } },
  });
  await succeeded.done;
  expect(valid.fetch.mock.calls[0][0]).toBe('https://custom.example.test/prefix/rerank');
  expect(JSON.parse(String(valid.fetch.mock.calls[0][1].body))).toEqual({
    model: 'vendor/reranker',
    query: 'best match',
    documents: ['one', 'two'],
  });

  const invalid = transport(Response.json({ results: 'wrong shape' }));
  const failed = run(customPipelines.rerank, request, { services: invalid.services });
  expect((await failed.result)['response.rerank']).toMatchObject({ kind: 'error', source: 'upstream' });
  await failed.done;
});

test.each([false, true])('rerank drains an out-of-range response and propagates a parser bug when injected (%s)', async injectBug => {
  const bug = new TypeError('rerank parser bug');
  const response = Response.json({ results: [{ index: 8, relevance_score: 1 }] });
  const { services } = transport(response);
  const parse = injectBug ? vi.spyOn(rerankProtocol, 'parseRerankResponse').mockImplementationOnce(() => { throw bug; }) : undefined;
  try {
    const exchange = run(customPipelines.rerank, {
      ...facts,
      'provider.model': move(toProviderModelFact(stubProviderModel({ rerankTarget: { protocol: 'cohere-v2' } }))),
      'request.rerank': move<CanonicalRerankRequest>({ sourceProtocol: 'voyage-v1', raw: {}, query: 'best match', documents: ['one'], returnDocuments: true }),
    }, { services });
    if (injectBug) {
      await expect(exchange.result).rejects.toBe(bug);
      await expect(exchange.done).rejects.toBe(bug);
    } else {
      expect((await exchange.result)['response.rerank']).toMatchObject({
        kind: 'error', source: 'upstream', cause: expect.objectContaining({ message: 'Rerank response result index 8 is outside the request documents array' }),
      });
      await exchange.done;
    }
    expect(response.bodyUsed).toBe(true);
    expect(response.body?.locked).toBe(false);
  } finally {
    parse?.mockRestore();
  }
});

test('OpenAI Completions selects streaming from the request and requires the sentinel', async () => {
  const chunk = { id: 'completion', object: 'text_completion', created: 1, model: 'publisher/model', choices: [{ index: 0, text: 'hello', finish_reason: 'stop' }] };
  const completions = (stream: boolean, response: Response) => {
    const { fetch, services } = transport(response);
    const exchange = run(customPipelines.openaiCompletions, {
      ...facts,
      'request.openaiCompletions': move({ model: 'public-model', prompt: 'hello', stream }),
    }, { services });
    return { exchange, fetch };
  };
  const scalar = completions(false, Response.json(chunk));
  expect((await scalar.exchange.result)['response.openaiCompletions']).toEqual({ kind: 'result', result: chunk });
  await scalar.exchange.done;
  expect(JSON.parse(String(scalar.fetch.mock.calls[0][1].body)).stream).toBe(false);

  const truncated = completions(true, new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
  const outcome = (await truncated.exchange.result)['response.openaiCompletions'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toMatchObject([
    { ok: true, value: chunk },
    { ok: false, error: { kind: 'protocol' } },
  ]);
  await truncated.exchange.done;
  expect(JSON.parse(String(truncated.fetch.mock.calls[0][1].body)).stream).toBe(true);
});

test.each([
  { rules: [null], incoming: [], expected: [] },
  { rules: [null], incoming: ['client-a', 'client-b'], expected: ['client-a', 'client-b'] },
  { rules: ['one', null], incoming: [], expected: ['one'] },
  { rules: ['one', null], incoming: ['client-a', 'client-b'], expected: ['one', 'client-a', 'client-b'] },
  { rules: ['', 'one'], incoming: [], expected: ['', 'one'] },
  { rules: ['', 'one'], incoming: ['client-a', 'client-b'], expected: ['', 'one'] },
])('resolves Custom header rules $rules for input fields $incoming', async ({ rules, incoming, expected }) => {
  const ingressHeadersRules = rules.map(value => ({ key: 'x-route', value }));
  const { fetch, services } = transport(Response.json({ data: [] }));
  const exchange = run(customPipelines.openaiEmbeddings, {
    ...facts,
    'provider.upstream': move(customUpstreamFact({ ...record, config: { ...config, ingressHeadersRules } })),
    'request.http': move({ ...facts['request.http'], headers: incoming.map((value): [string, string] => ['X-Route', value]) }),
    'request.openaiEmbeddings': move({ model: 'public', input: 'text' }),
  }, { services });
  await exchange.result;
  await exchange.done;
  const lines = fetch.mock.calls[0][1].headers as [string, string][];
  expect(lines.filter(([name]) => name === 'x-route').map(([, value]) => value)).toEqual(expected);
});

test.each([
  ['https://generativelanguage.googleapis.com', 'gemini-3-flash'],
  ['https://gemini-proxy.example.test/api/gemini', 'models/gemini-3-flash'],
])('Gemini generation forms the model action URL beneath %s', async (baseUrl, upstreamModelId) => {
  const { pathOverrides: _pathOverrides, ...settings } = config;
  const { fetch, services } = transport(sse('{"candidates":[{"finishReason":"STOP"}]}'));
  const payload = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] };
  const exchange = run(customPipelines.geminiGenerateContent, {
    ...facts,
    'provider.upstream': move(customUpstreamFact({ ...record, config: { ...settings, baseUrl } })),
    'provider.model': move(toProviderModelFact(stubProviderModel({ upstreamModelId }))),
    'request.geminiGenerateContent': move(payload),
  }, { services });
  const answer = await exchange.result;
  const outcome = answer['response.geminiGenerateContent'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toMatchObject([{ ok: true, value: { candidates: [{ finishReason: 'STOP' }] } }]);
  await exchange.done;
  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe(`${baseUrl}/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse`);
  expect(options.method).toBe('POST');
  expect(JSON.parse(String(options.body))).toEqual(payload);
  expect(new Headers(options.headers).get('x-goog-api-key')).toBe('configured-key');
  expect(new Headers(options.headers).get('authorization')).toBeNull();
  expect(answer['response.modelKey']).toBe('gemini-3-flash');
});

test('Custom compact and Alpha Search use their configured paths', async () => {
  const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>()
    .mockResolvedValueOnce({ ok: true, value: Response.json({ id: 'compact', object: 'response.compaction', output: [] }) })
    .mockResolvedValueOnce({ ok: true, value: Response.json({ results: [] }) });
  const services = { fetcher: () => fetch };
  const configured = {
    ...facts,
    'provider.upstream': move(customUpstreamFact({
      ...record,
      config: { ...config, pathOverrides: { '/responses': '/native/responses', '/alpha/search': '/native/search' } },
    })),
  };
  const compact = run(customPipelines.openaiResponsesCompact, {
    ...configured,
    'request.openaiResponses': move({ model: 'public', input: [] }),
  }, { services });
  expect((await compact.result)['response.openaiResponses'].kind).toBe('result');
  await compact.done;
  const search = run(customPipelines.alphaSearch, {
    ...configured,
    'request.alphaSearch': move({ query: 'text' }),
  }, { services });
  expect((await search.result)['response.alphaSearch'].kind).toBe('result');
  await search.done;
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://custom.example.test/prefix/native/responses/compact',
    'https://custom.example.test/prefix/native/search',
  ]);
});

test.each(['openaiChatCompletions', 'anthropicMessagesCountTokens'] as const)('anonymous Custom %s sends only serialized body headers', async operation => {
  const { fetch, services } = transport(Response.json({ error: { message: 'overloaded' } }, { status: 503 }));
  const anonymous = {
    ...facts,
    'provider.upstream': move(customUpstreamFact({ ...record, config: { ...config, apiKey: '', ingressHeadersRules: [] } })),
    'request.http': move({ ...facts['request.http'], headers: [] }),
  };
  const exchange = operation === 'openaiChatCompletions'
    ? run(customPipelines.openaiChatCompletions, { ...anonymous, 'request.openaiChatCompletions': move({ model: 'public', messages: [] }) }, { services })
    : run(customPipelines.anthropicMessagesCountTokens, { ...anonymous, 'request.anthropicMessages': move({ model: 'public', messages: [] }) }, { services });
  await exchange.result;
  await exchange.done;
  expect(fetch.mock.calls[0][1].headers).toEqual([['content-type', 'application/json']]);
});

const sse = (data: string): Response => new Response(`data: ${data}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

const verifyOperation = <Input, Key extends string, Output extends Record<Key, ProtocolOutcome<unknown, unknown>>>(
  pipeline: Pipeline<Input, Output, ProviderServices>,
  input: NoInfer<Input>,
  key: Key,
  success: () => Response,
  expectedKind: 'result' | 'stream',
): void => {
  test.each(['success', 'upstream error'] as const)(`${pipeline.name} handles %s`, async variant => {
    const error = { error: { message: 'Temporary upstream failure', detail: 'Keep extension fields' } };
    const value = variant === 'success' ? success() : Response.json(error, { status: 503 });
    const { fetch, services } = transport(value);
    const exchange = run(pipeline, input, { services });
    const answer = await exchange.result;
    const outcome = answer[key];
    if (outcome.kind === 'stream') {
      const items = await Array.fromAsync(outcome.stream);
      expect(items.every(item => item.ok)).toBe(true);
    }
    await exchange.done;
    expect(fetch).toHaveBeenCalledOnce();
    const [[, options]] = fetch.mock.calls;
    expect(options.headers).toEqual(expect.arrayContaining([
      ['x-tenant', 'before'], ['x-tenant', 'first'], ['x-tenant', 'second'], ['x-tenant', 'after'],
    ]));
    if (expectedKind === 'stream' && (key === 'response.anthropicMessages' || key === 'response.openaiResponses' || key === 'response.openaiChatCompletions')) {
      expect(JSON.parse(String(options.body))).toMatchObject({ stream: true });
    } else if (key === 'response.openaiEmbeddings' || key === 'response.anthropicMessages') {
      expect(JSON.parse(String(options.body))).not.toHaveProperty('stream');
    }
    expect(answer).toMatchObject({ 'response.http': { status: variant === 'success' ? 200 : 503, body: null } });
    if (variant === 'success') expect(outcome.kind).toBe(expectedKind);
    else expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
  });
};

verifyOperation(customPipelines.alphaSearch, {
  ...facts,
  'request.alphaSearch': move({ query: 'Find matches' }),
}, 'response.alphaSearch', () => Response.json({ results: [] }), 'result');

verifyOperation(customPipelines.anthropicMessages, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [], max_tokens: 8 }),
}, 'response.anthropicMessages', () => sse('{"type":"message_stop"}'), 'stream');

verifyOperation(customPipelines.anthropicMessagesCountTokens, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [] }),
}, 'response.anthropicMessages', () => Response.json({ input_tokens: 8 }), 'result');

const decisionFacts = {
  ...facts,
  'provider.model': move(toProviderModelFact(stubProviderModel({ decisionTarget: { protocol: 'typesafe-systemone' } }))),
  'request.decision': move<CanonicalDecisionRequest>({ sourceProtocol: 'typesafe-systemone', raw: { state: 'evidence', questions: {} }, state: { kind: 'text', value: 'evidence' }, questions: [] }),
};
verifyOperation(customPipelines.decision, decisionFacts, 'response.decision', () => new Response('{"answers":{"choice":{"type":"noul","noul":0.5000}}}', { headers: { 'content-type': 'application/json' } }), 'result');

test.each([false, true])('Decision drains an invalid response and propagates a parser bug when injected (%s)', async injectBug => {
  const bug = new TypeError('Decision parser bug');
  const response = Response.json({ answers: [] });
  const { services } = transport(response);
  const parse = injectBug ? vi.spyOn(decisions, 'parseDecisionResponse').mockImplementationOnce(() => { throw bug; }) : undefined;
  try {
    const exchange = run(customPipelines.decision, decisionFacts, { services });
    if (injectBug) {
      await expect(exchange.result).rejects.toBe(bug);
      await expect(exchange.done).rejects.toBe(bug);
    } else {
      expect((await exchange.result)['response.decision']).toMatchObject({ kind: 'error', source: 'upstream', error: { answers: [] } });
      await exchange.done;
    }
    expect(response.bodyUsed).toBe(true);
    expect(response.body?.locked).toBe(false);
  } finally {
    parse?.mockRestore();
  }
});

verifyOperation(customPipelines.geminiGenerateContent, {
  ...facts,
  'request.geminiGenerateContent': move({ contents: [] }),
}, 'response.geminiGenerateContent', () => sse('{"candidates":[{"finishReason":"STOP"}]}'), 'stream');

verifyOperation(customPipelines.geminiGenerateContentCountTokens, {
  ...facts,
  'request.geminiGenerateContent': move({ contents: [] }),
}, 'response.geminiGenerateContent', () => Response.json({ totalTokens: 8 }), 'result');

verifyOperation(customPipelines.openaiAudioTranscriptions, {
  ...facts,
  'request.openaiAudioTranscriptions': move({ entries: [{ name: 'model', value: 'public' }] }),
}, 'response.openaiAudioTranscriptions', () => sse('{"type":"transcript.text.done","text":"speech"}'), 'stream');

verifyOperation(customPipelines.openaiChatCompletions, {
  ...facts,
  'request.openaiChatCompletions': move({ model: 'public', messages: [] }),
}, 'response.openaiChatCompletions', () => sse('{"id":"unit","object":"chat.completion.chunk","created":1,"model":"unit","choices":[]}'), 'stream');

verifyOperation(customPipelines.openaiCompletions, {
  ...facts,
  'request.openaiCompletions': move({ model: 'public', prompt: 'hello' }),
}, 'response.openaiCompletions', () => Response.json({ id: 'done', object: 'text_completion', created: 1, model: 'unit', choices: [] }), 'result');

verifyOperation(customPipelines.openaiEmbeddings, {
  ...facts,
  'request.openaiEmbeddings': move({ model: 'public', input: 'text' }),
}, 'response.openaiEmbeddings', () => Response.json({ data: [] }), 'result');

verifyOperation(customPipelines.openaiImagesEdits, {
  ...facts,
  'request.openaiImagesEdits': move<OpenAIImagesEditsRequest>({ images: [{ type: 'reference', reference: { file_id: 'file-image' } }], parameters: { prompt: 'Make monochrome' } }),
}, 'response.openaiImagesEdits', () => Response.json({ data: [] }), 'result');

verifyOperation(customPipelines.openaiImagesGenerations, {
  ...facts,
  'request.openaiImagesGenerations': move({ model: 'public', prompt: 'Draw a circle' }),
}, 'response.openaiImagesGenerations', () => Response.json({ data: [] }), 'result');

test('streams requested OpenAI Images generations through the completed event', async () => {
  const partial = { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'preview' };
  const complete = { type: 'image_generation.completed', b64_json: 'final', usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } };
  const { services, fetch } = transport(new Response(
    `event: ${partial.type}\ndata: ${JSON.stringify(partial)}\n\nevent: ${complete.type}\ndata: ${JSON.stringify(complete)}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  ));
  const handle = run(customPipelines.openaiImagesGenerations, {
    ...facts,
    'request.openaiImagesGenerations': move({ model: 'public', prompt: 'Draw a circle', stream: true, partial_images: 1 }),
  }, { services });
  const outcome = (await handle.result)['response.openaiImagesGenerations'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toEqual([{ ok: true, value: partial }, { ok: true, value: complete }]);
  await handle.done;
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0][1].body))).toMatchObject({ model: 'publisher/model', stream: true, partial_images: 1 });
});

verifyOperation(customPipelines.openaiResponses, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [] }),
}, 'response.openaiResponses', () => sse('[DONE]'), 'stream');

verifyOperation(customPipelines.openaiResponsesCompact, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [], prompt_cache_options: null }),
}, 'response.openaiResponses', () => Response.json({ id: 'compact', object: 'response.compaction', output: [] }), 'result');

verifyOperation(customPipelines.rerank, {
  ...facts,
  'provider.model': move(toProviderModelFact(stubProviderModel({ rerankTarget: { protocol: 'cohere-v2' } }))),
  'request.rerank': move<CanonicalRerankRequest>({ sourceProtocol: 'cohere-v2', raw: { query: 'text', documents: ['one'] }, query: 'text', documents: ['one'] }),
}, 'response.rerank', () => Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }), 'result');
