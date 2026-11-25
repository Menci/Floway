import { expect, test, vi } from 'vitest';

import { ollamaPipelines, toOllamaUpstream, type OllamaService, type OllamaServices } from '../../src/index.ts';
import type { ProviderFetcher } from '@floway-dev/http';
import { run, type Pipeline, type RunEvent } from '@floway-dev/pipeline';
import { DEFAULT_DECISION_PATHS, parseDecisionRequest } from '@floway-dev/protocols/decision';
import { toProviderModelFact, type UpstreamRecord } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const record: UpstreamRecord & { configVersion: number } = {
  id: 'ollama-upstream', name: 'Ollama', kind: 'ollama', enabled: true,
  usageRefreshIntervalMinutes: 0, sortOrder: 0, createdAt: '', updatedAt: '',
  config: { baseUrl: 'https://ollama.example', apiKey: 'example-key', cloudUsage: true },
  state: null, modelsCache: null, flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], modelPrefix: null, hue: 210, configVersion: 4,
};
const model = toProviderModelFact(stubProviderModel({ id: 'public-model', upstreamModelId: 'native-model' }));
const entry = {
  'request.http': {
    url: 'https://gateway.example/v1/chat/completions',
    method: 'POST',
    headers: [['authorization', 'client-key'], ['anthropic-beta', 'future-feature'], ['cookie', 'private']] as [string, string][],
    body: new Uint8Array([5]),
  },
  'provider.upstream': toOllamaUpstream(record),
  'provider.model': model,
};

const host = (fetch: ProviderFetcher, refreshProbes: OllamaService['refreshProbes'] = async () => {}) => {
  const pending: Promise<unknown>[] = [];
  const abort = new AbortController();
  const events: RunEvent[] = [];
  return {
    pending,
    abort,
    events,
    options: {
      signal: abort.signal,
      waitUntil: (work: Promise<unknown>) => { pending.push(work); },
      services: { fetcher: () => fetch, ollama: { refreshProbes } },
      events: (event: RunEvent) => { events.push(event); },
    },
  };
};

const withRun = async <Input, Output>(
  pipeline: Pipeline<Input, Output, OllamaServices>,
  facts: NoInfer<Input>,
  fetch: ProviderFetcher,
  assert: (running: ReturnType<typeof run<Input, Output, OllamaServices>>, pending: Promise<unknown>[]) => Promise<void>,
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

test.each([
  [{ max_completion_tokens: 96 }, { max_tokens: 96 }],
  [{ max_completion_tokens: 0 }, { max_tokens: 0 }],
  [{ max_completion_tokens: 96, max_tokens: null }, { max_completion_tokens: 96, max_tokens: null }],
])('sends the Ollama output cap and decodes a chat stream at EOF', async (limits, expected) => {
  const event = { id: 'turn', object: 'chat.completion.chunk', created: 1, model: 'native-model', choices: [] };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'native-model', messages: [], stream: true, ...expected,
    });
    expect(init.headers).toEqual([['content-type', 'application/json'], ['authorization', 'Bearer example-key']]);
    return { response: new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(ollamaPipelines.openaiChatCompletions, {
    ...entry,
    'request.openaiChatCompletions': { model: 'public-model', messages: [], ...limits },
  }, fetch, async running => {
    const answer = await running.result;
    expect(answer['response.http']).toMatchObject({ status: 200, body: null });
    const outcome = answer['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected chat frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: event }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/chat/completions', expect.anything());
  });
});

test('preserves rate-limit metadata and records a later detached probe failure on its stage', async () => {
  const refresh = Promise.withResolvers<void>();
  const probes = vi.fn<OllamaService['refreshProbes']>(() => refresh.promise);
  const { options, pending, abort, events } = host(async () => ({
    response: new Response('account limit reached', { status: 429, headers: { 'retry-after': '5' } }),
  }), probes);
  const running = run(ollamaPipelines.openaiEmbeddings, {
    ...entry,
    'request.openaiEmbeddings': { model: 'public-model', input: 'hello' },
  }, options);
  try {
    expect(await running.result).toEqual({
      'response.http': expect.objectContaining({ status: 429, headers: expect.arrayContaining([['retry-after', '5']]), body: null }),
      'response.openaiEmbeddings': { kind: 'error', source: 'upstream', error: { error: { type: 'invalid_request_error', message: 'account limit reached' } } },
    });
    await running.done;
    expect(pending).toHaveLength(1);
    expect(probes).toHaveBeenCalledExactlyOnceWith(record.id, 4, expect.any(Function), expect.any(Function));
    const refreshStage = events.flatMap(event => event.type === 'stage.entered' && event.name === 'ollama.refresh-probes' ? [event.stageId] : []);
    expect(refreshStage).toHaveLength(1);
    expect(events.some(event => event.type === 'log')).toBe(false);
    abort.abort();
    refresh.reject(new Error('usage endpoint unavailable'));
    await Promise.all(pending);
    const logs = events.filter(event => event.type === 'log');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.stageId).toBe(refreshStage[0]);
    expect(JSON.stringify(logs[0])).toContain('usage endpoint unavailable');
  } finally {
    abort.abort();
    refresh.resolve();
    await Promise.all(pending);
  }
});

test('rebuilds multipart with the upstream model ID and returns the original non-stream response bytes', async () => {
  const rawAudio = new Uint8Array([17, 0, 252]);
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    const body = await new Response(init.body as Uint8Array<ArrayBuffer>, { headers: new Headers(init.headers) }).formData();
    expect(body.getAll('model')).toEqual(['native-model']);
    expect(body.getAll('hint')).toEqual(['first', 'second']);
    const file = body.get('file');
    if (!(file instanceof File)) throw new Error('Expected transcription file');
    expect(file.name).toBe('sample.wav');
    expect(file.type).toBe('audio/wav');
    expect(await file.bytes()).toEqual(rawAudio);
    return { response: new Response('{ "text": "hello" }', { headers: { 'content-type': 'application/json' } }) };
  });
  await withRun(ollamaPipelines.openaiAudioTranscriptions, {
    ...entry,
    'request.openaiAudioTranscriptions': {
      entries: [
        { name: 'file', value: { name: 'sample.wav', mediaType: 'audio/wav', bytes: rawAudio } },
        { name: 'hint', value: 'first' },
        { name: 'model', value: 'public-model' },
        { name: 'hint', value: 'second' },
      ],
    },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiAudioTranscriptions'];
    expect(outcome).toEqual({ kind: 'result', result: new TextEncoder().encode('{ "text": "hello" }') });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/audio/transcriptions', expect.anything());
  });
});

test('counts messages with the protocol header and no Ollama probe', async () => {
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('future-feature');
    return { response: Response.json({ input_tokens: 9 }) };
  });
  await withRun(ollamaPipelines.anthropicMessagesCountTokens, {
    ...entry,
    'request.anthropicMessagesCountTokens': { model: 'public-model', messages: [] },
  }, fetch, async (running, pending) => {
    expect((await running.result)['response.anthropicMessagesCountTokens']).toEqual({ kind: 'result', result: { input_tokens: 9 } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/messages/count_tokens', expect.anything());
    expect(pending).toHaveLength(0);
  });
});

test('self-hosted Ollama requests omit authorization and account probing', async () => {
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    return { response: Response.json({ data: [] }) };
  });
  await withRun(ollamaPipelines.openaiEmbeddings, {
    ...entry,
    'provider.upstream': toOllamaUpstream({ ...record, config: { baseUrl: 'http://127.0.0.1:11434' } }),
    'request.openaiEmbeddings': { model: 'public-model', input: 'hello' },
  }, fetch, async (running, pending) => {
    expect((await running.result)['response.openaiEmbeddings']).toEqual({ kind: 'result', result: { data: [] } });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:11434/v1/embeddings', expect.anything());
    expect(pending).toHaveLength(0);
  });
});

test.each(['vendor-deepseek', 'vendor-qwen', undefined] as const)('normalizes Ollama Chat Completions for the selected flag %s', async flag => {
  const assistant = { role: 'assistant' as const, content: '', reasoning_text: 'previous reasoning' };
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
  const event = { id: 'turn', choices: [{ index: 0, delta: { reasoning_content: 'new reasoning' } }], usage: { ...usage, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 3 } };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    const body = await new Response(init.body as Uint8Array<ArrayBuffer>).json();
    expect(body).toEqual({
      model: 'native-model',
      stream: true,
      ...(flag === 'vendor-deepseek'
        ? { thinking: { type: 'disabled' }, messages: [{ role: 'assistant', content: '', reasoning_content: 'previous reasoning' }] }
        : { messages: [assistant], ...(flag === 'vendor-qwen' ? { enable_thinking: false } : { reasoning_effort: 'none' }) }),
    });
    return { response: new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(ollamaPipelines.openaiChatCompletions, {
    ...entry,
    'provider.model': { ...model, enabledFlags: flag === undefined ? [] : [flag] },
    'request.openaiChatCompletions': { model: 'public-model', messages: [assistant], reasoning_effort: 'none' },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected chat frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{
      ok: true,
      value: flag === 'vendor-deepseek'
        ? { ...event, choices: [{ index: 0, delta: { reasoning_text: 'new reasoning' } }], usage: { ...usage, prompt_tokens_details: { cached_tokens: 5 } } }
        : event,
    }]);
  });
});

test.each([true, false])('applies the Ollama Kimi usage flag when enabled=%s', async enabled => {
  const usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 };
  const event = { id: 'turn', choices: [], usage: { ...usage, cached_tokens: 6 } };
  const fetch = vi.fn<ProviderFetcher>(async () => ({
    response: new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  }));
  await withRun(ollamaPipelines.openaiChatCompletions, {
    ...entry,
    'provider.model': { ...model, enabledFlags: enabled ? ['vendor-kimi'] : [] },
    'request.openaiChatCompletions': { model: 'public-model', messages: [] },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiChatCompletions'];
    if (outcome.kind !== 'stream') throw new Error('Expected chat frames');
    expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{
      ok: true,
      value: enabled ? { ...event, usage: { ...usage, prompt_tokens_details: { cached_tokens: 6 } } } : event,
    }]);
  });
});

test.each([
  ['vendor-deepseek', { thinking: { type: 'disabled' } }],
  ['vendor-qwen', { enable_thinking: false }],
  [undefined, { reasoning: { effort: 'none' } }],
] as const)('normalizes Ollama Responses for the selected flag %s', async (flag, expected) => {
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'native-model', stream: true, input: [], ...expected,
    });
    const event = { type: 'response.completed', response: { id: 'turn', status: 'completed', object: 'response', output: [] } };
    return { response: new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) };
  });
  await withRun(ollamaPipelines.openaiResponses, {
    ...entry,
    'provider.model': { ...model, enabledFlags: flag === undefined ? [] : [flag] },
    'request.openaiResponses': { model: 'public-model', input: [], reasoning: { effort: 'none' } },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiResponses'];
    if (outcome.kind !== 'stream') throw new Error('Expected Responses frames');
    expect((await Array.fromAsync(running.read(outcome.stream))).at(-1)).toMatchObject({
      ok: true, value: { type: 'response.completed', response: { id: 'turn' } },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/responses', expect.anything());
  });
});

test.each([true, false])('uses the requested Ollama Completions delivery mode (stream=%s)', async stream => {
  const completion = {
    id: 'turn', model: 'native-model', object: 'text_completion', created: 1,
    choices: [{ index: 0, text: 'text', finish_reason: 'stop', vendor_extension: { order: 1 } }],
    vendor_extension: { timing: 12 },
  };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({ model: 'native-model', prompt: 'say text', stream });
    return {
      response: stream ? new Response(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : Response.json(completion),
    };
  });
  await withRun(ollamaPipelines.openaiCompletions, {
    ...entry,
    'request.openaiCompletions': { model: 'public-model', prompt: 'say text', stream },
  }, fetch, async running => {
    const outcome = (await running.result)['response.openaiCompletions'];
    if (stream) {
      if (outcome.kind !== 'stream') throw new Error('Expected Completions frames');
      expect(await Array.fromAsync(running.read(outcome.stream))).toEqual([{ ok: true, value: completion }]);
    } else {
      expect(outcome).toEqual({ kind: 'result', result: completion });
    }
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/completions', expect.anything());
  });
});

test('sends Compact requests using only the compact wire fields', async () => {
  const compact = { id: 'compact', object: 'response.compaction', output: [], vendor_extension: { timing: 12 } };
  const fetch = vi.fn<ProviderFetcher>(async (_url, init) => {
    expect(await new Response(init.body as Uint8Array<ArrayBuffer>).json()).toEqual({
      model: 'native-model', input: [], prompt_cache_options: null,
    });
    return { response: Response.json(compact) };
  });
  const body = { model: 'public-model', input: [], store: true, temperature: 0, prompt_cache_options: null };
  await withRun(ollamaPipelines.openaiResponsesCompact, {
    ...entry,
    'request.openaiResponsesCompact': body,
  }, fetch, async running => {
    expect((await running.result)['response.openaiResponsesCompact']).toEqual({ kind: 'result', result: compact });
    expect(fetch).toHaveBeenCalledExactlyOnceWith('https://ollama.example/v1/responses/compact', expect.anything());
  });
});

test('rejects malformed success choices and compact output items', async () => {
  const completion = { id: 'turn', model: 'native-model', object: 'text_completion', created: 1, choices: [null] };
  await withRun(ollamaPipelines.openaiCompletions, {
    ...entry,
    'request.openaiCompletions': { model: 'public-model', prompt: 'say text' },
  }, async () => ({ response: Response.json(completion) }), async running => {
    expect((await running.result)['response.openaiCompletions']).toMatchObject({ kind: 'error', source: 'upstream' });
  });
  const compact = { id: 'compact', object: 'response.compaction', output: [{ type: 'compaction', encrypted_content: false }] };
  await withRun(ollamaPipelines.openaiResponsesCompact, {
    ...entry,
    'request.openaiResponsesCompact': { model: 'public-model', input: [] },
  }, async () => ({ response: Response.json(compact) }), async running => {
    expect((await running.result)['response.openaiResponsesCompact']).toMatchObject({ kind: 'error', source: 'upstream' });
  });
});

const invalidDecision = '{ "answers": { "damaged": { "type": "choice", "choice": "damaged", "confidence": 0.9, "probabilities": {"damaged": "invalid"} } } }';
test.each([
  { sameDialect: true, body: '{ "answers": { "damaged": { "type": "noul", "noul": 1.0 } } }', malformed: false },
  { sameDialect: false, body: '{ "answers": { "damaged": { "type": "noul", "noul": 0.75 } } }', malformed: false },
  { sameDialect: true, body: '{ "unexpected_response": [] }', malformed: true },
  { sameDialect: true, body: invalidDecision, malformed: true },
  { sameDialect: false, body: invalidDecision, malformed: true },
])('checks Ollama Decision responses with same dialect=$sameDialect and body=$body', async ({ sameDialect, body, malformed }) => {
  const fetch = vi.fn<ProviderFetcher>(async () => ({ response: new Response(body, { headers: { 'content-type': 'application/json' } }) }));
  const { request } = sameDialect
    ? parseDecisionRequest('typesafe-systemone', { model: 'public-model', state: 'A damaged box', questions: { damaged: { type: 'noul', instructions: 'Is it damaged?' } } })
    : parseDecisionRequest('openai-decisions', { model: 'public-model', input: 'A damaged box', questions: [{ type: 'predicate', name: 'damaged', instructions: 'Is it damaged?' }] });
  await withRun(ollamaPipelines.decision, {
    ...entry,
    'provider.model': { ...model, decisionTarget: { protocol: 'typesafe-systemone' } },
    'request.decision': request,
  }, fetch, async (running, pending) => {
    const outcome = (await running.result)['response.decision'];
    if (malformed) {
      expect(outcome).toMatchObject({ kind: 'error', source: 'upstream' });
    } else if (sameDialect) {
      expect(outcome).toEqual({ kind: 'result', result: new TextEncoder().encode(body) });
    } else {
      expect(outcome).toMatchObject({ kind: 'result', result: { answers: [{ type: 'noul', name: 'damaged', noul: 0.75 }] } });
    }
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`https://ollama.example${DEFAULT_DECISION_PATHS['typesafe-systemone']}`, expect.anything());
    expect(pending).toHaveLength(0);
  });
});
