import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { config, rawModel, record, speedCatalog } from './fixtures.ts';
import { callKimi, kimiInput, probeSettlements, runKimi, streamKimiChat, streamKimiMessages, streamKimiResponses } from './pipeline-fixture.ts';
import { kimiCodePipelines } from '../src/pipelines.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { isSecret, type RunEvent } from '@floway-dev/pipeline';
import { priceRequest } from '@floway-dev/protocols/common';
import { initProviderRepo } from '@floway-dev/provider';
import { stubProviderModel, testFetcher, withMockedFetch } from '@floway-dev/test-utils';

const frames = {
  chat: 'data: {"id":"turn","object":"chat.completion.chunk","created":1,"model":"kimi-for-coding","choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
  responses: 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg","output_index":0,"content_index":0,"delta":"PONG"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"turn","object":"response","status":"completed","model":"kimi-for-coding","output":[]}}\n\n',
  messages: 'event: message_start\ndata: {"type":"message_start","message":{"id":"turn","type":"message","role":"assistant","model":"kimi-for-coding","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PONG"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
};

beforeEach(() => {
  const saved = { ...record(), configVersion: 1 };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: { getById: async () => saved, saveState: async () => {} },
  }));
});
afterEach(() => { vi.restoreAllMocks(); });

for (const protocol of ['chat', 'responses', 'messages'] as const) test(`${protocol} forwards request fields and consumes native SSE events`, async () => {
  const provider = createKimiCodeProvider(record());
  let captured: Record<string, unknown> | null = null;
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Preview' })] });
    const path = protocol === 'chat' ? '/chat/completions' : protocol === 'responses' ? '/responses' : '/messages';
    expect(request.url).toBe(`https://api.kimi.com/coding/v1${path}`);
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    expect(Object.fromEntries(request.headers)).toEqual({
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      ...(protocol === 'messages' ? { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'future-beta' } : {}),
    });
    captured = await request.json() as Record<string, unknown>;
    return new Response(frames[protocol], { headers: { 'content-type': 'text/event-stream', 'x-upstream': 'kept' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    expect(model.id).toBe('kimi-k9.9-preview');
    expect(model.upstreamModelId).toBe('kimi-for-coding');
    expect(model.providerData).toEqual({ standardModelId: 'kimi-for-coding' });
    const signal = new AbortController().signal;
    const observed: RunEvent[] = [];
    const options = { signal, events: (event: RunEvent) => { observed.push(event); } };
    const payload = { thinking: { type: 'disabled' as const }, vendor_extension: { arbitrary: 'kept' } };
    const result = protocol === 'chat'
      ? await streamKimiChat(kimiInput(model, { ...payload, messages: [{ role: 'user', content: 'hello' }] }), options)
      : protocol === 'responses'
        ? await streamKimiResponses({
            ...kimiInput(model, { ...payload, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] }),
            'request.action': 'generate',
          }, options)
        : await streamKimiMessages({
            ...kimiInput(model, { ...payload, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }),
            'request.anthropicBeta': ['future-beta'],
          }, options);
    expect(captured).toMatchObject({ ...payload, model: 'kimi-for-coding', stream: true });
    expect(result['response.modelKey']).toBe('kimi-for-coding');
    expect(result['response.http'].status).toBe(200);
    expect(result['response.http'].exchange).toBe('upstream');
    expect(result['response.http'].headers).toContainEqual(['x-upstream', 'kept']);
    expect(JSON.stringify(result.frames)).toContain('PONG');
    expect(JSON.stringify(result.frames)).toContain('\"model\":\"kimi-for-coding\"');
    const terminal = observed.find(event => event.k === 'enter' && event.name === 'http');
    if (terminal?.k !== 'enter') throw new Error('Expected HTTP terminal entry');
    expect(JSON.stringify(terminal)).not.toContain(config.apiKey);
    expect(terminal.facts['provider.upstream']).not.toHaveProperty('state');
    const outbound = terminal.facts['request.http'];
    expect(typeof outbound === 'object' && outbound !== null && 'headers' in outbound && Array.isArray(outbound.headers)
      && outbound.headers.some(entry => Array.isArray(entry) && entry[0] === 'authorization' && isSecret(entry[1]))).toBe(true);
  });
});

test.each([400, 403, 429])('Kimi Code preserves upstream status %i, headers and JSON error', async status => {
  const provider = createKimiCodeProvider(record());
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const message = 'K3.1 Pro does not support disabled thinking mode';
  await withMockedFetch(request => {
    if (request.url.endsWith('/models')) return Response.json({ data: [rawModel({ id: 'k3.1-pro' })] });
    if (request.url.endsWith('/usages')) return Response.json({ usages: {} }, { status: 503 });
    return Response.json({ error: { message, type: 'invalid_request_error' } }, { status, headers: { 'x-upstream': 'kept' } });
  }, async () => {
    const [model] = await provider.instance.getProvidedModels(testFetcher);
    const body = { messages: [], thinking: { type: 'disabled' } };
    const observed: RunEvent[] = [];
    const result = await callKimi(kimiCodePipelines.openaiChatCompletions, kimiInput(model, body), { events: event => { observed.push(event); } });
    expect(result['response.http'].status).toBe(status);
    expect(result['response.http'].exchange).toBe('upstream');
    expect(result['response.http'].headers).toContainEqual(['x-upstream', 'kept']);
    expect(result['response.openaiChatCompletions']).toEqual({
      kind: 'error', source: 'upstream', error: { error: { message, type: 'invalid_request_error' } },
    });
    if (status === 400) {
      expect(probeSettlements(observed)).toEqual([]);
      expect(warning).not.toHaveBeenCalled();
    } else {
      expect(probeSettlements(observed)).toMatchObject([{
        name: 'kimiCode.usageProbe',
        settlement: { k: 'settled', ok: true, value: { persisted: false, error: { message: 'Kimi Code /usages returned 503: {"usages":{}}' } } },
      }]);
      expect(warning).toHaveBeenCalledOnce();
    }
  });
});

test('Kimi Code preserves a transport failure after annotating the preceding fast-lane event', async () => {
  const model = stubProviderModel({ providerData: { standardModelId: 'kimi-for-coding', fastModelId: 'kimi-for-coding-highspeed' } });
  const failure = new Error('inference stream disconnected');
  const event = frames.chat.slice(0, frames.chat.indexOf('data: [DONE]'));
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(event)); },
    pull(controller) { controller.error(failure); },
  }, { highWaterMark: 0 });
  const result = await streamKimiChat(kimiInput(model, { messages: [], service_tier: 'priority' }), {
    fetcher: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  });
  expect(result.frames).toMatchObject([
    { type: 'event', event: { service_tier: 'priority' } },
    { type: 'transport-error', error: { name: 'Error', message: failure.message } },
  ]);
});

test('Kimi Code treats a non-SSE Anthropic success as an upstream error', async () => {
  const model = stubProviderModel({ providerData: { standardModelId: 'kimi-for-coding' } });
  const result = await callKimi(kimiCodePipelines.anthropicMessages, {
    ...kimiInput(model, { messages: [], max_tokens: 64 }),
    'request.anthropicBeta': [],
  }, { fetcher: async () => Response.json({ unexpected: 'body' }) });
  expect(result['response.http']).toMatchObject({ status: 502, exchange: 'upstream' });
  expect(result['response.anthropicMessages']).toEqual({
    kind: 'error',
    source: 'upstream',
    error: { type: 'error', error: { type: 'api_error', message: expect.stringContaining('{"unexpected":"body"}') } },
  });
});

for (const protocol of ['chat', 'responses'] as const) test.each([
  ['kimi-k3.1-pro', 'fast', 'k3.1-pro-highspeed', 'priority'],
  ['kimi-k3', 'priority', 'k3', 'default'],
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
      ? await streamKimiChat(kimiInput(model, { ...common, messages: [] }))
      : await streamKimiResponses({ ...kimiInput(model, { ...common, input: [] }), 'request.action': 'generate' });
    expect(result['response.modelKey']).toBe(rawId);
    expect(result['response.http'].headers).toContainEqual(['x-upstream', 'kept']);
    const events = result.frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
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
  ['kimi-k3.1-pro', 'future-speed', 'k3.1-pro'],
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
    const result = await streamKimiMessages({ ...kimiInput(model, payload), 'request.anthropicBeta': [] });
    expect(result['response.modelKey']).toBe(rawId);
    const events = result.frames.flatMap(frame => frame.type === 'event' ? [frame.event] : []);
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

test('Anthropic refuses fast on a standard-only model before issuing any inference request', async () => {
  const publicId = 'kimi-k3';
  const provider = createKimiCodeProvider(record());
  let requests = 0;
  await withMockedFetch(request => {
    requests++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json({ data: speedCatalog() });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === publicId)!;
    const result = await callKimi(kimiCodePipelines.anthropicMessages, {
      ...kimiInput(model, { speed: 'fast', max_tokens: 64, messages: [] }),
      'request.anthropicBeta': [],
    });
    expect(result['response.modelKey']).toBe(model.upstreamModelId);
    expect(result['response.http'].status).toBe(400);
    expect(result['response.http'].exchange).toBeUndefined();
    expect(result['response.anthropicMessages']).toEqual({
      kind: 'error', source: 'local', error: JSON.parse(result.body.utf8()) as unknown,
    });
    expect(result['response.anthropicMessages']).toMatchObject({ error: { type: 'error', error: { type: 'invalid_request_error' } } });
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
      ? await streamKimiChat(kimiInput(model, { service_tier: 'fast', messages: [] }))
      : protocol === 'responses'
        ? await streamKimiResponses({ ...kimiInput(model, { service_tier: 'priority', input: [] }), 'request.action': 'generate' })
        : await streamKimiMessages({ ...kimiInput(model, { speed: 'fast', max_tokens: 64, messages: [] }), 'request.anthropicBeta': [] });
    expect(result['response.modelKey']).toBe('kimi-for-coding-highspeed');
    for (const frame of result.frames) expect(frame.type).toMatch(/event|done/);
  });
});

for (const protocol of ['chat', 'messages'] as const) test(`${protocol} refuses the fast-only family under a standard speed selector`, async () => {
  const provider = createKimiCodeProvider(record());
  let requests = 0;
  await withMockedFetch(request => {
    requests++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    return Response.json({ data: speedCatalog() });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === 'kimi-k2.7-code')!;
    const result = protocol === 'chat'
      ? await callKimi(kimiCodePipelines.openaiChatCompletions, kimiInput(model, { service_tier: 'standard', messages: [] }))
      : await callKimi(kimiCodePipelines.anthropicMessages, { ...kimiInput(model, { speed: 'standard', max_tokens: 64, messages: [] }), 'request.anthropicBeta': [] });
    const outcome = 'response.openaiChatCompletions' in result ? result['response.openaiChatCompletions'] : result['response.anthropicMessages'];
    expect(result['response.modelKey']).toBe('kimi-for-coding-highspeed');
    expect(result['response.http'].status).toBe(400);
    expect(result['response.http'].exchange).toBeUndefined();
    expect(outcome).toEqual({ kind: 'error', source: 'local', error: JSON.parse(result.body.utf8()) as unknown });
    expect(JSON.parse(result.body.utf8())).toMatchObject({
      ...(protocol === 'messages' ? { type: 'error' } : {}),
      error: { type: 'invalid_request_error' },
    });
    expect(requests).toBe(1);
  });
});

for (const speed of ['standard', 'fast']) test(`count_tokens selects the fast-only lane only for explicit fast (${speed})`, async () => {
  const saved = { ...record({ state: null }), configVersion: 1 };
  initProviderRepo(() => ({
    recordUpstreamMetric: async () => {},
    upstreams: { getById: async () => saved, saveState: async () => {} },
  }));
  const provider = createKimiCodeProvider(saved);
  let counts = 0;
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({ data: speedCatalog() });
    counts++;
    expect(request.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.headers.get('anthropic-beta')).toBeNull();
    expect(await request.json()).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    return Response.json({ input_tokens: 7 });
  }, async () => {
    const model = (await provider.instance.getProvidedModels(testFetcher)).find(model => model.id === 'kimi-k2.7-code')!;
    const observed: RunEvent[] = [];
    const result = await callKimi(kimiCodePipelines.anthropicMessagesCountTokens, {
      ...kimiInput(model, { messages: [], max_tokens: 1, speed }),
      'request.anthropicBeta': [],
    }, { events: event => { observed.push(event); } });
    expect(result['response.modelKey']).toBe('kimi-for-coding-highspeed');
    expect(result['response.http'].status).toBe(speed === 'fast' ? 200 : 400);
    expect(probeSettlements(observed)).toEqual([]);
    if (speed === 'fast') {
      expect(result['response.anthropicMessagesCountTokens']).toEqual({ kind: 'ok' });
      expect(result['response.http'].exchange).toBe('upstream');
      expect(JSON.parse(result.body.utf8())).toEqual({ input_tokens: 7 });
    } else {
      expect(result['response.anthropicMessagesCountTokens']).toMatchObject({ kind: 'error', source: 'local' });
      expect(result['response.http'].exchange).toBeUndefined();
    }
    expect(counts).toBe(speed === 'fast' ? 1 : 0);
  });
});

test('native Responses rejects compact before constructing an upstream request', async () => {
  const provider = createKimiCodeProvider(record());
  const fetcher = vi.fn(async () => Response.json({ data: [rawModel({ id: 'k3.1-pro' })] }));
  const [model] = await provider.instance.getProvidedModels(fetcher);
  const handle = runKimi(kimiCodePipelines.openaiResponses, { ...kimiInput(model, { input: [] }), 'request.action': 'compact' }, { fetcher });
  await expect(handle.result).rejects.toThrow('Kimi Code does not expose a native Responses compaction endpoint');
  await expect(handle.done).resolves.toMatchObject({ ok: false });
  expect(fetcher).toHaveBeenCalledOnce();
});
