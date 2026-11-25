import { expect, test, vi } from 'vitest';

import { kimiCodePipelines, toKimiCodeUpstream, type KimiCodeService, type KimiCodeServices } from '../../src/index.ts';
import { config, record } from '../fixtures.ts';
import { UpstreamTransportError, type ProviderFetcher } from '@floway-dev/http';
import { run, type Pipeline } from '@floway-dev/pipeline';
import { toProviderModelFact } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const upstream = toKimiCodeUpstream({ ...record(), configVersion: 4 });
const model = toProviderModelFact(stubProviderModel({
  id: 'public-model',
  upstreamModelId: 'standard-model',
  providerData: { standardModelId: 'standard-model', fastModelId: 'fast-model' },
}));
const entry = {
  'request.http': {
    url: 'https://gateway.example/v1/chat/completions',
    method: 'POST',
    headers: [['authorization', 'client-key'], ['anthropic-beta', 'future-feature'], ['cookie', 'private']] as [string, string][],
    body: new Uint8Array([5]),
  },
  'provider.upstream': upstream,
  'provider.model': model,
};

const host = (fetch: ProviderFetcher, refreshProbes: KimiCodeService['refreshProbes'] = async () => {}) => {
  const pending: Promise<unknown>[] = [];
  const abort = new AbortController();
  return {
    pending,
    abort,
    options: {
      signal: abort.signal,
      waitUntil: (work: Promise<unknown>) => { pending.push(work); },
      services: { fetcher: () => fetch, kimiCode: { refreshProbes } },
    },
  };
};

const withRun = async <Input, Output>(
  pipeline: Pipeline<Input, Output, KimiCodeServices>,
  facts: NoInfer<Input>,
  fetch: ProviderFetcher,
  assert: (running: ReturnType<typeof run<Input, Output, KimiCodeServices>>, pending: Promise<unknown>[]) => Promise<void>,
): Promise<void> => {
  const { options, pending, abort } = host(fetch);
  const running = run(pipeline, facts, options);
  try {
    await assert(running, pending);
    await running.done;
  } finally {
    abort.abort();
    await Promise.all(pending);
  }
};

test('writes the selected wire model and priority tier, then exposes that tier on the response frame', async () => {
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
  const event = { id: 'turn', object: 'chat.completion.chunk', created: 1, model: 'fast-model', choices: [], usage: { ...usage, cached_tokens: 4 } };
  const body = { model: 'public-model', messages: [], service_tier: 'fast', thinking: { type: 'disabled' } };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'fast-model', messages: [], service_tier: 'priority', thinking: { type: 'disabled' }, stream: true,
    });
    expect(init.headers).toEqual([
      ['content-type', 'application/json'],
      ['authorization', `Bearer ${config.apiKey}`],
    ]);
    return { response: new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'provider.model': { ...model, enabledFlags: ['vendor-kimi'] },
    'request.openaiChatCompletions': body,
  }, fetch, async running => {
    const answer = await running.result;
    expect(answer['response.http']).toMatchObject({ status: 200, body: null });
    const outcome = answer['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected chat frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{
      ok: true, value: { ...event, service_tier: 'priority', usage: { ...usage, prompt_tokens_details: { cached_tokens: 4 } } },
    }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.kimi.com/coding/v1/chat/completions', expect.anything());
  });
});

test.each([
  ['priority', 'default'],
  ['future-tier', 'future-tier'],
])('uses the standard Responses lane and reports %s as %s', async (requestTier, servedTier) => {
  const event = {
    type: 'response.completed',
    response: { id: 'turn', status: 'completed', object: 'response', output: [], model: 'standard-model', service_tier: requestTier === 'future-tier' ? requestTier : 'priority' },
  };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'standard-model', input: [], stream: true, service_tier: servedTier,
    });
    return { response: new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(kimiCodePipelines.openaiResponses, {
    ...entry,
    'provider.model': { ...model, providerData: { standardModelId: 'standard-model' } },
    'request.openaiResponses': { model: 'public-model', input: [], service_tier: requestTier },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiResponses'];
    if (outcome.kind !== 'stream') throw new Error('Expected Responses frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toMatchObject([
      { ok: true, value: { type: 'response.created', response: { service_tier: servedTier } } },
      { ok: true, value: { type: 'response.in_progress', response: { service_tier: servedTier } } },
      { ok: true, value: { ...event, response: { ...event.response, service_tier: servedTier } } },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.kimi.com/coding/v1/responses', expect.anything());
  });
});

test.each(['fast', 'standard', 'future-speed'])('preserves the meaning of Anthropic Messages speed %s', async speed => {
  const modelId = speed === 'fast' ? 'fast-model' : 'standard-model';
  const message = { id: 'turn', role: 'assistant', type: 'message', model: modelId, content: [], usage: { input_tokens: 1, output_tokens: 0 } };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('future-feature');
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: modelId, max_tokens: 64, messages: [], stream: true, ...(speed === 'future-speed' && { speed }),
    });
    const data = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return { response: new Response(data, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(kimiCodePipelines.anthropicMessages, {
    ...entry,
    'request.anthropicMessages': { model: 'public-model', max_tokens: 64, messages: [], speed },
  }, fetch, async running => {
    const outcome = (await running.result)['response.anthropicMessages'];
    if (outcome.kind !== 'stream') throw new Error('Expected Messages frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([
      { ok: true, value: { type: 'message_start', message: { ...message, usage: { ...message.usage, ...(speed !== 'future-speed' && { speed }) } } } },
      { ok: true, value: { type: 'message_stop' } },
    ]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.kimi.com/coding/v1/messages', expect.anything());
  });
});

test('rejects unsupported Anthropic fast mode locally with HTTP 400', async () => {
  const fetch = vi.fn<ProviderFetcher>();
  await withRun(kimiCodePipelines.anthropicMessages, {
    ...entry,
    'provider.model': { ...model, providerData: { standardModelId: 'standard-model' } },
    'request.anthropicMessages': { model: 'public-model', max_tokens: 64, messages: [], speed: 'fast' },
  }, fetch, async (running, pending) => {
    expect(await running.result).toEqual({
      'response.http': { status: 400, statusText: '', headers: [['content-type', 'application/json']], body: null },
      'response.anthropicMessages': { kind: 'error', source: 'local', error: { type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('does not support fast mode') } } },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(pending).toHaveLength(0);
  });
});

test('preserves quota response details and completes the request before detached refresh settles', async () => {
  const refresh = Promise.withResolvers<void>();
  const probes = vi.fn<KimiCodeService['refreshProbes']>(() => refresh.promise);
  const error = { error: { type: 'quota_exhausted', message: 'Weekly quota consumed' } };
  const { options, pending, abort } = host(async () => ({
    response: Response.json(error, { status: 429, headers: { 'retry-after': '5' } }),
  }), probes);
  const running = run(kimiCodePipelines.openaiResponses, {
    ...entry,
    'request.openaiResponses': { model: 'public-model', input: [] },
  }, options);
  try {
    expect(await running.result).toEqual({
      'response.http': expect.objectContaining({ status: 429, headers: expect.arrayContaining([['retry-after', '5']]), body: null }),
      'response.openaiResponses': { kind: 'error', source: 'upstream', error },
    });
    await running.done;
    expect(pending).toHaveLength(1);
    expect(probes).toHaveBeenCalledExactlyOnceWith(upstream.id, 4, expect.any(Function), true, expect.any(Function));
  } finally {
    abort.abort();
    refresh.resolve();
    await Promise.all(pending);
  }
});

test('turns a pre-header transport failure into a protocol error and skips active refresh', async () => {
  const fetch = vi.fn<ProviderFetcher>(async () => { throw new UpstreamTransportError(new Error('connection reset')); });
  await withRun(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'request.openaiChatCompletions': { model: 'public-model', messages: [] },
  }, fetch, async (running, pending) => {
    expect(await running.result).toEqual({
      'response.http': null,
      'response.openaiChatCompletions': {
        kind: 'error', source: 'upstream', error: { error: { type: 'api_error', message: 'connection reset' } },
      },
    });
    expect(pending).toHaveLength(0);
  });
});

test('counts with the requested Kimi lane and forwards Anthropic beta without scheduling probes', async () => {
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('future-feature');
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({ model: 'fast-model', messages: [] });
    return { response: Response.json({ input_tokens: 7 }) };
  });
  await withRun(kimiCodePipelines.anthropicMessagesCountTokens, {
    ...entry,
    'request.anthropicMessagesCountTokens': { model: 'public-model', messages: [], speed: 'fast' },
  }, fetch, async (running, pending) => {
    expect((await running.result)['response.anthropicMessagesCountTokens']).toEqual({ kind: 'result', result: { input_tokens: 7 } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://api.kimi.com/coding/v1/messages/count_tokens', expect.anything());
    expect(pending).toHaveLength(0);
  });
});

test('a fast-only model rejects standard Chat Completions and Messages token counts without dialing', async () => {
  const fetch = vi.fn<ProviderFetcher>();
  const fastOnly = { ...entry, 'provider.model': { ...model, providerData: { fastModelId: 'fast-model' } } };
  await withRun(kimiCodePipelines.openaiChatCompletions, {
    ...fastOnly,
    'request.openaiChatCompletions': { model: 'public-model', messages: [], service_tier: 'standard' },
  }, fetch, async running => {
    const answer = await running.result;
    expect(answer['response.http']?.status).toBe(400);
    expect(answer['response.openaiChatCompletions']).toMatchObject({
      kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message: expect.stringContaining('only available with fast mode selected') } },
    });
  });
  await withRun(kimiCodePipelines.anthropicMessagesCountTokens, {
    ...fastOnly,
    'request.anthropicMessagesCountTokens': { model: 'public-model', messages: [], speed: 'standard' },
  }, fetch, async running => {
    const answer = await running.result;
    expect(answer['response.http']?.status).toBe(400);
    expect(answer['response.anthropicMessagesCountTokens']).toMatchObject({
      kind: 'error', source: 'local', error: { type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('only available with fast mode selected') } },
    });
  });
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['vendor-deepseek', 'vendor-qwen', undefined] as const)('applies Chat Completions normalization for the selected flag %s', async flag => {
  const assistant = { role: 'assistant' as const, content: '', reasoning_text: 'prior reasoning' };
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
  const event = {
    id: 'turn',
    choices: [{ index: 0, delta: { reasoning_content: 'next reasoning' } }],
    usage: { ...usage, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 3 },
  };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    const body = await new Response(init.body as Uint8Array<ArrayBuffer>).json();
    expect(body).toEqual({
      model: 'standard-model',
      stream: true,
      ...(flag === 'vendor-deepseek'
        ? { thinking: { type: 'disabled' }, messages: [{ role: 'assistant', content: '', reasoning_content: 'prior reasoning' }] }
        : { messages: [assistant], ...(flag === 'vendor-qwen' ? { enable_thinking: false } : { reasoning_effort: 'none' }) }),
    });
    return { response: new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'provider.model': { ...model, enabledFlags: flag === undefined ? [] : [flag] },
    'request.openaiChatCompletions': { model: 'public-model', messages: [assistant], reasoning_effort: 'none' },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected chat frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{
      ok: true,
      value: flag === 'vendor-deepseek' ? {
        ...event,
        choices: [{ index: 0, delta: { reasoning_text: 'next reasoning' } }],
        usage: { ...usage, prompt_tokens_details: { cached_tokens: 5 } },
      } : event,
    }]);
  });
});

test.each([
  ['vendor-deepseek', { thinking: { type: 'disabled' } }],
  ['vendor-qwen', { enable_thinking: false }],
  [undefined, { reasoning: { effort: 'none' } }],
] as const)('applies Responses normalization for the selected flag %s', async (flag, expected) => {
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'standard-model', stream: true, input: [], ...expected,
    });
    return { response: Response.json({ error: { message: 'sample rejection' } }, { status: 422 }) };
  });
  await withRun(kimiCodePipelines.openaiResponses, {
    ...entry,
    'provider.model': { ...model, enabledFlags: flag === undefined ? [] : [flag] },
    'request.openaiResponses': { model: 'public-model', input: [], reasoning: { effort: 'none' } },
  }, fetch, async running => {
    expect((await running.result)['response.openaiResponses']).toEqual({
      kind: 'error', source: 'upstream', error: { error: { message: 'sample rejection' } },
    });
  });
});
