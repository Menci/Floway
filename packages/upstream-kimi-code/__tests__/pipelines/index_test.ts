import { expect, expectTypeOf, test } from 'vitest';

import { kimiCodePipelines, type KimiCodePipelineServices, type KimiCodeService } from '../../src/index.ts';
import { prepareKimiCodeRequest } from '../../src/pipelines/request.ts';
import { MAX_KIMI_CODE_COUNT_TOKENS_BODY_BYTES, MAX_KIMI_CODE_ERROR_BODY_BYTES } from '../../src/pipelines/response.ts';
import { config, record } from '../fixtures.ts';
import { HttpTransportError, type Fetcher } from '@floway-dev/http';
import { asEntry, run } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsAssistantMessageEx } from '@floway-dev/protocols/openai-chat-completions';
import { toUpstreamModelSnapshot, toUpstreamSnapshot, type UpstreamModel, type UpstreamOperation, type UpstreamPipeline, type UpstreamRequest } from '@floway-dev/upstream';

const upstream = toUpstreamSnapshot(record({ config: { ...config, region: 'overseas' } }));
const model: UpstreamModel = {
  id: 'kimi-k3.1-pro', upstreamModelId: 'native', upstreamData: { standardModelId: 'native', fastModelId: 'native-fast' },
  kind: 'chat', endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  limits: {}, enabledFlags: new Set(['vendor-kimi']), opaqueBlobCompatibilityScope: { bindToUpstream: true },
};
const requestBase = {
  model: toUpstreamModelSnapshot(model), upstream,
  http: {
    method: 'PUT', url: 'https://gateway.test/v1', body: new Uint8Array([0]),
    headers: [['authorization', 'Floway authorization'], ['anthropic-beta', 'one'], ['Anthropic-Beta', 'two'], ['x-client-secret', 'hidden']] satisfies [string, string][],
  },
};
const chatRequest: UpstreamRequest<'openaiChatCompletions'> = {
  ...requestBase,
  openaiChatCompletions: { model: model.id, messages: [], service_tier: 'fast', stream: false },
};
const countRequest: UpstreamRequest<'anthropicMessagesCountTokens'> = {
  ...requestBase,
  anthropicMessagesCountTokens: { model: model.id, messages: [], speed: 'fast' },
};

const noProbes: KimiCodeService = { refreshProbes: async () => {} };

const runWith = <Op extends UpstreamOperation>(
  pipeline: UpstreamPipeline<Op, KimiCodePipelineServices, 'usageModelKey'>,
  facts: UpstreamRequest<Op>,
  fetcher: Fetcher,
  options: { service?: KimiCodeService; signal?: AbortSignal } = {},
) => {
  const background: Promise<unknown>[] = [];
  const execution = run(asEntry(pipeline), facts, {
    services: { fetcher: id => { expect(id).toBe(upstream.id); return fetcher; }, kimiCode: options.service ?? noProbes },
    signal: options.signal ?? new AbortController().signal,
    waitUntil: work => {
      background.push(work);
      void work.catch(() => {});
    },
  });
  return { execution, background };
};

const sse = (body: BodyInit): Response => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

test('exposes an exact closed Kimi Code operation boundary', () => {
  expectTypeOf(kimiCodePipelines.openaiChatCompletions).toEqualTypeOf<UpstreamPipeline<'openaiChatCompletions', KimiCodePipelineServices, 'usageModelKey'>>();
  expectTypeOf(kimiCodePipelines.openaiResponses).toEqualTypeOf<UpstreamPipeline<'openaiResponses', KimiCodePipelineServices, 'usageModelKey'>>();
  expectTypeOf(kimiCodePipelines.anthropicMessages).toEqualTypeOf<UpstreamPipeline<'anthropicMessages', KimiCodePipelineServices, 'usageModelKey'>>();
  expectTypeOf(kimiCodePipelines.anthropicMessagesCountTokens).toEqualTypeOf<UpstreamPipeline<'anthropicMessagesCountTokens', KimiCodePipelineServices, 'usageModelKey'>>();
  expect(Object.keys(kimiCodePipelines)).toEqual(['openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'anthropicMessagesCountTokens']);
  const prepared = prepareKimiCodeRequest({ ...requestBase.http, headers: [] }, upstream, '/chat/completions', { model: 'native' });
  expect(JSON.stringify(prepared.headers)).toBe('[["authorization","[secret]"],["content-type","application/json"]]');
});

test('Chat Completions sends the chosen wire model and reports canonical cached tokens through native done', async () => {
  const payload = { ...chatRequest.openaiChatCompletions, thinking: { type: 'disabled' }, vendor_extension: { arbitrary: 'kept' } };
  const { execution } = runWith(kimiCodePipelines.openaiChatCompletions, { ...chatRequest, openaiChatCompletions: payload }, async (url, init) => {
    expect(url).toBe('https://api.kimi.ai/coding/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', headers: [['authorization', `Bearer ${config.apiKey}`], ['content-type', 'application/json']] });
    expect(init.body).toBe(JSON.stringify({ ...payload, model: 'native-fast', service_tier: 'priority', stream: true }));
    return sse('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"cached_tokens":3,"prompt_tokens_details":{"audio_tokens":0}}}\n\n');
  });
  const answer = await execution.result;
  expect(answer.http).toMatchObject({ status: 200, body: null });
  expect(answer.usageModelKey).toBe('native-fast');
  const outcome = answer.openaiChatCompletions;
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const cursor = execution.read(outcome.stream);
  expect(await cursor.next()).toEqual({
    done: false,
    value: {
      ok: true,
      value: {
        choices: [], service_tier: 'priority',
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { audio_tokens: 0, cached_tokens: 3 } },
      },
    },
  });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
});

test('Chat Completions applies the selected DeepSeek dialect in both directions', async () => {
  const assistant: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'prior answer', reasoning_text: 'prior thought' };
  const { execution } = runWith(kimiCodePipelines.openaiChatCompletions, {
    ...chatRequest,
    model: toUpstreamModelSnapshot({ ...model, enabledFlags: new Set(['vendor-deepseek']) }),
    openaiChatCompletions: {
      ...chatRequest.openaiChatCompletions, messages: [assistant], reasoning_effort: 'none',
      response_format: { type: 'json_schema', json_schema: { name: 'result' } },
    },
  }, async (_url, init) => {
    const request = new Request('https://upstream.test', { method: 'POST', body: String(init.body) });
    await expect(request.json()).resolves.toEqual({
      model: 'native-fast', messages: [{ role: 'assistant', content: 'prior answer', reasoning_content: 'prior thought' }],
      thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, service_tier: 'priority', stream: true,
    });
    return sse('data: {"choices":[{"delta":{"reasoning_content":"thought"}}],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10,"prompt_cache_hit_tokens":3,"prompt_cache_miss_tokens":5}}\n\n');
  });
  const { openaiChatCompletions: outcome } = await execution.result;
  if (outcome.kind !== 'stream') throw new Error('Expected Chat Completions stream');
  const cursor = execution.read(outcome.stream);
  expect(await cursor.next()).toEqual({
    done: false,
    value: {
      ok: true,
      value: {
        choices: [{ delta: { reasoning_text: 'thought' } }], service_tier: 'priority',
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, prompt_tokens_details: { cached_tokens: 3 } },
      },
    },
  });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
});

test('Chat Completions applies the selected Mistral wire fields and output cap', async () => {
  const assistant: OpenAIChatCompletionsAssistantMessageEx = { role: 'assistant', content: 'prior answer', reasoning_text: 'prior thought' };
  const { execution } = runWith(kimiCodePipelines.openaiChatCompletions, {
    ...chatRequest,
    model: toUpstreamModelSnapshot({ ...model, enabledFlags: new Set(['vendor-mistral']) }),
    openaiChatCompletions: {
      ...chatRequest.openaiChatCompletions, messages: [assistant], max_completion_tokens: 19,
      metadata: { user_id: 'private' }, stream_options: { include_usage: true, continuous_usage_stats: true },
    },
  }, async (_url, init) => {
    const request = new Request('https://upstream.test', { method: 'POST', body: String(init.body) });
    await expect(request.json()).resolves.toEqual({
      model: 'native-fast', messages: [{ role: 'assistant', content: 'prior answer' }], max_tokens: 19,
      stream_options: { include_usage: true }, service_tier: 'priority', stream: true,
    });
    return new Response('upstream fixture', { status: 400 });
  });
  await expect(execution.result).resolves.toMatchObject({ openaiChatCompletions: { kind: 'error', source: 'upstream' } });
});

test('Responses rewrites disabled reasoning for a selected Qwen model', async () => {
  const { execution } = runWith(kimiCodePipelines.openaiResponses, {
    ...requestBase,
    model: toUpstreamModelSnapshot({ ...model, enabledFlags: new Set(['vendor-qwen']) }),
    openaiResponses: { model: model.id, input: [], reasoning: { effort: 'none' } },
  }, async (_url, init) => {
    const request = new Request('https://upstream.test', { method: 'POST', body: String(init.body) });
    await expect(request.json()).resolves.toEqual({ model: 'native', input: [], enable_thinking: false, stream: true });
    return new Response('upstream fixture', { status: 400 });
  });
  await expect(execution.result).resolves.toMatchObject({ openaiResponses: { kind: 'error', source: 'upstream' } });
});

test.each([['priority', 'default'], ['future-tier', 'future-tier']])('Responses preserves %s semantics with wire tier %s', async (serviceTier, wireTier) => {
  const { execution } = runWith(kimiCodePipelines.openaiResponses, {
    ...requestBase,
    model: toUpstreamModelSnapshot({ ...model, upstreamData: { standardModelId: 'native' } }),
    openaiResponses: { model: model.id, input: [], service_tier: serviceTier, stream: false },
  }, async (url, init) => {
    expect(url).toBe('https://api.kimi.ai/coding/v1/responses');
    expect(init.body).toBe(JSON.stringify({ model: 'native', input: [], service_tier: wireTier, stream: true }));
    return sse('event: response.completed\ndata: {"type":"response.completed","response":{"id":"turn","status":"completed","output":[]}}\n\n');
  });
  const answer = await execution.result;
  expect(answer).not.toHaveProperty('usageModelKey');
  const outcome = answer.openaiResponses;
  if (outcome.kind !== 'stream') throw new Error('Expected Responses stream');
  const seen: string[] = [];
  for await (const item of execution.read(outcome.stream)) {
    if (!item.ok) throw new Error('Unexpected Responses stream failure', { cause: item.error });
    seen.push(item.value.type);
    if ('response' in item.value) expect(item.value.response.service_tier).toBe(wireTier === 'default' ? 'default' : undefined);
  }
  expect(seen).toContain('response.created');
  expect(seen.at(-1)).toBe('response.completed');
});

test('Messages selects the requested lane and preserves repeated Anthropic beta headers', async () => {
  const { execution } = runWith(kimiCodePipelines.anthropicMessages, {
    ...requestBase, anthropicMessages: { model: model.id, messages: [], max_tokens: 64, speed: 'fast' },
  }, async (url, init) => {
    expect(url).toBe('https://api.kimi.ai/coding/v1/messages');
    expect(init.body).toBe(JSON.stringify({ model: 'native-fast', messages: [], max_tokens: 64, stream: true }));
    expect(init.headers).toEqual([
      ['anthropic-beta', 'one'], ['Anthropic-Beta', 'two'], ['authorization', `Bearer ${config.apiKey}`], ['content-type', 'application/json'],
    ]);
    return sse('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const answer = await execution.result;
  expect(answer.usageModelKey).toBe('native-fast');
  const outcome = answer.anthropicMessages;
  if (outcome.kind !== 'stream') throw new Error('Expected Messages stream');
  const cursor = execution.read(outcome.stream);
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true, value: { type: 'message_start', message: { usage: { speed: 'fast' } } } } });
  expect(await cursor.next()).toMatchObject({ done: false, value: { ok: true, value: { type: 'message_stop' } } });
  expect(await cursor.next()).toEqual({ done: true, value: undefined });
});

test('Messages count_tokens returns a bounded scalar with upstream head and no active probes', async () => {
  const { execution, background } = runWith(kimiCodePipelines.anthropicMessagesCountTokens, countRequest, async (url, init) => {
    expect(url).toBe('https://api.kimi.ai/coding/v1/messages/count_tokens');
    expect(init.body).toBe(JSON.stringify({ model: 'native-fast', messages: [] }));
    return Response.json({ input_tokens: 9, extension: true }, { headers: { 'x-upstream': 'kept' } });
  });
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 200, headers: [['content-type', 'application/json'], ['x-upstream', 'kept']], body: null },
    usageModelKey: 'native-fast', anthropicMessagesCountTokens: { kind: 'result', result: { input_tokens: 9, extension: true } },
  });
  expect(background).toHaveLength(0);
});

test('an unsupported Messages fast selection returns the local 400 before dialing', async () => {
  const { execution } = runWith(kimiCodePipelines.anthropicMessagesCountTokens, {
    ...countRequest, model: toUpstreamModelSnapshot({ ...model, upstreamData: { standardModelId: 'native' } }),
  }, async () => { throw new Error('Unexpected dial'); });
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 400, body: null },
    anthropicMessagesCountTokens: { kind: 'error', source: 'local', error: { type: 'error', error: { type: 'invalid_request_error' } } },
  });
});

test('preserves HTTP error heads and renders plain bodies in the protocol envelope', async () => {
  const headerLines = [['x-upstream', 'one'], ['x-upstream', 'two']] as const;
  const jsonError = { error: { type: 'vendor_limit', message: 'denied' } };
  const json = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => Object.assign(Response.json(jsonError, { status: 403, statusText: 'Denied' }), { headerLines }));
  await expect(json.execution.result).resolves.toEqual({
    http: { status: 403, statusText: 'Denied', headers: headerLines, body: null, startedAt: expect.any(Number) },
    openaiChatCompletions: { kind: 'error', source: 'upstream', error: jsonError }, usageModelKey: 'native-fast',
  });
  const plain = runWith(kimiCodePipelines.anthropicMessagesCountTokens, countRequest, async () => new Response('count rejected', { status: 400 }));
  await expect(plain.execution.result).resolves.toMatchObject({
    http: { status: 400, body: null },
    anthropicMessagesCountTokens: { kind: 'error', source: 'upstream', error: { type: 'error', error: { type: 'invalid_request_error', message: 'count rejected' } } },
  });
});

test('a damaged successful count_tokens body is an expected upstream error', async () => {
  const { execution } = runWith(kimiCodePipelines.anthropicMessagesCountTokens, countRequest, async () => Response.json({ input_tokens: -1 }));
  await expect(execution.result).resolves.toMatchObject({
    http: { status: 200, body: null },
    anthropicMessagesCountTokens: { kind: 'error', source: 'upstream', error: { error: { message: expect.stringContaining('non-negative integer') } } },
  });
});

test.each([[200, MAX_KIMI_CODE_COUNT_TOKENS_BODY_BYTES], [429, MAX_KIMI_CODE_ERROR_BODY_BYTES]])('count_tokens rejects a %i response over its body bound', async (status, bound) => {
  const { execution, background } = runWith(kimiCodePipelines.anthropicMessagesCountTokens, countRequest, async () => new Response(new Uint8Array(bound + 1), { status }));
  await expect(execution.result).rejects.toThrow(`Upstream response body exceeds ${bound} bytes`);
  await Promise.all(background);
});

test('consumes pre-head transport and abort errors while keeping a fetch panic by identity', async () => {
  const outage = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => { throw new HttpTransportError(new Error('dial refused')); });
  await expect(outage.execution.result).resolves.toEqual({
    http: null, usageModelKey: 'native-fast', openaiChatCompletions: {
      kind: 'error', source: 'upstream', error: {
        error: {
          type: 'api_error', message: 'dial refused', provider_specific_fields: {
            name: 'HttpTransportError', stack: expect.any(String),
            cause: { name: 'Error', message: 'dial refused', stack: expect.any(String) },
          },
        },
      },
    },
  });
  expect(outage.background).toHaveLength(0);

  const signal = AbortSignal.abort(new Error('client disconnected'));
  const cancelled = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => { throw new Error('Unexpected dial'); }, { signal });
  await expect(cancelled.execution.result).resolves.toEqual({
    http: null, openaiChatCompletions: { kind: 'error', source: 'local', error: { error: { type: 'invalid_request_error', message: 'Upstream request cancelled' } } },
  });
  const panic = new TypeError('fetch defect');
  const failed = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => { throw panic; });
  await expect(failed.execution.result).rejects.toBe(panic);
});

test('an SSE protocol Err reaches native done while the HTTP source drains', async () => {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode('data: {broken}\n\n'));
    },
  });
  const { execution, background } = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => sse(body));
  const answer = await execution.result;
  if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected stream');
  const cursor = execution.read(answer.openaiChatCompletions.stream);
  try {
    expect(await cursor.next()).toMatchObject({ done: false, value: { ok: false, error: { kind: 'protocol' } } });
    expect(await cursor.next()).toEqual({ done: true, value: undefined });
    expect(background).toHaveLength(2);
  } finally {
    source.close();
  }
  await Promise.all(background);
});

test('preserves post-head stream transport errors and propagates body panics by identity', async () => {
  const transport = new HttpTransportError(new Error('connection reset mid-stream'));
  const panic = new TypeError('unexpected stream bug');
  for (const cause of [transport, panic]) {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(cause); } });
    const { execution, background } = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => sse(body));
    const answer = await execution.result;
    expect(answer.http).toMatchObject({ status: 200, body: null });
    if (answer.openaiChatCompletions.kind !== 'stream') throw new Error('Expected stream');
    const cursor = execution.read(answer.openaiChatCompletions.stream);
    if (cause === panic) {
      await expect(cursor.next()).rejects.toBe(panic);
    } else {
      const failed = await cursor.next();
      if (failed.done || failed.value.ok) throw new Error('Expected a transport error');
      expect(failed.value.error.kind).toBe('transport');
      expect(failed.value.error.cause).toBe(transport);
      expect(await cursor.next()).toEqual({ done: true, value: undefined });
    }
    await Promise.all(background);
  }
});

test('a detached forced probe settles independently after delivery and retains its original failure', async () => {
  const probe = Promise.withResolvers<void>();
  const failure = new Error('quota endpoint failed');
  const observed: unknown[] = [];
  const signal = new AbortController();
  const { execution, background } = runWith(kimiCodePipelines.openaiChatCompletions, chatRequest, async () => new Response('rate limited', { status: 429 }), {
    signal: signal.signal,
    service: {
      refreshProbes(id, currentConfig, _fetcher, forceUsage) {
        observed.push({ id, config: currentConfig, forceUsage });
        return probe.promise;
      },
    },
  });
  await expect(execution.result).resolves.toMatchObject({ http: { status: 429 }, openaiChatCompletions: { kind: 'error', source: 'upstream' } });
  expect(observed).toEqual([{ id: upstream.id, config: { ...config, region: 'overseas' }, forceUsage: true }]);
  expect(background).toHaveLength(1);
  signal.abort(new Error('client finished'));
  probe.reject(failure);
  await expect(background[0]).rejects.toBe(failure);
});
