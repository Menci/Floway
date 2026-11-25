import { assert, expect, test, vi } from 'vitest';

import type { OllamaUpstreamConfig } from '../../src/config.ts';
import { ollamaPipelines } from '../../src/pipelines/index.ts';
import { createOllamaService, type OllamaServices } from '../../src/service.ts';
import { readOllamaUpstreamState } from '../../src/state.ts';
import { ollamaUpstreamFact } from '../../src/upstream.ts';
import { CREDIT_BALANCE, USAGE_TOTALS } from '../usage-fixture.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret, type Pipeline } from '@floway-dev/pipeline';
import type { CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { toProviderModelFact, type ProviderRepo, type ProtocolOutcome, type ProviderServices, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const config: OllamaUpstreamConfig = { baseUrl: 'https://ollama.example.test', apiKey: 'cloud-key', cloudUsage: true, models: [] };
const record: UpstreamRecord = {
  id: 'ollama-upstream',
  name: 'Ollama upstream',
  kind: 'ollama',
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
const facts = {
  'request.http': move<HttpRequestFact>({
    method: 'POST',
    url: 'https://floway.example.test/v1/client',
    headers: [['authorization', 'Bearer caller-key'], ['anthropic-beta', 'one,two']],
    body: null,
  }),
  'provider.upstream': move(ollamaUpstreamFact(record)),
  'provider.model': move(toProviderModelFact(stubProviderModel({ upstreamModelId: 'publisher/model' }))),
};

const repoFixture = () => {
  const saved = { ...record, configVersion: 1 };
  const repo: ProviderRepo = {
    upstreams: {
      getById: vi.fn(async () => ({ ...saved })),
      saveState: async (_id, mutate) => {
        saved.state = mutate(saved.state, saved.configVersion);
      },
    },
    recordUpstreamMetric: vi.fn(async () => {}),
  };
  return { repo, state: () => readOllamaUpstreamState(saved.state) };
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
  const fetcher = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({ ok: true, value: upstream });
  const services = { fetcher: () => fetcher, ollama: { refreshProbes: vi.fn().mockResolvedValue(undefined) } };
  const model = facts['provider.model'];
  const exchange = run(ollamaPipelines.openaiChatCompletions, {
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
  const fetcher = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({ ok: true, value: upstream });
  const services = { fetcher: () => fetcher, ollama: { refreshProbes: vi.fn().mockResolvedValue(undefined) } };
  const exchange = run(ollamaPipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public', messages: [] }),
  }, { services });
  const answer = await exchange.result;
  await exchange.done;
  expect(answer['response.http']).toMatchObject({ status: 204, headers: [['x-upstream', 'empty-count']], body: null });
  expect(answer['response.anthropicMessages']).toEqual({ kind: 'result', result: null });
});

test.each([
  [{ max_completion_tokens: 17 }, { max_tokens: 17 }],
  [{ max_completion_tokens: 17, max_tokens: 9 }, { max_completion_tokens: 17, max_tokens: 9 }],
])('chat shapes output caps for Ollama and accepts normal EOF', async (supplied, expected) => {
  const chunk = { id: 'chunk', object: 'chat.completion.chunk', created: 1, model: 'publisher/model', choices: [] };
  const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({
    ok: true, value: new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const refreshProbes = vi.fn().mockResolvedValue(undefined);
  const exchange = run(ollamaPipelines.openaiChatCompletions, {
    ...facts,
    'provider.upstream': move(ollamaUpstreamFact({ ...record, config: { baseUrl: config.baseUrl, cloudUsage: false, models: [] } })),
    'request.openaiChatCompletions': move({ model: 'public-model', messages: [], stream: false, ...supplied }),
  }, { services: { fetcher: () => fetch, ollama: { refreshProbes } } });
  const answer = await exchange.result;
  const outcome = answer['response.openaiChatCompletions'];
  assert(outcome.kind === 'stream');
  expect(await Array.fromAsync(outcome.stream)).toEqual([{ ok: true, value: chunk }]);
  await exchange.done;

  const [[url, options]] = fetch.mock.calls;
  expect(url).toBe('https://ollama.example.test/v1/chat/completions');
  expect(options.headers).toEqual([['content-type', 'application/json']]);
  expect(JSON.parse(String(options.body))).toEqual({ model: 'publisher/model', messages: [], stream: true, ...expected });
  expect(refreshProbes).not.toHaveBeenCalled();
});

test('shared probes finish after request abort and persist their fresh readings once', async () => {
  expect(facts['provider.upstream'].config.apiKey).toBeInstanceOf(Secret);
  expect(JSON.stringify(facts['provider.upstream'])).not.toContain('cloud-key');
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const probes: string[] = [];
  const { repo, state } = repoFixture();
  const fetch: ReturnType<ProviderServices['fetcher']> = async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/v1/chat/completions') {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, value: new Response('Over quota', { status: 429 }) };
    }

    probes.push(pathname);
    if (probes.length === 3) ready.resolve();
    expect(init.signal).toBeUndefined();
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer cloud-key');
    await release.promise;
    switch (pathname) {
    case '/api/usage': return { ok: true, value: Response.json(USAGE_TOTALS) };
    case '/api/balance': return { ok: true, value: Response.json(CREDIT_BALANCE) };
    case '/api/me': return { ok: true, value: Response.json({ Plan: 'pro', Name: 'Operator', Email: 'operator@example.test' }) };
    default: throw new Error(`Unexpected path ${pathname}`);
    }
  };
  const services = { fetcher: () => fetch, ollama: createOllamaService(repo) };
  const request = {
    ...facts,
    'request.openaiChatCompletions': move({ model: 'public-model', messages: [] }),
  };
  const abort = new AbortController();
  const first = run(ollamaPipelines.openaiChatCompletions, request, { services, signal: abort.signal });
  const second = run(ollamaPipelines.openaiChatCompletions, request, { services });
  for (const exchange of [first, second]) {
    expect((await exchange.result)['response.openaiChatCompletions']).toMatchObject({
      kind: 'error', source: 'upstream', error: { error: { message: 'Over quota' } },
    });
  }
  await ready.promise;
  abort.abort(new Error('Client disconnected'));
  expect(state()).toEqual({ account: null, usageProbe: null });
  release.resolve();
  await Promise.all([first.done, second.done]);

  expect(probes.toSorted()).toEqual(['/api/balance', '/api/me', '/api/usage']);
  expect(repo.recordUpstreamMetric).toHaveBeenCalled();
  expect(state()).toMatchObject({
    account: { plan: 'pro', name: 'Operator' },
    usageProbe: { error: null, observation: { data: { usage: USAGE_TOTALS, balance: CREDIT_BALANCE } } },
  });

  const third = run(ollamaPipelines.openaiChatCompletions, request, { services });
  await third.result;
  await third.done;
  expect(probes).toHaveLength(3);
});

test('failed background usage persists its error while the account and client results complete', async () => {
  const { repo, state } = repoFixture();
  const fetch: ReturnType<ProviderServices['fetcher']> = async url => {
    switch (new URL(url).pathname) {
    case '/v1/embeddings': return { ok: true, value: Response.json({ data: [] }) };
    case '/api/usage': return { ok: true, value: Response.json(USAGE_TOTALS) };
    case '/api/balance': return { ok: true, value: new Response('Unauthorized', { status: 401 }) };
    case '/api/me': return { ok: true, value: Response.json({ Plan: 'free' }) };
    default: throw new Error(`Unexpected URL ${url}`);
    }
  };
  const exchange = run(ollamaPipelines.openaiEmbeddings, {
    ...facts,
    'request.openaiEmbeddings': move({ model: 'public-model', input: 'text' }),
  }, { services: { fetcher: () => fetch, ollama: createOllamaService(repo) } });
  expect((await exchange.result)['response.openaiEmbeddings']).toEqual({ kind: 'result', result: { data: [] } });
  await exchange.done;
  expect(state()).toMatchObject({
    account: { plan: 'free' },
    usageProbe: { error: 'Ollama /api/balance returned 401: Unauthorized', observation: null },
  });
  expect(repo.recordUpstreamMetric).not.toHaveBeenCalled();
});

test('malformed streaming success and token counting leave probes unarmed', async () => {
  const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>()
    .mockResolvedValueOnce({ ok: true, value: Response.json({ error: 'non-SSE' }) })
    .mockResolvedValueOnce({ ok: true, value: Response.json({ input_tokens: 12 }) });
  const refreshProbes = vi.fn().mockResolvedValue(undefined);
  const services = { fetcher: () => fetch, ollama: { refreshProbes } };
  const chat = run(ollamaPipelines.openaiChatCompletions, {
    ...facts,
    'request.openaiChatCompletions': move({ model: 'public-model', messages: [] }),
  }, { services });
  expect((await chat.result)['response.openaiChatCompletions']).toMatchObject({ kind: 'error', source: 'upstream' });
  await chat.done;

  const count = run(ollamaPipelines.anthropicMessagesCountTokens, {
    ...facts,
    'request.anthropicMessages': move({ model: 'public-model', messages: [] }),
  }, { services });
  expect((await count.result)['response.anthropicMessages']).toEqual({ kind: 'result', result: { input_tokens: 12 } });
  await count.done;
  expect(fetch.mock.calls[1][1].headers).toEqual([
    ['anthropic-beta', 'one,two'],
    ['content-type', 'application/json'],
    ['authorization', 'Bearer cloud-key'],
  ]);
  expect(refreshProbes).not.toHaveBeenCalled();
});

const sse = (data: string): Response => new Response(`data: ${data}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

const verifyOperation = <Input, Key extends string, Output extends Record<Key, ProtocolOutcome<unknown, unknown>>>(
  pipeline: Pipeline<Input, Output, OllamaServices>,
  input: NoInfer<Input>,
  key: Key,
  success: () => Response,
  expectedKind: 'result' | 'stream',
): void => {
  test.each(['success', 'upstream error'] as const)(`${pipeline.name} handles %s`, async variant => {
    const error = { error: { message: 'Temporary upstream failure', detail: 'Keep extension fields' } };
    const value = variant === 'success' ? success() : Response.json(error, { status: 503 });
    const fetch = vi.fn<ReturnType<ProviderServices['fetcher']>>().mockResolvedValue({ ok: true, value });
    const services = { fetcher: () => fetch, ollama: { refreshProbes: vi.fn().mockResolvedValue(undefined) } };
    const exchange = run(pipeline, input, { services });
    const answer = await exchange.result;
    const outcome = answer[key];
    if (outcome.kind === 'stream') {
      const items = await Array.fromAsync(outcome.stream);
      expect(items.every(item => item.ok)).toBe(true);
    }
    await exchange.done;
    expect(fetch).toHaveBeenCalledOnce();
    expect(answer).toMatchObject({ 'response.http': { status: variant === 'success' ? 200 : 503, body: null } });
    if (variant === 'success') expect(outcome.kind).toBe(expectedKind);
    else expect(outcome).toEqual({ kind: 'error', source: 'upstream', error });
  });
};

verifyOperation(ollamaPipelines.anthropicMessages, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [], max_tokens: 8 }),
}, 'response.anthropicMessages', () => sse('{"type":"message_stop"}'), 'stream');

verifyOperation(ollamaPipelines.anthropicMessagesCountTokens, {
  ...facts,
  'request.anthropicMessages': move({ model: 'public', messages: [] }),
}, 'response.anthropicMessages', () => Response.json({ input_tokens: 8 }), 'result');

verifyOperation(ollamaPipelines.decision, {
  ...facts,
  'provider.model': move(toProviderModelFact(stubProviderModel({ decisionTarget: { protocol: 'typesafe-systemone' } }))),
  'request.decision': move<CanonicalDecisionRequest>({ sourceProtocol: 'typesafe-systemone', raw: { state: 'evidence', questions: {} }, state: { kind: 'text', value: 'evidence' }, questions: [] }),
}, 'response.decision', () => new Response('{"answers":{"choice":{"type":"noul","noul":0.5000}}}', { headers: { 'content-type': 'application/json' } }), 'result');

verifyOperation(ollamaPipelines.openaiAudioTranscriptions, {
  ...facts,
  'request.openaiAudioTranscriptions': move({ entries: [{ name: 'model', value: 'public' }] }),
}, 'response.openaiAudioTranscriptions', () => sse('{"type":"transcript.text.done","text":"speech"}'), 'stream');

verifyOperation(ollamaPipelines.openaiChatCompletions, {
  ...facts,
  'request.openaiChatCompletions': move({ model: 'public', messages: [] }),
}, 'response.openaiChatCompletions', () => sse('{"id":"unit","object":"chat.completion.chunk","created":1,"model":"unit","choices":[]}'), 'stream');

verifyOperation(ollamaPipelines.openaiCompletions, {
  ...facts,
  'request.openaiCompletions': move({ model: 'public', prompt: 'hello' }),
}, 'response.openaiCompletions', () => Response.json({ id: 'done', object: 'text_completion', created: 1, model: 'unit', choices: [] }), 'result');

verifyOperation(ollamaPipelines.openaiEmbeddings, {
  ...facts,
  'request.openaiEmbeddings': move({ model: 'public', input: 'text' }),
}, 'response.openaiEmbeddings', () => Response.json({ data: [] }), 'result');

verifyOperation(ollamaPipelines.openaiResponses, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [] }),
}, 'response.openaiResponses', () => sse('[DONE]'), 'stream');

verifyOperation(ollamaPipelines.openaiResponsesCompact, {
  ...facts,
  'request.openaiResponses': move({ model: 'public', input: [], prompt_cache_options: null }),
}, 'response.openaiResponses', () => Response.json({ id: 'compact', object: 'response.compaction', output: [] }), 'result');
