import { expect, test, vi } from 'vitest';

import { customCandidate, jsonBody, operationHost, requestFor } from './fixtures.ts';
import { anthropicMessagesCountTokensIngress, geminiGenerateContentCountTokensIngress } from '../../../../src/data-plane/non-chat/count-tokens/pipeline.ts';
import { getHeader, type FetchInit } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

const anthropic = (id = 'count') => customCandidate(id, { anthropicMessages: {} });
const messages = [{ role: 'user', content: 'hello' }];

test('counts each dispatched Anthropic attempt for performance and no calls for billing', async () => {
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    expect(new Headers(init.headers).get('authorization')).toBeNull();
    expect(new Headers(init.headers).get('x-api-key')).toBe('key');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'wire-model', messages });
    return new URL(url).hostname === 'limited.example'
      ? Response.json({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '5' } })
      : Response.json({ input_tokens: 0, vendor_count: 'retained' }, { headers: { 'x-upstream-response': 'second' } });
  });
  const host = operationHost([anthropic('limited'), anthropic('available')], fetcher);
  const running = run(anthropicMessagesCountTokensIngress, requestFor('/v1/messages/count_tokens', {
    model: 'public-model', messages, max_tokens: 128, stream: true,
  }), host.options);
  const answer = await running.result;
  expect(answer.candidate).toEqual({ upstreamId: 'available', model: 'public-model' });
  expect(answer.http?.status).toBe(200);
  expect(getHeader(answer.http?.headers ?? [], 'x-upstream-response')).toBe('second');
  expect(jsonBody(answer.http)).toEqual({ input_tokens: 0, vendor_count: 'retained' });
  if (!answer.usage) throw new Error('Count attempt did not provide its empty billable set');
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: 'observed', usage: [] });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.recordPerformance.mock.calls.map(([sample]) => [sample.operation, sample.upstream, sample.failed])).toEqual([
    ['count_tokens', 'limited', true], ['count_tokens', 'available', false],
  ]);
  expect(host.errors).toEqual([]);
});

test('translates a Gemini count request and preserves the Anthropic response headers', async () => {
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'wire-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    return Response.json({ input_tokens: 9 }, { headers: { 'request-id': 'counted' } });
  });
  const host = operationHost([anthropic()], fetcher);
  const running = run(geminiGenerateContentCountTokensIngress, requestFor('/v1beta/models/public-model:countTokens', {
    generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
  }), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(200);
  expect(getHeader(answer.http?.headers ?? [], 'request-id')).toBe('counted');
  expect(jsonBody(answer.http)).toEqual({ totalTokens: 9 });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', model: 'public-model' });
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.recordPerformance).toHaveBeenCalledTimes(1);
  expect(host.errors).toEqual([]);
});

test('preserves a native Gemini 204 and uses its enabled endpoint', async () => {
  const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];
  const fetcher = vi.fn(async (url: string, init: FetchInit) => {
    expect(new URL(url).pathname).toBe('/v1beta/models/wire-model:countTokens');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('key');
    expect(JSON.parse(String(init.body))).toEqual({ generateContentRequest: { model: 'models/wire-model', contents } });
    return new Response(null, { status: 204, headers: { 'request-id': 'no-count' } });
  });
  const candidate = customCandidate('both', { anthropicMessages: {}, geminiGenerateContent: {} });
  const host = operationHost([candidate], fetcher);
  const running = run(geminiGenerateContentCountTokensIngress, requestFor('/v1beta/models/public-model:countTokens', { contents }), host.options);
  const answer = await running.result;
  expect(answer.http).toMatchObject({ status: 204, body: null });
  expect(getHeader(answer.http?.headers ?? [], 'request-id')).toBe('no-count');
  if (!answer.usage) throw new Error('Count attempt did not provide its empty billable set');
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: 'observed', usage: [] });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.recordPerformance).toHaveBeenCalledTimes(1);
  expect(host.errors).toEqual([]);
});

test('excludes a Gemini translation validation failure from billing and performance', async () => {
  const fetcher = vi.fn(async () => {
    throw new Error('Rejected input reached the transport');
  });
  const host = operationHost([anthropic()], fetcher);
  const running = run(geminiGenerateContentCountTokensIngress, requestFor('/v1beta/models/public-model:countTokens', {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }],
  }), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(400);
  expect(jsonBody(answer.http)).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(fetcher).not.toHaveBeenCalled();
  expect(host.recordUsage).not.toHaveBeenCalled();
  expect(host.recordPerformance).not.toHaveBeenCalled();
  expect(host.errors).toEqual([]);
});
