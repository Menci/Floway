import { assert, expect, test, vi } from 'vitest';

import { kimiCodePipelines } from '../../src/pipelines/index.ts';
import type { KimiCodeServices } from '../../src/service.ts';
import { kimiCodeUpstreamFact } from '../../src/upstream-fact.ts';
import { config, record } from '../fixtures.ts';
import { getHeaders, type HttpRequestFact } from '@floway-dev/http';
import { move, run, Secret } from '@floway-dev/pipeline';
import { toProviderModelFact } from '@floway-dev/provider';
import { stubProviderModel } from '@floway-dev/test-utils';

const request = move<HttpRequestFact>({
  method: 'POST',
  url: 'https://floway.test/',
  headers: [['authorization', Secret.from('Bearer client')], ['x-extra', 'stripped'], ['anthropic-beta', 'one'], ['Anthropic-Beta', 'two']],
  body: null,
});
const upstream = move(kimiCodeUpstreamFact(record({ id: 'kimi' })));
const model = move(toProviderModelFact(stubProviderModel({
  id: 'kimi-model', upstreamModelId: 'standard-id', providerData: { standardModelId: 'standard-id', fastModelId: 'fast-id' },
})));
const entry = { 'request.http': request, 'provider.upstream': upstream, 'provider.model': model };

const service = (respond: (url: string, init: Parameters<ReturnType<KimiCodeServices['fetcher']>>[1]) => Response) => {
  const fetcher = vi.fn<ReturnType<KimiCodeServices['fetcher']>>(async (url, init) => ({ ok: true, value: respond(url, init) }));
  const observeResponse = vi.fn<KimiCodeServices['kimiCode']['observeResponse']>().mockResolvedValue({ persisted: true });
  return { services: { fetcher: () => fetcher, kimiCode: { observeResponse } }, fetcher, observeResponse };
};

const sse = (body: string) => new Response(body, {
  status: 201,
  headers: { 'content-type': 'text/event-stream', 'x-upstream': 'yes' },
});

test('only exposes the four implemented operations', () => {
  expect(Object.keys(kimiCodePipelines).sort()).toEqual(['anthropicMessages', 'anthropicMessagesCountTokens', 'openaiChatCompletions', 'openaiResponses']);
  expect(Object.isFrozen(kimiCodePipelines)).toBe(true);
  expect(upstream.config.apiKey).toBeInstanceOf(Secret);
});

test('serializes OpenAI Chat Completions to the chosen lane and projects the served priority tier', async () => {
  const { services, fetcher, observeResponse } = service(() => sse(
    'data: {"id":"turn","object":"chat.completion.chunk","created":1,"model":"fast-id","choices":[],"service_tier":"default"}\n\ndata: [DONE]\n\n',
  ));
  const exchange = run(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'request.openaiChatCompletions': move({ model: 'public-id', messages: [], stream: false, service_tier: 'fast', vendor_extension: 'keep' }),
  }, { services });
  const response = await exchange.result;
  expect(response['response.modelKey']).toBe('fast-id');
  expect(response['response.http']).toMatchObject({ status: 201, body: null });
  const result = response['response.openaiChatCompletions'];
  assert(result.kind === 'stream');
  expect(await Array.fromAsync(result.stream)).toMatchObject([{ ok: true, value: { model: 'fast-id', service_tier: 'priority' } }]);
  await exchange.done;
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://api.kimi.com/coding/v1/chat/completions', {
    method: 'POST', signal: expect.any(AbortSignal),
    headers: [['content-type', 'application/json'], ['authorization', `Bearer ${config.apiKey}`]],
    body: JSON.stringify({ model: 'fast-id', messages: [], stream: true, service_tier: 'priority', vendor_extension: 'keep' }),
  });
  expect(observeResponse).toHaveBeenCalledExactlyOnceWith(upstream, 201, expect.any(Function));
});

test('uses the standard OpenAI Responses lane and reports its tier when priority falls back', async () => {
  const { services, fetcher } = service(() => sse(
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"turn","object":"response","status":"completed","model":"standard-id","output":[]}}\n\n',
  ));
  const exchange = run(kimiCodePipelines.openaiResponses, {
    ...entry,
    'provider.model': move({ ...model, providerData: { standardModelId: 'standard-id' } }),
    'request.openaiResponses': move({ model: 'public-id', input: [], service_tier: 'priority' }),
  }, { services });
  const response = await exchange.result;
  expect(response['response.modelKey']).toBe('standard-id');
  const result = response['response.openaiResponses'];
  assert(result.kind === 'stream');
  expect(await Array.fromAsync(result.stream)).toContainEqual(expect.objectContaining({
    ok: true, value: expect.objectContaining({ type: 'response.completed', response: expect.objectContaining({ service_tier: 'default' }) }),
  }));
  await exchange.done;
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.kimi.com/coding/v1/responses');
  expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify({ model: 'standard-id', input: [], service_tier: 'default', stream: true }));
});

test('keeps repeated Anthropic beta headers, strips recognized speed, and projects speed into usage', async () => {
  const { services, fetcher } = service(() => sse(
    'event: message_start\ndata: {"type":"message_start","message":{"id":"turn","type":"message","role":"assistant","model":"fast-id","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ));
  const exchange = run(kimiCodePipelines.anthropicMessages, {
    ...entry,
    'request.anthropicMessages': move({ model: 'public-id', max_tokens: 32, messages: [], speed: 'fast' }),
  }, { services });
  const response = await exchange.result;
  const result = response['response.anthropicMessages'];
  assert(result.kind === 'stream');
  expect(await Array.fromAsync(result.stream)).toMatchObject([
    { ok: true, value: { type: 'message_start', message: { usage: { speed: 'fast' } } } },
    { ok: true, value: { type: 'message_stop' } },
  ]);
  await exchange.done;
  expect(response['response.modelKey']).toBe('fast-id');
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.kimi.com/coding/v1/messages');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    headers: [['anthropic-beta', 'one'], ['Anthropic-Beta', 'two'], ['content-type', 'application/json'], ['authorization', `Bearer ${config.apiKey}`]],
    body: JSON.stringify({ model: 'fast-id', max_tokens: 32, messages: [], stream: true }),
  });
});

test('counts tokens as a scalar and preserves open speed strings without scheduling probes', async () => {
  const { services, fetcher, observeResponse } = service(() => Response.json({ input_tokens: 42 }));
  const exchange = run(kimiCodePipelines.anthropicMessagesCountTokens, {
    ...entry,
    'request.anthropicMessages': move({ model: 'public-id', messages: [], speed: 'future-speed' }),
  }, { services });
  const response = await exchange.result;
  expect(response['response.anthropicMessages']).toEqual({ kind: 'result', result: { input_tokens: 42 } });
  expect(response['response.modelKey']).toBe('standard-id');
  await exchange.done;
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
  expect(fetcher.mock.calls[0]?.[1].body).toBe(JSON.stringify({ model: 'standard-id', messages: [], speed: 'future-speed' }));
  expect(observeResponse).not.toHaveBeenCalled();
});

test('returns a local rejection for fast-only OpenAI requests without priority and unsupported Anthropic fast', async () => {
  const { services, fetcher, observeResponse } = service(() => { throw new Error('unexpected HTTP dispatch'); });
  const openai = run(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'provider.model': move({ ...model, upstreamModelId: 'fast-id', providerData: { fastModelId: 'fast-id' } }),
    'request.openaiChatCompletions': move({ model: 'kimi-model', messages: [] }),
  }, { services });
  const anthropic = run(kimiCodePipelines.anthropicMessagesCountTokens, {
    ...entry,
    'provider.model': move({ ...model, providerData: { standardModelId: 'standard-id' } }),
    'request.anthropicMessages': move({ model: 'public-id', messages: [], speed: 'fast' }),
  }, { services });
  expect(await openai.result).toMatchObject({
    'response.http': { status: 400 },
    'response.modelKey': 'fast-id',
    'response.openaiChatCompletions': { kind: 'error', source: 'local', error: { error: { message: expect.stringContaining('only available with fast mode') } } },
  });
  expect(await anthropic.result).toMatchObject({
    'response.http': { status: 400 },
    'response.modelKey': 'standard-id',
    'response.anthropicMessages': { kind: 'error', source: 'local', error: { type: 'error', error: { message: expect.stringContaining('does not support fast mode') } } },
  });
  await Promise.all([openai.done, anthropic.done]);
  expect(fetcher).not.toHaveBeenCalled();
  expect(observeResponse).not.toHaveBeenCalled();
});

test('preserves upstream response status and repeated headers while a probe settles in the background', async () => {
  const probe = Promise.withResolvers<{ persisted: false; error: Error }>();
  const { services, observeResponse } = service(() => new Response('quota exhausted', {
    status: 429, headers: [['set-cookie', 'a=one'], ['set-cookie', 'a=two']],
  }));
  observeResponse.mockReturnValueOnce(probe.promise);
  const exchange = run(kimiCodePipelines.openaiChatCompletions, {
    ...entry,
    'request.openaiChatCompletions': move({ model: 'public-id', messages: [] }),
  }, { services });
  const response = await exchange.result;
  const http = response['response.http'];
  assert(http !== null);
  expect(http.status).toBe(429);
  expect(getHeaders(http.headers, 'set-cookie')).toEqual(['a=one', 'a=two']);
  expect(response['response.openaiChatCompletions']).toMatchObject({ kind: 'error', source: 'upstream', error: { error: { message: 'quota exhausted' } } });
  const settled = vi.fn();
  void exchange.done.then(settled);
  expect(settled).not.toHaveBeenCalled();
  expect(observeResponse).toHaveBeenCalledExactlyOnceWith(upstream, 429, expect.any(Function));
  probe.resolve({ persisted: false, error: new Error('usage probe failed') });
  await exchange.done;
  expect(settled).toHaveBeenCalledOnce();
});
