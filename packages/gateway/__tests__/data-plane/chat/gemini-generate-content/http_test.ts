import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';

import { createAnthropicMessagesCountBody } from '../../../../src/data-plane/chat/anthropic-messages/body.ts';
import { anthropicMessagesCountEgress } from '../../../../src/data-plane/chat/anthropic-messages/egress.ts';
import { createGeminiGenerateContentBody, createGeminiGenerateContentCountBody } from '../../../../src/data-plane/chat/gemini-generate-content/body.ts';
import { geminiGenerateContentCountEgress, geminiGenerateContentEgress } from '../../../../src/data-plane/chat/gemini-generate-content/egress.ts';
import { createGeminiGenerateContentCountIngress, createGeminiGenerateContentIngress, geminiGenerateContentHttpOptions } from '../../../../src/data-plane/chat/gemini-generate-content/ingress.ts';
import { createGeminiGenerateContentRoute } from '../../../../src/data-plane/chat/gemini-generate-content/route.ts';
import { createOpenAIChatCompletionsBody } from '../../../../src/data-plane/chat/openai-chat-completions/body.ts';
import { openaiChatCompletionsEgress } from '../../../../src/data-plane/chat/openai-chat-completions/egress.ts';
import { createGatewayHttpHandler } from '../../../../src/data-plane/pipeline/host.ts';
import { mountPublicRoute } from '../../../../src/data-plane/public-route.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { unusedBody } from '../anthropic-messages/fixture.ts';
import { chatUpstream, type ChatTestUpstream, fetcherFrom, interruptedUpload, providersFrom } from '../shared/fixture.ts';
import { createDumpDecoder, projectWireExchanges } from '@floway-dev/dump';
import { type Fetcher, type FetchInit, UpstreamTransportError } from '@floway-dev/http';
import { Bytes, link } from '@floway-dev/pipeline';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';
import { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const queue: (readonly ChatTestUpstream[])[] = [];
const requestedModels: string[] = [];
vi.mock('../../../../src/data-plane/pipeline/services.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/pipeline/services.ts')>();
  const createGatewayServices: typeof original.createGatewayServices = (...args) => {
    const upstreams = queue.shift() ?? [];
    const directory = providersFrom(upstreams);
    return {
      ...original.createGatewayServices(...args),
      fetcher: fetcherFrom(upstreams),
      providers: {
        ...directory,
        enumerate: async (...facts) => {
          requestedModels.push(facts[1]);
          return await directory.enumerate(...facts);
        },
      },
    };
  };
  return { ...original, createGatewayServices };
});

let repo: InMemoryRepo;
beforeEach(() => {
  queue.length = 0;
  requestedModels.length = 0;
  repo = new InMemoryRepo();
  initRepo(repo);
});

const chatCompletions = createOpenAIChatCompletionsBody({
  egress: openaiChatCompletionsEgress, messages: unusedBody, responses: unusedBody,
});
const geminiBody = createGeminiGenerateContentBody({
  egress: geminiGenerateContentEgress, messages: unusedBody, responses: unusedBody, chatCompletions,
});
const countBody = createGeminiGenerateContentCountBody({
  egress: geminiGenerateContentCountEgress,
  messagesCount: createAnthropicMessagesCountBody({ egress: anthropicMessagesCountEgress }),
});
const route = createGeminiGenerateContentRoute({
  generate: createGeminiGenerateContentIngress(geminiBody),
  count: createGeminiGenerateContentCountIngress(countBody),
});
link([route]);
const handler = createGatewayHttpHandler(route, geminiGenerateContentHttpOptions);

const makeApp = (dumpRetentionSeconds: number | null = null) => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', {
      id: 'key-gemini-test', userId: 1, name: 'Gemini test', key: 'sk-test', serverSecret: '00'.repeat(32),
      createdAt: '2026-01-01T00:00:00.000Z', upstreamIds: null, randomizeUpstreams: false, deletedAt: null,
      dumpRetentionSeconds, openaiResponsesRetentionSeconds: 0,
    });
    c.set('user', { id: 1, username: 'test', passwordHash: null, isAdmin: false, createdAt: '2026-01-01T00:00:00.000Z', deletedAt: null });
    await next();
  });
  mountPublicRoute(PUBLIC_DATA_PLANE_ROUTES.geminiGenerateContentAction, (method, path) => app.on(method, path, handler));
  return app;
};

const input = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const audio = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }] };
const send = (action: string, payload: unknown = input, model = 'test-model') => makeApp().request(`/v1beta/models/${model}:${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

const requestJson = (init: FetchInit): Record<string, unknown> => {
  if (!(init.body instanceof Uint8Array)) throw new TypeError('Expected buffered provider request bytes');
  return JSON.parse(new TextDecoder().decode(init.body));
};

const sseData = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
const sseReply = (body: BodyInit, headers: HeadersInit = {}): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'text/event-stream');
  return new Response(body, { headers: responseHeaders });
};

test.each(['generateContent', 'streamGenerateContent', 'countTokens'])('an interrupted Gemini %s upload answers with the original failure', async action => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const response = await makeApp(3600).request(interruptedUpload(`/v1beta/models/test-model:${action}`));
  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).toBe('application/json');
  const text = await response.text();
  const { error } = JSON.parse(text) as { error: { details: [{ stackEntries: string[] }] } };
  const { stackEntries } = error.details[0];
  expect(stackEntries[0]).toBe('Error: client upload interrupted');
  expect(text).toBe(JSON.stringify({
    error: {
      code: 500, message: 'client upload interrupted', status: 'INTERNAL',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries },
        { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'Error' } },
      ],
    },
  }));
  expect(requestedModels).toEqual([]);
  await flushBackground();
  expect(dump.stored[0].meta).toMatchObject({
    status: 500, requestBytes: 0, error: { kind: 'failed', reason: 'client upload interrupted' },
  });
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const parse = [...trace.stages.values()].find(stage => stage.name === 'parsePayload');
  expect(parse?.responseFacts).toMatchObject({ 'response.http': { status: 500, body: expect.any(Bytes) } });
  expect(projectWireExchanges(trace).upstreamExchanges).toEqual([]);
});

test.each(['generateContent', 'streamGenerateContent', 'countTokens'])('Gemini %s rejects invalid JSON before choosing an upstream', async action => {
  const response = await makeApp().request(`/v1beta/models/test-model:${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 400, status: 'INVALID_ARGUMENT' } });
  expect(requestedModels).toEqual([]);
});

type GeminiEvent = GeminiGenerateContentStreamEvent;
const geminiReply = (events: readonly GeminiEvent[], headers?: HeadersInit): Response => sseReply(events.map(sseData).join(''), headers);
const geminiProvider = (fetcher: Fetcher) => chatUpstream({ endpoints: { geminiGenerateContent: {} }, fetcher });

const completionsReply = () => sseReply(`${[
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
].map(sseData).join('')}data: [DONE]\n\n`);

test.each(['generateContent', 'streamGenerateContent'])('POST %s maps a native Google RPC error before responding', async action => {
  const body = { error: { code: 412, status: 'FAILED_PRECONDITION', message: 'account is not ready' } };
  queue.push([geminiProvider(async () => Response.json(body, { status: 400, headers: { 'request-id': 'req-google-rpc' } }))]);
  const response = await send(action);
  expect(response.status).toBe(412);
  expect(response.headers.get('request-id')).toBe('req-google-rpc');
  expect(await response.json()).toEqual(body);
});

test('GenerateContent wraps a non-RPC upstream JSON error', async () => {
  const body = { message: 'account is unavailable' };
  queue.push([geminiProvider(async () => Response.json(body, { status: 503 }))]);
  const response = await send('generateContent');
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: 503, status: 'UNAVAILABLE', message: JSON.stringify(body) },
  });
});

test.each([204, 304])('POST /v1beta/models/:model:countTokens preserves an upstream %s without a body', async status => {
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    fetcher: async () => new Response(null, { status, headers: { 'request-id': 'req-no-count' } }),
  })]);
  const response = await send('countTokens');
  expect(response.status).toBe(status);
  expect(response.headers.get('request-id')).toBe('req-no-count');
  expect(response.body).toBeNull();
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    fetcher: async () => Response.json({ total_tokens: 7 }),
  })]);
  const response = await send('countTokens', { generateContentRequest: input });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ totalTokens: 7 });
});

test('countTokens answers a translation input failure without recording performance', async () => {
  const upstreams = ['up_count_first', 'up_count_last'];
  const recordFailure = vi.spyOn(repo.performance, 'recordZeroOutputError');
  const count = vi.fn(() => { throw new Error('Unsupported input must fail before the upstream call'); });
  queue.push(upstreams.map(upstreamId => chatUpstream({
    upstreamId, endpoints: { anthropicMessages: {} },
    fetcher: count,
  })));
  const response = await send('countTokens', audio);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  expect(count).not.toHaveBeenCalled();
  await flushBackground();
  expect(recordFailure).not.toHaveBeenCalled();
  expect(await repo.performance.listAll()).toEqual([]);
});

test('generateContent retries a translation input failure and records the successful candidate', async () => {
  const recordSuccess = vi.spyOn(repo.performance, 'recordSample');
  const messages = vi.fn(() => { throw new Error('Unsupported input must fail before the upstream call'); });
  const completions = vi.fn<Fetcher>(async () => completionsReply());
  queue.push([
    chatUpstream({
      upstreamId: 'up_messages', endpoints: { anthropicMessages: {} },
      fetcher: messages,
    }),
    chatUpstream({
      upstreamId: 'up_chat', endpoints: { openaiChatCompletions: {} },
      fetcher: completions,
    }),
  ]);
  const response = await send('generateContent', audio);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ candidates: [expect.any(Object)] });
  expect(messages).not.toHaveBeenCalled();
  expect(completions).toHaveBeenCalledOnce();
  await flushBackground();
  expect(recordSuccess.mock.calls.map(([sample]) => sample.upstream)).toEqual(['up_chat']);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, errorsNoOutput: 0, neutral: 0, ttftSamplesOk: 1 }]);
});

test('POST /v1beta/models/models/:model:generateContent accepts the models/ prefix in the path id', async () => {
  let resolvedModel: string | undefined;
  queue.push([chatUpstream({
    endpoints: { openaiChatCompletions: {} },
    fetcher: async (_url, init) => {
      resolvedModel = requestJson(init).model as string;
      return completionsReply();
    },
  })]);
  const response = await send('generateContent', input, 'models/test-model');
  expect(response.status).toBe(200);
  await response.text();
  expect(resolvedModel).toBe('test-model');
});

test('a native Gemini upstream is reached without translation and streams its own frames', async () => {
  const events: readonly GeminiEvent[] = [
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Hello' }] } }] },
    {
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' world' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 }, modelVersion: 'gemini-3-flash',
    },
  ];
  const native = vi.fn<Fetcher>(async () => geminiReply(events, { 'x-goog-request-id': 'r1' }));
  queue.push([chatUpstream({
    endpoints: { geminiGenerateContent: {}, openaiChatCompletions: {} },
    fetcher: native,
  })]);
  const response = await send('streamGenerateContent?alt=sse');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('x-goog-request-id')).toBe('r1');
  const text = await response.text();
  expect(text).toContain('"text":"Hello"');
  expect(text).toContain('"finishReason":"STOP"');
  expect(text).not.toContain('[DONE]');
  expect(native).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/test-model:streamGenerateContent?alt=sse'), expect.anything());
});

test('an unknown Gemini action answers with a 404 RPC envelope before parsing the body', async () => {
  const response = await makeApp().request('/v1/models/test-model:unknownAction', { method: 'POST', body: 'not JSON' });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: { code: 404, message: 'Unknown Gemini model action: unknownAction', status: 'NOT_FOUND' },
  });
});

test('rejects a resolved model with no compatible generateContent endpoint', async () => {
  queue.push([chatUpstream({ endpoints: { openaiEmbeddings: {} } })]);
  const result = await send('generateContent');
  expect(result.status).toBe(400);
  expect(await result.json()).toMatchObject({
    error: { code: 400, message: 'Model test-model does not support the Gemini generateContent endpoint.', status: 'INVALID_ARGUMENT' },
  });
});

test('Gemini translation overlays alias rules on the terminal wire request', async () => {
  const call = vi.fn<Fetcher>(async (_url, init) => {
    const payload = requestJson(init);
    expect(payload).toMatchObject({ reasoning_effort: 'high', verbosity: 'low' });
    expect(payload).not.toHaveProperty('budget_tokens');
    return completionsReply();
  });
  queue.push([chatUpstream({
    modelId: 'target-model', endpoints: { openaiChatCompletions: {} },
    rules: { reasoning: { effort: 'high', budget_tokens: 1024 }, verbosity: 'low' },
    fetcher: call,
  })]);
  const result = await send('generateContent', input, 'gemini-fast');
  expect(result.status).toBe(200);
  await result.text();
  expect(requestedModels).toEqual(['gemini-fast']);
  expect(call).toHaveBeenCalledOnce();
});

test('native Gemini preserves a foreign request signature', async () => {
  const request = {
    contents: [...input.contents, { role: 'model', parts: [{ text: 'answer', thoughtSignature: 'client-owned-signature' }] }],
  };
  const call = vi.fn<Fetcher>(async (_url, init) => {
    expect(requestJson(init)).toEqual(request);
    return geminiReply([{ candidates: [{ index: 0, content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]);
  });
  queue.push([geminiProvider(call)]);
  const result = await send('generateContent', request);
  expect(result.status).toBe(200);
  await result.text();
  expect(call).toHaveBeenCalledOnce();
});

test.each([
  [{ input_tokens: 31 }, 200, { totalTokens: 31 }],
  [{ unrelated: 5 }, 502, { error: { message: 'Invalid upstream token counting response.' } }],
])('countTokens reshapes a Messages response with %j', async (reply, status, expected) => {
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    fetcher: async (url, init) => {
      expect(url).toContain('/v1/messages/count_tokens');
      expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
      const payload = requestJson(init);
      expect(payload).not.toHaveProperty('stream');
      expect(payload.messages).toMatchObject([{ role: 'user' }]);
      expect(JSON.stringify(payload.messages)).toContain('"hi"');
      return Response.json(reply);
    },
  })]);
  const result = await send('countTokens');
  expect(result.status).toBe(status);
  expect(await result.json()).toMatchObject(expected);
});

test('countTokens applies translation cleanup only to the Messages target', async () => {
  const request = {
    contents: [{ role: 'user', parts: [{ text: 'keep', fileData: { fileUri: 'gs://file', mimeType: 'application/pdf' } }] }],
    tools: [{ googleSearch: {} }],
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }],
  };
  const messages = vi.fn<Fetcher>(async (_url, init) => {
    const payload = requestJson(init);
    expect(JSON.stringify(payload.messages)).toContain('"keep"');
    expect(JSON.stringify(payload.messages)).not.toContain('fileData');
    expect(payload).not.toHaveProperty('tools');
    return Response.json({ input_tokens: 4 });
  });
  const gemini = vi.fn<Fetcher>(async (url, init) => {
    expect(url).toContain('/test-model:countTokens');
    expect(requestJson(init)).toEqual({ generateContentRequest: { ...request, model: 'models/test-model' } });
    return Response.json({ totalTokens: 4 });
  });
  queue.push([
    chatUpstream({ endpoints: { anthropicMessages: {} }, fetcher: messages }),
  ], [
    geminiProvider(gemini),
  ]);
  for (const _target of ['translated', 'native']) {
    const result = await send('countTokens', { generateContentRequest: request });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ totalTokens: 4 });
  }
  expect(messages).toHaveBeenCalledOnce();
  expect(gemini).toHaveBeenCalledOnce();
});

const rpcBody = (wire: string): unknown => {
  const error = wire.indexOf('{"error":');
  if (error === -1) throw new Error(`Expected a Gemini RPC error in ${wire}`);
  return JSON.parse(wire.slice(error));
};

test.each([false, true])('Gemini response terminates immediately on a protocol error (stream=%s)', async stream => {
  const failure = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } };
  const trailing = vi.fn();
  queue.push([geminiProvider(async () => {
    let sent = false;
    return sseReply(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          trailing();
          throw new Error('Trailing frame pulled');
        }
        sent = true;
        controller.enqueue(new TextEncoder().encode(sseData(failure)));
      },
    }, { highWaterMark: 0 }));
  })]);
  const response = await send(stream ? 'streamGenerateContent' : 'generateContent');
  expect(response.status).toBe(stream ? 200 : 429);
  expect(rpcBody(await response.text())).toEqual(failure);
  expect(trailing).not.toHaveBeenCalled();
});

test.each([false, true])('Gemini response exposes EOF with an unfinished observed candidate (stream=%s)', async stream => {
  queue.push([geminiProvider(async () => geminiReply([
    { candidates: [{ index: 0, content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] },
    { candidates: [{ index: 1, content: { parts: [{ text: 'unfinished' }] } }] },
  ]))]);
  const response = await send(stream ? 'streamGenerateContent' : 'generateContent');
  expect(response.status).toBe(stream ? 200 : 502);
  expect(rpcBody(await response.text())).toMatchObject({
    error: {
      code: stream ? 500 : 502, message: GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
    },
  });
});

test('Gemini SSE accepts EOF after the last candidate finishes without a done frame', async () => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  queue.push([geminiProvider(async () => geminiReply([
    {
      candidates: [{ index: 0, content: { parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    },
  ]))]);
  const response = await makeApp(3600).request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  const wire = await response.text();
  expect(wire).toContain('"finishReason":"STOP"');
  expect(wire).not.toContain('{"error":');
  await flushBackground();
  expect(dump.stored[0].meta).toMatchObject({
    error: null, model: 'test-model', targetApi: 'geminiGenerateContent', inputTokens: 3, outputTokens: 2,
  });
  expect(await repo.usage.listAll()).toMatchObject([{ model: 'test-model', upstream: 'test-upstream', requests: 1 }]);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, errorsNoOutput: 0, ttftSamplesOk: 1 }]);
});

test.each([false, true])('Gemini internal collect and SSE errors retain structured nested causes (stream=%s)', async stream => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  queue.push([geminiProvider(async () => sseReply(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(failure); },
  })))]);
  const response = await send(stream ? 'streamGenerateContent' : 'generateContent');
  expect(response.status).toBe(stream ? 200 : 502);
  expect(rpcBody(await response.text())).toEqual({
    error: {
      code: stream ? 500 : 502, status: stream ? 'INTERNAL' : 'UNAVAILABLE', message: 'broken',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: ['Error: broken', '  at render'] },
        { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { type: 'internal_error', name: 'Error', cause: { name: 'TypeError', message: 'nested', stack: cause.stack } } },
      ],
    },
  });
});

test.each(['generateContent', 'streamGenerateContent', 'countTokens'])('Gemini %s renders a pre-response transport error as 500', async action => {
  const failure = new UpstreamTransportError(new Error('socket refused the connection'));
  queue.push([geminiProvider(async () => { throw failure; })]);
  const response = await send(action);
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({
    error: { code: 500, status: 'INTERNAL', message: 'socket refused the connection' },
  });
});

test.each([
  {
    name: 'every observed candidate finished',
    next: { usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 } },
    completed: true,
  },
  {
    name: 'a second candidate is still generating',
    next: { candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'partial' }] } }] },
    completed: false,
  },
  {
    name: 'the second candidate finished in a buffered frame',
    next: { candidates: [{ index: 1, content: { role: 'model', parts: [{ text: 'buffered' }] }, finishReason: 'STOP' }] },
    completed: true,
  },
] satisfies { name: string; next: GeminiEvent; completed: boolean }[])('Gemini stream cancellation settles when $name', async ({ next, completed }) => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const waiting = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  queue.push([geminiProvider(async () => {
    const events = [
      { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] },
      next,
    ].values();
    return sseReply(new ReadableStream<Uint8Array>({
      pull(controller) {
        const event = events.next();
        if (!event.done) {
          controller.enqueue(new TextEncoder().encode(sseData(event.value)));
          return;
        }
        waiting.resolve();
        return stopped.promise;
      },
      cancel: () => stopped.resolve(),
    }, { highWaterMark: 0 }));
  })]);
  const response = await makeApp(3600).request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  const firstFrame = new TextDecoder().decode(first.value);
  expect(firstFrame).toContain('"finishReason":"STOP"');
  expect(firstFrame).not.toContain('"index":1');
  const pending = reader.read();
  await waiting.promise;
  await reader.cancel();
  await pending;
  await stopped.promise;
  await flushBackground();
  expect(dump.stored).toHaveLength(1);
  expect(dump.stored[0].meta.error === null).toBe(completed);
  const decoder = createDumpDecoder();
  decoder.push(dump.stored[0].artifact);
  const trace = decoder.finish();
  const stages = [...trace.stages.values()];
  const body = stages.find(stage => stage.name === 'enterBody');
  const observation = stages.find(stage => stage.name === 'observeCompletion');
  const encode = stages.find(stage => stage.name === 'encode');
  expect(observation?.parentStageId).toBe(stages.find(stage => stage.parentStageId === body?.stageId && stage.name === 'pickTarget')?.stageId);
  expect([...trace.deferreds.values()].filter(deferred => deferred.stageId === encode?.stageId).map(deferred => deferred.name)).toEqual(['render outcome']);
});
