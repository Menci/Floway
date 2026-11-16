import { expect, test } from 'vitest';

import { config, rawModel, record } from './fixtures.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { initProviderRepo } from '@floway-dev/provider';
import { noopAnthropicMessagesUpstreamCallOptions, noopUpstreamCallOptions, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const frames = {
  chat: 'data: {"id":"turn","object":"chat.completion.chunk","created":1,"model":"arbitrary-model","choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  responses: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg","output_index":0,"content_index":0,"delta":"PONG"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"turn","object":"response","status":"completed","output":[]}}\n\n',
  messages: 'event: message_start\ndata: {"type":"message_start","message":{"id":"turn","type":"message","role":"assistant","model":"arbitrary-model","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
};

for (const protocol of ['chat', 'responses', 'messages'] as const) test(`${protocol} forwards request fields and consumes native SSE events`, async () => {
  const provider = createKimiCodeProvider(record());
  let captured: Record<string, unknown> | null = null;
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel()] });
    const path = protocol === 'chat' ? '/chat/completions' : protocol === 'responses' ? '/responses' : '/messages';
    expect(request.url).toBe(`https://api.kimi.com/coding/v1${path}`);
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(request.headers.get('x-api-key')).toBeNull();
    expect(request.headers.get('anthropic-beta')).toBe(protocol === 'messages' ? 'future-beta' : null);
    captured = await request.json() as Record<string, unknown>;
    return new Response(frames[protocol], { headers: { 'content-type': 'text/event-stream', 'x-upstream': 'kept' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    const signal = new AbortController().signal;
    const payload = { thinking: { type: 'disabled' as const }, vendor_extension: { arbitrary: 'kept' } };
    const result = protocol === 'chat'
      ? await provider.instance.callOpenAIChatCompletions(model, { ...payload, messages: [{ role: 'user', content: 'hello' }] }, signal, noopUpstreamCallOptions())
      : protocol === 'responses'
        ? await provider.instance.callOpenAIResponses(model, { ...payload, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }, 'generate', signal, noopUpstreamCallOptions())
        : await provider.instance.callAnthropicMessages(model, { ...payload, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }, signal, noopAnthropicMessagesUpstreamCallOptions({ anthropicBeta: ['future-beta'] }));
    expect(captured).toMatchObject({ ...payload, model: 'arbitrary-model', stream: true });
    expect(result.modelKey).toBe('arbitrary-model');
    expect(result.ok).toBe(true);
    if (!result.ok || !('events' in result)) throw new Error('Expected a streaming result');
    expect(result.headers?.get('x-upstream')).toBe('kept');
    const events = [];
    for await (const event of result.events) events.push(event);
    expect(JSON.stringify(events)).toContain('PONG');
  });
});

test.each([400, 401, 403, 429])('Kimi Code preserves upstream status %i, headers and body', async status => {
  initProviderRepo(() => ({ recordUpstreamMetric: async () => {}, upstreams: { getById: async () => null, saveState: async () => {} } }));
  const provider = createKimiCodeProvider(record());
  const background: Promise<unknown>[] = [];
  const message = 'K3.1 Pro does not support disabled thinking mode';
  await withMockedFetch(request => {
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel({ id: 'k3.1-pro' })] });
    if (request.url.endsWith('/usages')) return Response.json({ usages: {} }, { status: 503 });
    return Response.json({ error: { message, type: 'invalid_request_error' } }, { status, headers: { 'x-upstream': 'kept' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    const body = { messages: [], thinking: { type: 'disabled' } };
    const result = await provider.instance.callOpenAIChatCompletions(model, body, undefined, noopUpstreamCallOptions({ waitUntil: promise => { background.push(promise); } }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected upstream failure');
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get('x-upstream')).toBe('kept');
    expect(await result.response.json()).toEqual({ error: { message, type: 'invalid_request_error' } });
    expect(background).toHaveLength(status === 403 || status === 429 ? 1 : 0);
    await Promise.all(background);
  });
});

test('thinking remains absent when omitted and count_tokens issues no quota refresh', async () => {
  const provider = createKimiCodeProvider(record({ state: null }));
  const background: Promise<unknown>[] = [];
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel()] });
    expect(request.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
    const body = await request.json();
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('stream');
    return Response.json({ input_tokens: 7 }, { headers: { 'x-count': 'kept' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    const result = await provider.instance.callAnthropicMessagesCountTokens(model, { messages: [{ role: 'user', content: 'hello' }], max_tokens: 1 }, undefined, noopAnthropicMessagesUpstreamCallOptions({ waitUntil: promise => { background.push(promise); } }));
    expect(await result.response.json()).toEqual({ input_tokens: 7 });
    expect(result.response.headers.get('x-count')).toBe('kept');
    expect(background).toHaveLength(0);
  });
});
