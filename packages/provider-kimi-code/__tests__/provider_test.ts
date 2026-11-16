import { expect, test } from 'vitest';

import { config, rawModel, record, speedCatalog } from './fixtures.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { priceRequest } from '@floway-dev/protocols/common';
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
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Preview' })] });
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
    expect(model.id).toBe('kimi-k9.9-preview');
    expect(model.upstreamModelId).toBe('kimi-for-coding');
    expect(model.providerData).toEqual({ standardModelId: 'kimi-for-coding' });
    const signal = new AbortController().signal;
    const payload = { thinking: { type: 'disabled' as const }, vendor_extension: { arbitrary: 'kept' } };
    const result = protocol === 'chat'
      ? await provider.instance.callOpenAIChatCompletions(model, { ...payload, messages: [{ role: 'user', content: 'hello' }] }, signal, noopUpstreamCallOptions())
      : protocol === 'responses'
        ? await provider.instance.callOpenAIResponses(model, { ...payload, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }, 'generate', signal, noopUpstreamCallOptions())
        : await provider.instance.callAnthropicMessages(model, { ...payload, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }, signal, noopAnthropicMessagesUpstreamCallOptions({ anthropicBeta: ['future-beta'] }));
    expect(captured).toMatchObject({ ...payload, model: 'kimi-for-coding', stream: true });
    expect(result.modelKey).toBe('kimi-for-coding');
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

for (const protocol of ['chat', 'responses'] as const) test.each([
  ['kimi-k3.1-pro', 'priority', 'k3.1-pro-highspeed', 'priority'],
  ['kimi-k3.1-pro', 'fast', 'k3.1-pro-highspeed', 'priority'],
  ['kimi-k3.1-pro', 'default', 'k3.1-pro', 'default'],
  ['kimi-k3.1-pro', undefined, 'k3.1-pro', 'default'],
  ['kimi-k3', 'priority', 'k3', 'default'],
  ['kimi-k3', 'fast', 'k3', 'default'],
  ['kimi-k2.8-preview', 'priority', 'kimi-for-coding', 'default'],
  ['kimi-k2.8-preview', 'fast', 'kimi-for-coding', 'default'],
  ['kimi-k2.7-code', 'priority', 'kimi-for-coding-highspeed', 'priority'],
  ['kimi-k2.7-code', 'fast', 'kimi-for-coding-highspeed', 'priority'],
  ['kimi-k3.1-pro', 'future-tier', 'k3.1-pro', 'future-tier'],
])(`${protocol} selects %s at requested tier %s using raw id %s and reports %s`, async (publicId, requestedTier, rawId, servedTier) => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: speedCatalog() });
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ model: rawId, vendor_extension: 'kept' });
    if (requestedTier === undefined) expect(body).not.toHaveProperty('service_tier');
    else expect(body.service_tier).toBe(servedTier);
    expect(request.url).toBe(`https://api.kimi.com/coding/v1/${protocol === 'chat' ? 'chat/completions' : 'responses'}`);
    const data = protocol === 'chat'
      ? `data: ${JSON.stringify({ id: 'turn', object: 'chat.completion.chunk', created: 1, model: rawId, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, service_tier: body.service_tier === 'future-tier' ? 'future-tier' : 'default' })}\n\ndata: [DONE]\n\n`
      : ['response.created', 'response.in_progress', 'response.completed'].map(type => `event: ${type}\ndata: ${JSON.stringify({ type, response: { id: 'turn', object: 'response', status: type === 'response.completed' ? 'completed' : 'in_progress', output: [], model: rawId, service_tier: body.service_tier === 'future-tier' ? 'future-tier' : 'default' } })}\n\n`).join('');
    return new Response(data, { headers: { 'content-type': 'text/event-stream', 'x-upstream': 'kept' } });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === publicId)!;
    const common = { service_tier: requestedTier, vendor_extension: 'kept' };
    const result = protocol === 'chat'
      ? await provider.instance.callOpenAIChatCompletions(model, { ...common, messages: [] }, undefined, noopUpstreamCallOptions())
      : await provider.instance.callOpenAIResponses(model, { ...common, input: [] }, 'generate', undefined, noopUpstreamCallOptions());
    expect(result.modelKey).toBe(rawId);
    if (!result.ok || !('events' in result)) throw new Error('Expected a streaming result');
    expect(result.headers?.get('x-upstream')).toBe('kept');
    const events = [];
    for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const resource = 'response' in event ? event.response : event;
      expect(resource).toMatchObject({ model: rawId, service_tier: servedTier });
      if (servedTier === 'priority') {
        expect(priceRequest(model.pricing!, { serviceTier: servedTier }).rates?.input_tokens).toBe(publicId === 'kimi-k3.1-pro' ? '0.000004' : '0.0000019');
      }
    }
  });
});

test.each([
  ['kimi-k3.1-pro', 'fast', 'k3.1-pro-highspeed'],
  ['kimi-k3.1-pro', 'standard', 'k3.1-pro'],
  ['kimi-k3.1-pro', undefined, 'k3.1-pro'],
  ['kimi-k3.1-pro', 'future-speed', 'k3.1-pro'],
  ['kimi-k3', 'standard', 'k3'],
  ['kimi-k2.8-preview', 'standard', 'kimi-for-coding'],
  ['kimi-k2.7-code', 'fast', 'kimi-for-coding-highspeed'],
])('Anthropic selects %s at speed %s using %s and stamps the requested known speed', async (publicId, speed, rawId) => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: speedCatalog() });
    const body = await request.json() as Record<string, unknown>;
    expect(body).toMatchObject({ model: rawId, vendor_extension: 'kept' });
    if (speed === 'future-speed') expect(body.speed).toBe(speed);
    else expect(body).not.toHaveProperty('speed');
    return new Response(frames.messages, { headers: { 'content-type': 'text/event-stream' } });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === publicId)!;
    const payload = { speed, max_tokens: 64, messages: [], vendor_extension: 'kept' };
    const result = await provider.instance.callAnthropicMessages(model, payload, undefined, noopAnthropicMessagesUpstreamCallOptions());
    expect(result.modelKey).toBe(rawId);
    if (!result.ok) throw new Error('Expected a streaming result');
    const events = [];
    for await (const frame of result.events) if (frame.type === 'event') events.push(frame.event);
    const start = events.find(event => event.type === 'message_start');
    if (start?.type !== 'message_start') throw new Error('Expected message_start');
    if (speed === undefined || speed === 'future-speed') expect(start.message.usage).not.toHaveProperty('speed');
    else expect(start.message.usage.speed).toBe(speed);
    if (speed === 'fast') {
      expect(priceRequest(model.pricing!, { serviceTier: start.message.usage.speed }).rates?.input_tokens).toBe(publicId === 'kimi-k3.1-pro' ? '0.000004' : '0.0000019');
    }
    expect(events.some(event => event.type === 'message_stop')).toBe(true);
  });
});

test.each(['kimi-k3', 'kimi-k2.8-preview'])('Anthropic refuses fast on %s before issuing any inference request', async publicId => {
  const provider = createKimiCodeProvider(record());
  let requests = 0;
  await withMockedFetch(request => {
    requests++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json({ data: speedCatalog() });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === publicId)!;
    const result = await provider.instance.callAnthropicMessages(model, { speed: 'fast', max_tokens: 64, messages: [] }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    if (result.ok) throw new Error('Expected unsupported speed error');
    expect(result.modelKey).toBe(model.upstreamModelId);
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: `'${publicId}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.` } });
    expect(requests).toBe(1);
  });
});

for (const protocol of ['chat', 'responses', 'messages'] as const) test(`${protocol} sends the catalog fast id for a matching opaque family, never the derived id`, async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({
      data: [
        rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Code' }),
        rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K9.9 Code Highspeed' }),
      ],
    });
    expect(await request.json()).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    return new Response(frames[protocol], { headers: { 'content-type': 'text/event-stream' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    expect(model.id).toBe('kimi-k9.9-code');
    const result = protocol === 'chat'
      ? await provider.instance.callOpenAIChatCompletions(model, { service_tier: 'fast', messages: [] }, undefined, noopUpstreamCallOptions())
      : protocol === 'responses'
        ? await provider.instance.callOpenAIResponses(model, { service_tier: 'priority', input: [] }, 'generate', undefined, noopUpstreamCallOptions())
        : await provider.instance.callAnthropicMessages(model, { speed: 'fast', max_tokens: 64, messages: [] }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    expect(result.modelKey).toBe('kimi-for-coding-highspeed');
    if (!result.ok || !('events' in result)) throw new Error('Expected a streaming result');
    for await (const frame of result.events) expect(frame.type).toMatch(/event|done/);
  });
});

for (const protocol of ['chat', 'responses', 'messages'] as const) test.each([undefined, null, 'standard', 'default', 'auto', 'flex', 'future-value'])(`${protocol} refuses the fast-only family when its speed selector is %s`, async selector => {
  const provider = createKimiCodeProvider(record());
  let requests = 0;
  await withMockedFetch(request => {
    requests++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json({ data: speedCatalog() });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === 'kimi-k2.7-code')!;
    const openAIFields = selector === undefined ? {} : { service_tier: selector };
    const anthropicFields = selector === undefined ? {} : { speed: selector };
    const result = protocol === 'chat'
      ? await provider.instance.callOpenAIChatCompletions(model, { ...openAIFields, messages: [] }, undefined, noopUpstreamCallOptions())
      : protocol === 'responses'
        ? await provider.instance.callOpenAIResponses(model, { ...openAIFields, input: [] }, 'generate', undefined, noopUpstreamCallOptions())
        : await provider.instance.callAnthropicMessages(model, { ...anthropicFields, max_tokens: 64, messages: [] }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    if (result.ok) throw new Error('Expected fast-only model error');
    expect(result.modelKey).toBe('kimi-for-coding-highspeed');
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      ...(protocol === 'messages' ? { type: 'error' } : {}),
      error: { type: 'invalid_request_error', message: `'kimi-k2.7-code' is only available with fast mode selected; set \`${protocol === 'messages' ? 'speed: "fast"' : 'service_tier: "priority"'}\`.` },
    });
    expect(requests).toBe(1);
  });
});

for (const speed of [undefined, 'standard', 'fast']) test(`count_tokens selects the fast-only lane only for explicit fast (${speed})`, async () => {
  const provider = createKimiCodeProvider(record());
  let counts = 0;
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: speedCatalog() });
    counts++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
    expect(await request.json()).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    return Response.json({ input_tokens: 7 });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === 'kimi-k2.7-code')!;
    const result = await provider.instance.callAnthropicMessagesCountTokens(model, { messages: [], max_tokens: 1, speed }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    expect(result.modelKey).toBe('kimi-for-coding-highspeed');
    expect(result.response.status).toBe(speed === 'fast' ? 200 : 400);
    expect(counts).toBe(speed === 'fast' ? 1 : 0);
  });
});

test('count_tokens uses the same fast-lane selector and actionable rejection as Messages', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: speedCatalog() });
    expect(await request.json()).toMatchObject({ model: 'k3.1-pro-highspeed' });
    return Response.json({ input_tokens: 7 });
  }, async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    const paired = models.find(model => model.id === 'kimi-k3.1-pro')!;
    const counted = await provider.instance.callAnthropicMessagesCountTokens(paired, { messages: [], max_tokens: 1, speed: 'fast' }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    expect(counted.modelKey).toBe('k3.1-pro-highspeed');
    const standardOnly = models.find(model => model.id === 'kimi-k3')!;
    const rejected = await provider.instance.callAnthropicMessagesCountTokens(standardOnly, { messages: [], max_tokens: 1, speed: 'fast' }, undefined, noopAnthropicMessagesUpstreamCallOptions());
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.json()).toMatchObject({ error: { message: '\'kimi-k3\' does not support fast mode; omit `speed` or set `speed: "standard"`.' } });
  });
});
