import { expect, test, vi } from 'vitest';

import { anthropicMessagesHttpEntry, geminiGenerateContentHttpEntry, openaiChatCompletionsHttpEntry, openaiResponsesHttpEntry, openaiResponsesWebSocketEntry } from '../../../../src/data-plane/chat/pipeline/index.ts';
import { createSidecarCodecFactory, SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import type { Candidate } from '../../../../src/data-plane/pipeline/facts.ts';
import { createGatewayServices, type GatewayDump, type GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { candidateFor, hostFor } from '../../pipeline/fixtures.ts';
import { getHeaders, type Fetcher, type HttpRequestFact, type HttpResponseFact } from '@floway-dev/http';
import { run, type Entry } from '@floway-dev/pipeline';
import { PROMPT_TOO_LONG_MESSAGE } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolError } from '@floway-dev/upstream';

type EntryInput<T> = T extends Entry<infer Input, infer _Output, GatewayServices> ? Input : never;
type Exact<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
type Assert<T extends true> = T;

export type CheckedIngressRequests = [
  Assert<Exact<keyof EntryInput<typeof anthropicMessagesHttpEntry>, 'http' | 'serve.startedAt'>>,
  Assert<Exact<keyof EntryInput<typeof geminiGenerateContentHttpEntry>, 'http' | 'serve.startedAt'>>,
  Assert<Exact<keyof EntryInput<typeof openaiChatCompletionsHttpEntry>, 'http' | 'serve.startedAt'>>,
  Assert<Exact<keyof EntryInput<typeof openaiResponsesHttpEntry>, 'http' | 'serve.startedAt'>>,
  Assert<Exact<keyof EntryInput<typeof openaiResponsesWebSocketEntry>, 'http' | 'serve.startedAt' | 'ws.message' | 'ws.eventId' | 'ws.responseId'>>,
];

const request = (path: string, value: unknown) => {
  const http: HttpRequestFact = {
    url: `https://floway.invalid${path}`,
    method: 'POST',
    headers: [['authorization', 'Bearer gateway-key'], ['x-floway-session', 'session'], ['x-trace', 'sent']],
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
  return { http, 'serve.startedAt': Date.now() };
};

const custom = (id: string, endpoints: Candidate['model']['endpoints']): Candidate => {
  const candidate = candidateFor(id);
  return {
    upstream: {
      ...candidate.upstream,
      config: {
        baseUrl: `https://${id}.example.test`,
        apiKey: 'wire-key',
        ingressHeadersRules: [{ key: 'x-trace', value: null }],
        endpoints,
        modelsFetch: { enabled: false, authStyle: 'bearer' },
      },
    },
    model: { ...candidate.model, endpoints },
  };
};

const setup = (candidates: readonly Candidate[], fetcher: GatewayServices['fetcher'], dump: GatewayDump | null = null) => {
  initRepo(new InMemoryRepo());
  const catalogCandidates = vi.fn<GatewayServices['catalogCandidates']>(async () => ({ candidates, sawModel: true }));
  const recordPerformance = vi.fn<GatewayServices['recordPerformance']>(async () => {});
  const recordUsage = vi.fn<GatewayServices['recordUsage']>(async () => {});
  const services = {
    ...createGatewayServices({
      apiKey: { id: 'key', serverSecret: '00'.repeat(32), openaiResponsesRetentionSeconds: 86_400, upstreamIds: null, randomizeUpstreams: false },
      subject: { id: 2, isAdmin: false },
      runtimeLocation: null,
      dump: null,
    }),
    catalogCandidates,
    fetcher,
    recordPerformance,
    recordUsage,
    dump,
  };
  return { ...hostFor(services), catalogCandidates, recordPerformance, recordUsage };
};

const createDump = () => {
  const pending = new WeakMap<ProtocolError, () => void>();
  return {
    requestedModel: vi.fn(),
    frame: vi.fn(),
    firstOutput: vi.fn(),
    setUpstreamTargetApi: vi.fn(),
    upstreamFrame: vi.fn(),
    upstreamApiError: vi.fn(),
    error: vi.fn(),
    failed: vi.fn(),
    success: vi.fn(),
    stageUpstreamTranslationError: vi.fn<GatewayDump['stageUpstreamTranslationError']>((outcome, capture) => {
      pending.set(outcome, capture);
    }),
    selectUpstreamTranslationError: vi.fn<GatewayDump['selectUpstreamTranslationError']>(outcome => {
      pending.get(outcome)?.();
    }),
  } satisfies GatewayDump;
};

const payloadFrom = (body: HttpResponseFact['body'] | undefined): Record<string, unknown> => {
  if (!(body instanceof Uint8Array)) throw new TypeError('Expected encoded JSON bytes');
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
};

const chatChunk = {
  id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: 'wire-model', created: 1,
  choices: [{ index: 0, delta: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
};

const sseBody = (...events: unknown[]): string => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
const sse = (...events: unknown[]): Response => new Response(sseBody(...events), {
  headers: { 'content-type': 'text/event-stream', 'x-provider': 'real-upstream' },
});

const timedSse = () => {
  const encoder = new TextEncoder();
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { upstream = controller; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  return {
    response,
    emit(...events: unknown[]) { upstream.enqueue(encoder.encode(sseBody(...events))); },
    close() { upstream.close(); },
  };
};

test('native Chat Completions preserves protocol extensions and completes at the provider EOF', async () => {
  const fetcher = vi.fn<Fetcher>(async () => sse(chatChunk));
  const host = setup([custom('native', { openaiChatCompletions: {} })], () => fetcher);
  const initial = request('/v1/chat/completions', {
    model: 'public-model', messages: [{ role: 'user', content: 'hi' }],
    native_extension: { values: [1, 2] },
  });
  const running = run(openaiChatCompletionsHttpEntry, initial, host.options);
  const answer = await running.result;
  expect(payloadFrom(answer.http?.body)).toMatchObject({ choices: [{ message: { content: 'hello world' } }] });
  expect(answer.candidate).toEqual({ upstreamId: 'native', model: 'public-model' });
  const wireRequest = fetcher.mock.calls[0];
  if (wireRequest === undefined || typeof wireRequest[1].body !== 'string') throw new TypeError('Expected serialized upstream JSON');
  expect(wireRequest[0]).toBe('https://native.example.test/v1/chat/completions');
  expect(JSON.parse(wireRequest[1].body)).toMatchObject({ native_extension: { values: [1, 2] }, stream: true, model: 'wire-model' });
  const headers = new Headers(wireRequest[1].headers);
  expect(headers.get('authorization')).toBe('Bearer wire-key');
  expect(headers.get('x-floway-session')).toBeNull();
  expect(headers.get('x-trace')).toBe('sent');
  expect(host.catalogCandidates).toHaveBeenCalledOnce();
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'native', failed: false }));
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test.each([true, false])('meters the first Chat Completions frame when consumed, with a shared SSE chunk: %s', async sameChunk => {
  let now = 110;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const wire = timedSse();
    const host = setup([custom('native', { openaiChatCompletions: {} })], () => async () => wire.response);
    const running = run(openaiChatCompletionsHttpEntry, request('/v1/chat/completions', {
      model: 'public-model', messages: [{ role: 'user', content: 'hi' }], stream: true,
    }), host.options);
    const answer = await running.result;
    const { http } = answer;
    if (http?.body == null || http.body instanceof Uint8Array) throw new TypeError('Expected encoded Chat Completions SSE');
    const cursor = running.read(http.body);
    const role = { ...chatChunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }], usage: undefined };
    if (!sameChunk) {
      wire.emit(role);
      expect((await cursor.next()).done).toBe(false);
    }
    now = 500;
    wire.emit(...(sameChunk ? [role, chatChunk] : [chatChunk]));
    expect(host.recordPerformance).not.toHaveBeenCalled();
    now = 5000;
    wire.close();
    const decoder = new TextDecoder();
    const delivered = (await Array.fromAsync(cursor)).map(item => {
      if (!item.ok) throw item.error.cause;
      return decoder.decode(item.value);
    }).join('');
    expect(delivered).toContain('hello world');
    expect(delivered.endsWith('data: [DONE]\n\n')).toBe(true);
    host.controller.abort();
    running.discard(answer);
    await host.settle();
    expect(host.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ttftMs: 4890, failed: false }));
    expect(host.errors).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('Responses performance includes the first reasoning item in the generation interval', async () => {
  let now = 110;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    const wire = timedSse();
    const host = setup([custom('responses', { openaiResponses: {} })], () => async () => wire.response);
    const running = run(openaiResponsesWebSocketEntry, {
      ...request('/v1/responses', null),
      'ws.message': { type: 'response.create', model: 'public-model', input: 'hi', store: false },
      'ws.responseId': 'resp_fixture',
    }, host.options);
    const answer = await running.result;
    if (answer.openaiResponses.kind !== 'stream') throw new TypeError('Expected a Responses stream');
    const cursor = running.read(answer.openaiResponses.stream);
    const resource = { id: 'resp_upstream', object: 'response', model: 'wire-model', status: 'in_progress', output: [] };
    const reasoning = { id: 'rs_fixture', type: 'reasoning', summary: [] };
    wire.emit({ type: 'response.created', sequence_number: 0, response: resource });
    expect((await cursor.next()).value).toMatchObject({ ok: true, value: { type: 'response.created' } });
    now = 300;
    wire.emit({ type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: reasoning });
    expect((await cursor.next()).value).toMatchObject({ ok: true, value: { type: 'response.output_item.added' } });
    now = 900;
    wire.emit({
      type: 'response.completed',
      sequence_number: 2,
      response: {
        ...resource, status: 'completed', output: [reasoning],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7, output_tokens_details: { reasoning_tokens: 2 } },
      },
    });
    wire.close();
    expect((await Array.fromAsync(cursor)).at(-1)).toMatchObject({ ok: true, value: { type: 'response.completed' } });
    host.controller.abort();
    running.discard(answer);
    await host.settle();
    expect(host.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ttftMs: 190, tpotUs: 300_000, failed: false }));
    expect(host.errors).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test('native Gemini uses the path model and collects the provider stream for generateContent', async () => {
  const fetcher = vi.fn<Fetcher>(async () => sse({
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'gemini answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
  }));
  const host = setup([custom('gemini', { geminiGenerateContent: {} })], () => fetcher);
  const running = run(geminiGenerateContentHttpEntry, request('/v1beta/models/public-model:generateContent', {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  }), host.options);
  const answer = await running.result;
  expect(payloadFrom(answer.http?.body)).toMatchObject({
    candidates: [{ content: { parts: [{ text: 'gemini answer' }] }, finishReason: 'STOP' }],
  });
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ model: 'public-model', kind: 'chat' });
  const wireRequest = fetcher.mock.calls[0];
  if (wireRequest === undefined) throw new TypeError('Expected an upstream Gemini request');
  const url = new URL(wireRequest[0]);
  expect(url.pathname).toBe('/v1beta/models/wire-model:streamGenerateContent');
  expect(url.searchParams.get('alt')).toBe('sse');
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test('Anthropic failover enters a translated candidate body through its native Chat Completions egress', async () => {
  const dump = createDump();
  const fetcher = vi.fn<Fetcher>()
    .mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error', message: 'first rejected' } }, { status: 400 }))
    .mockResolvedValueOnce(sse(chatChunk));
  const host = setup([
    custom('anthropic', { anthropicMessages: {} }),
    custom('translated', { openaiChatCompletions: {} }),
  ], () => fetcher, dump);
  const running = run(anthropicMessagesHttpEntry, request('/v1/messages', {
    model: 'public-model', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }],
  }), host.options);
  const answer = await running.result;
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://anthropic.example.test/v1/messages',
    'https://translated.example.test/v1/chat/completions',
  ]);
  expect(payloadFrom(answer.http?.body)).toMatchObject({
    type: 'message',
    content: expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hello world' }),
      expect.objectContaining({ type: 'redacted_thinking', data: expect.any(String) }),
    ]),
  });
  expect(answer.candidate).toEqual({ upstreamId: 'translated', model: 'public-model' });
  expect(getHeaders(answer.http?.headers ?? [], 'x-provider')).toEqual(['real-upstream']);
  const upstreamBody = fetcher.mock.calls[1]?.[1].body;
  if (typeof upstreamBody !== 'string') throw new TypeError('Expected translated upstream JSON');
  expect(JSON.parse(upstreamBody)).toMatchObject({ stream: true });
  expect(dump.setUpstreamTargetApi).toHaveBeenCalledExactlyOnceWith('openaiChatCompletions');
  const { usage, ...chunkWithoutUsage } = chatChunk;
  expect(dump.upstreamFrame.mock.calls.map(([frame]) => frame)).toEqual([
    { type: 'event', event: chunkWithoutUsage },
    { type: 'event', event: { ...chunkWithoutUsage, choices: [], usage } },
    { type: 'done' },
  ]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.recordPerformance.mock.calls.map(([value]) => [value.upstream, value.failed])).toEqual([
    ['anthropic', true], ['translated', false],
  ]);
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test('translation panics reach the checked host before any provider dial', async () => {
  const fetcher = vi.fn<GatewayServices['fetcher']>();
  const host = setup([custom('translated', { openaiChatCompletions: {} })], fetcher);
  const cause = new Error('codec');
  const panic = new Error('Translation failed', { cause });
  const running = run(anthropicMessagesHttpEntry, request('/v1/messages', {
    model: 'public-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
  }), {
    ...host.options,
    services: {
      ...host.options.services,
      sidecarCodec: { codecFor() { throw panic; } },
    },
  });
  await expect(running.result).rejects.toBe(panic);
  expect(panic.cause).toBe(cause);
  expect(fetcher).not.toHaveBeenCalled();
  host.controller.abort();
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('checked requests sign translated sidecars with the authenticated key secret', async () => {
  const fetcher = vi.fn<GatewayServices['fetcher']>();
  const { options } = setup([], fetcher);
  const domain = SidecarDomain.TranslatedAssistantTurn;
  const signed = await options.services.sidecarCodec.codecFor(domain).encode({ value: 1 });
  const expected = createSidecarCodecFactory('00'.repeat(32)).codecFor(domain);
  const otherKey = createSidecarCodecFactory('22'.repeat(32)).codecFor(domain);
  expect(await expected.decode(signed)).toEqual({ value: 1 });
  expect(await otherKey.decode(signed)).toBeUndefined();
});

test('a translated prompt overflow surfaces Anthropic compatibility with upstream diagnostics', async () => {
  const host = setup([custom('translated', { openaiChatCompletions: {} })], () => async () => Response.json({
    error: { code: 'context_length_exceeded', message: 'maximum context length is 10', diagnostic: 'original' },
  }, { status: 413, headers: { 'x-request-id': 'wire-id' } }));
  const running = run(anthropicMessagesHttpEntry, request('/v1/messages', {
    model: 'public-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
  }), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(400);
  expect(getHeaders(answer.http?.headers ?? [], 'x-request-id')).toEqual(['wire-id']);
  expect(payloadFrom(answer.http?.body)).toMatchObject({
    type: 'error',
    error: { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE, provider_specific_fields: { diagnostic: 'original' } },
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('Dump v1 records the translated upstream error selected by retry-after failover', async () => {
  const dump = createDump();
  const firstError = { error: { code: 'rate_limit_exceeded', message: 'selected upstream error' } };
  const fetcher = vi.fn<Fetcher>()
    .mockResolvedValueOnce(Response.json(firstError, {
      status: 429,
      headers: {
        'retry-after': '5', 'request-id': 'req-selected', 'content-type': 'application/problem+json',
        'set-cookie': 'session=private', connection: 'close', 'content-length': '999', 'content-encoding': 'gzip',
      },
    }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'rejected', message: 'discarded upstream error' } }, { status: 400 }));
  const host = setup([
    custom('selected', { openaiChatCompletions: {} }),
    custom('discarded', { openaiChatCompletions: {} }),
  ], () => fetcher, dump);
  const running = run(anthropicMessagesHttpEntry, request('/v1/messages', {
    model: 'public-model', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
  }), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(429);
  expect(getHeaders(answer.http?.headers ?? [], 'content-type')).toEqual(['application/problem+json']);
  expect(getHeaders(answer.http?.headers ?? [], 'retry-after')).toEqual(['5']);
  expect(getHeaders(answer.http?.headers ?? [], 'request-id')).toEqual(['req-selected']);
  for (const header of ['set-cookie', 'connection', 'content-length', 'content-encoding']) {
    expect(getHeaders(answer.http?.headers ?? [], header)).toEqual([]);
  }
  expect(answer.candidate).toEqual({ upstreamId: 'selected', model: 'public-model' });
  expect(dump.stageUpstreamTranslationError).toHaveBeenCalledTimes(2);
  expect(dump.selectUpstreamTranslationError).toHaveBeenCalledOnce();
  expect(dump.selectUpstreamTranslationError.mock.calls[0]?.[0]).toBe(dump.stageUpstreamTranslationError.mock.calls[0]?.[0]);
  expect(dump.setUpstreamTargetApi).toHaveBeenCalledExactlyOnceWith('openaiChatCompletions');
  expect(dump.upstreamApiError).toHaveBeenCalledOnce();
  expect(dump.upstreamApiError.mock.calls[0]?.[0]).toMatchObject({
    status: 429,
    body: new TextEncoder().encode(JSON.stringify(firstError)),
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('Responses warmup answers WebSocket locally and sends generate=false over HTTP', async () => {
  const candidate = custom('responses', { openaiResponses: {} });
  const fetcher = vi.fn<Fetcher>(async () => Response.json({ error: { message: 'received generate=false' } }, { status: 400 }));
  const websocket = setup([candidate], () => fetcher);
  const common = { model: 'public-model', input: 'hi', generate: false, store: false };
  const running = run(openaiResponsesWebSocketEntry, {
    ...request('/v1/responses', null),
    'ws.message': { type: 'response.create', ...common },
    'ws.responseId': 'resp_websocket_fixture',
  }, websocket.options);
  const answer = await running.result;
  if (answer.openaiResponses.kind !== 'stream') throw new TypeError('Expected a local Responses warmup stream');
  const events = await Array.fromAsync(running.read(answer.openaiResponses.stream));
  expect(events[0]).toMatchObject({ ok: true, value: { type: 'response.created' } });
  expect(events.at(-1)).toMatchObject({
    ok: true, value: {
      type: 'response.completed',
      response: {
        id: 'resp_websocket_fixture',
        status: 'completed',
        output: [expect.objectContaining({ type: 'reasoning', encrypted_content: expect.any(String) })],
      },
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(websocket.recordPerformance).not.toHaveBeenCalled();
  websocket.controller.abort();
  running.discard(answer);
  await websocket.settle();
  expect(websocket.errors).toEqual([]);

  const http = setup([candidate], () => fetcher);
  const httpRun = run(openaiResponsesHttpEntry, request('/v1/responses', common), http.options);
  const httpAnswer = await httpRun.result;
  expect(httpAnswer.http?.status).toBe(400);
  expect(fetcher).toHaveBeenCalledOnce();
  const fetch = fetcher.mock.calls[0];
  if (fetch === undefined || typeof fetch[1].body !== 'string') throw new TypeError('Expected serialized Responses request');
  expect(JSON.parse(fetch[1].body)).toMatchObject({ generate: false });
  http.controller.abort();
  httpRun.discard(httpAnswer);
  await http.settle();
  expect(http.errors).toEqual([]);
});
