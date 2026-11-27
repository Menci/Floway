import { expect, test, vi } from 'vitest';

import { anthropicMessagesHttpEntry } from '../../../../src/data-plane/chat/anthropic-messages/pipeline/ingress.ts';
import { anthropicMessagesCountTokensIngress } from '../../../../src/data-plane/non-chat/count-tokens/pipeline.ts';
import { servePipelineHttp } from '../../../../src/data-plane/shared/pipeline-http.ts';
import { customCandidate, operationHost, requestFor } from '../../non-chat/count-tokens/fixtures.ts';
import { mountedChatPanic } from '../pipeline/http-panic-fixtures.ts';
import { HttpTransportError, type Fetcher } from '@floway-dev/http';

const candidate = (id = 'messages') => customCandidate(id, { anthropicMessages: {} });

test.each([false, true])('Anthropic Messages retains the nested transport diagnostic for stream=%s', async stream => {
  const cause = new TypeError('nested transport cause');
  const failure = new HttpTransportError(new Error('broken socket', { cause }));
  const head = sse(messageStart);
  const first = new Uint8Array(await head.arrayBuffer());
  let emitted = false;
  const host = operationHost([candidate()], async () => new Response(new ReadableStream<Uint8Array>({
    pull(reader) {
      if (emitted) reader.error(failure);
      else {
        emitted = true;
        reader.enqueue(first);
      }
    },
  }, { highWaterMark: 0 }), { headers: head.headers }));
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', { ...request, stream }), host.options);
  expect(response.status).toBe(stream ? 200 : 502);
  const body = await response.text();
  expect(body).toContain('"name":"TypeError"');
  expect(body).toContain('"message":"nested transport cause"');
  expect(body).toContain('provider_specific_fields');
  if (stream) expect(body).toContain('event: error');
  await host.settle();
});
const request = { model: 'public-model', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] };

const sse = (...events: { type: string }[]) => new Response(events
  .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream' },
});

const messageStart = {
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'wire-model', content: [], usage: { input_tokens: 4, output_tokens: 0 } },
};
const messageStop = { type: 'message_stop' };
const success = () => sse(messageStart, messageStop);

test.each(['/v1/messages', '/v1/messages/count_tokens'])('renders the original pre-head panic on %s', async path => {
  const { status, text, failure, cause } = await mountedChatPanic(path, { ...request, model: 'test-model' }, { anthropicMessages: {} });
  expect(status).toBe(502);
  expect(JSON.parse(text)).toMatchObject({
    type: 'error',
    error: { type: 'internal_error', message: failure.message, provider_specific_fields: { stack: failure.stack, cause: { message: cause.message } } },
  });
});

test('emits a named Anthropic error event for a post-head panic', async () => {
  const firstFrame = new Uint8Array(await sse(messageStart).arrayBuffer());
  const { status, text, failure, cause } = await mountedChatPanic(
    '/v1/messages', { ...request, model: 'test-model', stream: true }, { anthropicMessages: {} }, firstFrame,
  );
  expect(status).toBe(200);
  expect(text).toContain('event: message_start');
  const errorBlock = text.trimEnd().split('\n\n').at(-1);
  expect(errorBlock).toMatch(/^event: error\ndata: /);
  expect(JSON.parse(errorBlock!.slice('event: error\ndata: '.length))).toMatchObject({
    type: 'error',
    error: { type: 'api_error', message: failure.message, provider_specific_fields: { stack: failure.stack, cause: { message: cause.message } } },
  });
});

test('collects a native Messages response when stream is omitted', async () => {
  const fetcher = vi.fn<Fetcher>(async () => success());
  const host = operationHost([candidate()], fetcher);
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', request), host.options);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  await expect(response.json()).resolves.toMatchObject({ role: 'assistant', id: 'msg_1' });
  await host.settle();
  expect(fetcher).toHaveBeenCalledOnce();
});

test.each([
  { userAgent: 'claude-cli/2.1.226 (external, cli)', prompt: 'Hi', local: true },
  { userAgent: 'claude-cli/2.1.226 (external, cli)', prompt: 'What is your latest model?', local: false },
  { userAgent: 'other-client/1.0', prompt: 'Hi', local: false },
])('handles model validation for $userAgent and $prompt', async ({ userAgent, prompt, local }) => {
  const fetcher = vi.fn<Fetcher>(async () => success());
  const host = operationHost([candidate()], fetcher);
  const input = requestFor('/v1/messages', {
    ...request, max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });
  input.http.headers.push(['user-agent', userAgent]);
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, input, host.options);
  expect(response.status).toBe(200);
  if (local) {
    await expect(response.json()).resolves.toMatchObject({ model: 'public-model', stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } });
  }
  await host.settle();
  expect(fetcher).toHaveBeenCalledTimes(local ? 0 : 1);
  expect(host.recordUsage).toHaveBeenCalledTimes(local ? 0 : 1);
  expect(host.recordPerformance).toHaveBeenCalledTimes(local ? 0 : 1);
});

test('rejects body anthropic_beta before catalog discovery', async () => {
  const host = operationHost([], async () => { throw new Error('Rejected input reached the transport'); });
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', {
    ...request, anthropic_beta: ['probe'],
  }), host.options);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: { param: 'anthropic_beta', type: 'invalid_request_error' } });
  expect(host.catalogCandidates).not.toHaveBeenCalled();
});

test('count-tokens preserves the last upstream rate limit and end-to-end headers', async () => {
  const body = { error: { type: 'rate_limit_error', message: 'wait' } };
  const host = operationHost([candidate()], async () => Response.json(body, {
    status: 429, headers: { 'retry-after': '17', 'request-id': 'req-count', 'set-cookie': 'private=1' },
  }));
  const response = await servePipelineHttp(anthropicMessagesCountTokensIngress, requestFor('/v1/messages/count_tokens', request), host.options);
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('17');
  expect(response.headers.get('request-id')).toBe('req-count');
  expect(response.headers.get('set-cookie')).toBeNull();
  await expect(response.json()).resolves.toEqual(body);
  await host.settle();
});

test('keeps the selected candidate once the Messages stream opens', async () => {
  const upstreamError = { type: 'error', error: { type: 'overloaded_error', message: 'call failed mid-stream' } };
  const fetcher = vi.fn<Fetcher>(async () => sse(messageStart, upstreamError));
  const host = operationHost([candidate('first'), candidate('second')], fetcher);
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', { ...request, stream: true }), host.options);
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(wire).toContain('event: message_start');
  expect(wire).toContain(`event: error\ndata: ${JSON.stringify(upstreamError)}`);
  expect(fetcher).toHaveBeenCalledOnce();
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'first', failed: true }));
});

test('applies billing and role rules independently to failover candidates', async () => {
  const first = candidate('first');
  const second = candidate('second');
  const billing = { type: 'text', text: 'x-anthropic-billing-header: turn\ncch=deadbeef1234;' };
  const system = [billing, { type: 'text', text: 'base rules' }];
  const messages = [{ role: 'system', content: 'inline rules' }, ...request.messages];
  const beta = 'claude-code-20250219,interleaved-thinking-2025-05-14';
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    if (new URL(url).hostname === 'first.example') {
      expect(body).toMatchObject({ system: [system[1]], messages: [{ role: 'user', content: 'inline rules' }, ...request.messages] });
      expect(new Headers(init.headers).get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14');
      return Response.json({ error: { message: 'try another' } }, { status: 503 });
    }
    expect(body).toMatchObject({ system, messages });
    expect(new Headers(init.headers).get('anthropic-beta')).toBe(beta);
    return success();
  });
  const host = operationHost([
    { ...first, model: { ...first.model, enabledFlags: ['strip-billing-attribution', 'rewrite-mid-conv-system-to-user'] } },
    second,
  ], fetcher);
  const input = requestFor('/v1/messages', { ...request, system, messages });
  input.http.headers.push(['anthropic-beta', beta]);
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, input, host.options);
  expect(response.status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await host.settle();
});

test('applies Anthropic alias rules to the resolved model', async () => {
  const base = candidate();
  const host = operationHost([{
    ...base,
    rules: { reasoning: { effort: 'high', budget_tokens: 2048 }, serviceTier: 'fast' },
  }], async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'wire-model', output_config: { effort: 'high' }, speed: 'fast', thinking: { type: 'enabled', budget_tokens: 2048 },
    });
    return success();
  });
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', { ...request, model: 'alias' }), host.options);
  expect(response.status).toBe(200);
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', model: 'alias' });
  await host.settle();
});

test('preserves the target Responses role rewrite when the source has a competing flag', async () => {
  const target = customCandidate('responses', { openaiResponses: {} });
  const host = operationHost([{
    ...target,
    model: { ...target.model, enabledFlags: ['rewrite-mid-conv-system-to-user', 'rewrite-system-to-developer'] },
  }], async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/responses');
    expect(JSON.parse(String(init.body))).toMatchObject({
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'developer', content: 'inline instructions' },
      ],
    });
    const completed = {
      type: 'response.completed',
      response: { id: 'resp_1', object: 'response', status: 'completed', model: 'wire-model', output: [], error: null },
    };
    return sse(completed);
  });
  const response = await servePipelineHttp(anthropicMessagesHttpEntry, requestFor('/v1/messages', {
    ...request, messages: [...request.messages, { role: 'system', content: 'inline instructions' }],
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
});

test('count-tokens shares Anthropic request shaping with generation', async () => {
  const base = candidate();
  const host = operationHost([{
    ...base, model: {
      ...base.model, enabledFlags: [
        'strip-billing-attribution', 'disable-reasoning-on-forced-tool-choice', 'rewrite-mid-conv-system-to-user',
      ],
    },
  }], async (_url, init) => {
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('interleaved-thinking-2025-05-14');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'wire-model', system: 'base rules',
      messages: [{ role: 'user', content: 'inline rules' }, ...request.messages],
      thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'lookup' },
    });
    return Response.json({ input_tokens: 9 });
  });
  const input = requestFor('/v1/messages/count_tokens', {
    ...request, system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
    messages: [{ role: 'system', content: 'inline rules' }, ...request.messages],
    thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'high' }, tool_choice: { type: 'tool', name: 'lookup' },
  });
  input.http.headers.push(['anthropic-beta', 'claude-code-20250219,interleaved-thinking-2025-05-14']);
  const response = await servePipelineHttp(anthropicMessagesCountTokensIngress, input, host.options);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ input_tokens: 9 });
  await host.settle();
});
