import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';

import { mountChatRoutes } from '../../../../src/data-plane/chat/routes.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import { chatUpstream, type ChatTestUpstream, eventReply, httpReply, providersFrom, stubScalarProvider, stubStreamProvider } from '../shared/fixture.ts';
import type { StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE, type GeminiGenerateContentPayload, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProviderAnthropicInput, ProviderInput } from '@floway-dev/provider';

const queue: (readonly ChatTestUpstream[])[] = [];
const requestedModels: string[] = [];
vi.mock('../../../../src/data-plane/pipeline/services.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/pipeline/services.ts')>();
  const createGatewayServices: typeof original.createGatewayServices = (...args) => {
    const directory = providersFrom(queue.shift() ?? []);
    return {
      ...original.createGatewayServices(...args),
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
  mountChatRoutes(app);
  return app;
};

const input = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
const audio = { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }] };
const send = (action: string, payload: unknown = input, model = 'test-model') => makeApp().request(`/v1beta/models/${model}:${action}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});

const frames = async function* <Event>(events: readonly Event[]) {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

type GeminiInput = ProviderInput<GeminiGenerateContentPayload>;
type GeminiEvent = GeminiGenerateContentStreamEvent;
type CompletionsInput = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type CompletionsEvent = OpenAIChatCompletionsStreamEvent;

const completionsFrames = () => frames<CompletionsEvent>([
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
]);

test.each(['generateContent', 'streamGenerateContent'])('POST %s maps a native Google RPC error before responding', async action => {
  const body = { error: { code: 412, status: 'FAILED_PRECONDITION', message: 'account is not ready' } };
  queue.push([chatUpstream({
    endpoints: { geminiGenerateContent: {} },
    pipelines: {
      geminiGenerateContent: stubStreamProvider<GeminiInput, GeminiEvent>('stub Gemini error', async (_facts, env) => ({
        ...await httpReply(env, Response.json(body, { status: 400, headers: { 'request-id': 'req-google-rpc' } })),
        'response.events': undefined,
      })),
    },
  })]);
  const response = await send(action);
  expect(response.status).toBe(412);
  expect(response.headers.get('request-id')).toBe('req-google-rpc');
  expect(await response.json()).toEqual(body);
});

test('POST /v1beta/models/:model:countTokens preserves an upstream 204 without a body', async () => {
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    pipelines: {
      anthropicMessagesCountTokens: stubScalarProvider<ProviderAnthropicInput>('stub Messages count', async (_facts, env) =>
        await httpReply(env, new Response(null, { status: 204, headers: { 'request-id': 'req-no-count' } }))),
    },
  })]);
  const response = await send('countTokens');
  expect(response.status).toBe(204);
  expect(response.headers.get('request-id')).toBe('req-no-count');
  expect(response.body).toBeNull();
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  queue.push([chatUpstream({
    endpoints: { anthropicMessages: {} },
    pipelines: {
      anthropicMessagesCountTokens: stubScalarProvider<ProviderAnthropicInput>('stub Messages count', async (_facts, env) =>
        await httpReply(env, Response.json({ total_tokens: 7 }))),
    },
  })]);
  const response = await send('countTokens', { generateContentRequest: input });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ totalTokens: 7 });
});

test('countTokens records the final translation input failure once', async () => {
  const upstreams = ['up_count_first', 'up_count_last'];
  const recordFailure = vi.spyOn(repo.performance, 'recordZeroOutputError');
  const count = vi.fn(() => { throw new Error('Unsupported input must fail before the upstream call'); });
  queue.push(upstreams.map(upstreamId => chatUpstream({
    upstreamId, endpoints: { anthropicMessages: {} },
    pipelines: { anthropicMessagesCountTokens: stubScalarProvider<ProviderAnthropicInput>('stub Messages count', count) },
  })));
  const response = await send('countTokens', audio);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { status: 'INVALID_ARGUMENT' } });
  expect(count).not.toHaveBeenCalled();
  await flushBackground();
  expect(recordFailure.mock.calls.map(([sample]) => sample.upstream)).toEqual([upstreams.at(-1)]);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, errorsNoOutput: 1, neutral: 0 }]);
});

test('generateContent retries a translation input failure and records the successful candidate', async () => {
  const recordSuccess = vi.spyOn(repo.performance, 'recordSample');
  const messages = vi.fn(() => { throw new Error('Unsupported input must fail before the upstream call'); });
  const completions = vi.fn((_facts: CompletionsInput, env: StageEnv) => eventReply(env, completionsFrames()));
  queue.push([
    chatUpstream({
      upstreamId: 'up_messages', endpoints: { anthropicMessages: {} },
      pipelines: { anthropicMessages: stubStreamProvider<ProviderAnthropicInput, AnthropicMessagesStreamEventEx>('stub Messages', messages) },
    }),
    chatUpstream({
      upstreamId: 'up_chat', endpoints: { openaiChatCompletions: {} },
      pipelines: { openaiChatCompletions: stubStreamProvider('stub Chat Completions', completions) },
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
    pipelines: {
      openaiChatCompletions: stubStreamProvider<CompletionsInput, CompletionsEvent>('stub Chat Completions', (facts, env) => {
        resolvedModel = facts['provider.model'].id;
        return eventReply(env, completionsFrames());
      }),
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
  const translated = vi.fn(() => { throw new Error('The native Gemini target takes precedence'); });
  queue.push([chatUpstream({
    endpoints: { geminiGenerateContent: {}, openaiChatCompletions: {} },
    pipelines: {
      geminiGenerateContent: stubStreamProvider<GeminiInput, GeminiEvent>('stub Gemini', (_facts, env) =>
        eventReply(env, frames(events), [['x-goog-request-id', 'r1']])),
      openaiChatCompletions: stubStreamProvider<CompletionsInput, CompletionsEvent>('stub Chat Completions', translated),
    },
  })]);
  const response = await send('streamGenerateContent?alt=sse');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('x-goog-request-id')).toBe('r1');
  const text = await response.text();
  expect(text).toContain('"text":"Hello"');
  expect(text).toContain('"finishReason":"STOP"');
  expect(text).not.toContain('[DONE]');
  expect(translated).not.toHaveBeenCalled();
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
  const call = vi.fn((facts: CompletionsInput, env: StageEnv) => {
    expect(facts['request.payload']).toMatchObject({ reasoning_effort: 'high', verbosity: 'low' });
    expect(facts['request.payload']).not.toHaveProperty('budget_tokens');
    return eventReply(env, completionsFrames());
  });
  queue.push([chatUpstream({
    modelId: 'target-model', endpoints: { openaiChatCompletions: {} },
    rules: { reasoning: { effort: 'high', budget_tokens: 1024 }, verbosity: 'low' },
    pipelines: { openaiChatCompletions: stubStreamProvider('stub Chat Completions', call) },
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
  const call = vi.fn((facts: GeminiInput, env: StageEnv) => {
    expect(facts['request.payload']).toEqual(request);
    return eventReply(env, frames<GeminiEvent>([{ candidates: [{ index: 0, content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]));
  });
  queue.push([chatUpstream({
    endpoints: { geminiGenerateContent: {} },
    pipelines: { geminiGenerateContent: stubStreamProvider('stub Gemini', call) },
  })]);
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
    pipelines: {
      anthropicMessagesCountTokens: stubScalarProvider<ProviderAnthropicInput>('stub Messages count', async (facts, env) => {
        expect(facts['request.anthropicBeta']).toEqual([]);
        expect(facts['request.payload']).not.toHaveProperty('stream');
        expect(facts['request.payload'].messages).toMatchObject([{ role: 'user' }]);
        expect(JSON.stringify(facts['request.payload'].messages)).toContain('"hi"');
        return await httpReply(env, Response.json(reply));
      }),
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
  const messages = vi.fn(async (facts: ProviderAnthropicInput, env: StageEnv) => {
    expect(JSON.stringify(facts['request.payload'].messages)).toContain('"keep"');
    expect(JSON.stringify(facts['request.payload'].messages)).not.toContain('fileData');
    expect(facts['request.payload']).not.toHaveProperty('tools');
    return await httpReply(env, Response.json({ input_tokens: 4 }));
  });
  const gemini = vi.fn(async (facts: GeminiInput, env: StageEnv) => {
    expect(facts['request.payload']).toEqual(request);
    return await httpReply(env, Response.json({ totalTokens: 4 }));
  });
  queue.push([
    chatUpstream({
      endpoints: { anthropicMessages: {} }, pipelines: { anthropicMessagesCountTokens: stubScalarProvider('stub Messages count', messages) },
    }),
  ], [
    chatUpstream({
      endpoints: { geminiGenerateContent: {} }, pipelines: { geminiGenerateContentCountTokens: stubScalarProvider('stub Gemini count', gemini) },
    }),
  ]);
  for (const _target of ['translated', 'native']) {
    const result = await send('countTokens', { generateContentRequest: request });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ totalTokens: 4 });
  }
  expect(messages).toHaveBeenCalledOnce();
  expect(gemini).toHaveBeenCalledOnce();
});

const geminiProvider = (respond: (env: StageEnv) => ReturnType<typeof eventReply<GeminiEvent>>) =>
  chatUpstream({
    endpoints: { geminiGenerateContent: {} },
    pipelines: { geminiGenerateContent: stubStreamProvider<GeminiInput, GeminiEvent>('stub Gemini', (_facts, env) => respond(env)) },
  });

const rpcBody = (wire: string): unknown => {
  const error = wire.indexOf('{"error":');
  if (error === -1) throw new Error(`Expected a Gemini RPC error in ${wire}`);
  return JSON.parse(wire.slice(error));
};

test.each([false, true])('Gemini response terminates immediately on a protocol error (stream=%s)', async stream => {
  const failure = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } };
  const trailing = vi.fn();
  queue.push([geminiProvider(env => eventReply(env, (async function* () {
    yield eventFrame(failure);
    trailing();
    throw new Error('Trailing frame pulled');
  })()))]);
  const response = await send(stream ? 'streamGenerateContent' : 'generateContent');
  expect(response.status).toBe(stream ? 200 : 429);
  expect(rpcBody(await response.text())).toEqual(failure);
  expect(trailing).not.toHaveBeenCalled();
});

test.each([false, true])('Gemini response exposes EOF with an unfinished observed candidate (stream=%s)', async stream => {
  queue.push([geminiProvider(env => eventReply(env, (async function* () {
    yield eventFrame({ candidates: [{ index: 0, content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
    yield eventFrame({ candidates: [{ index: 1, content: { parts: [{ text: 'unfinished' }] } }] });
  })()))]);
  const response = await send(stream ? 'streamGenerateContent' : 'generateContent');
  expect(response.status).toBe(stream ? 200 : 502);
  expect(rpcBody(await response.text())).toMatchObject({
    error: {
      code: stream ? 500 : 502, message: GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
    },
  });
});

test.each([false, true])('Gemini internal collect and SSE errors retain structured nested causes (stream=%s)', async stream => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  queue.push([geminiProvider(env => eventReply(env, (async function* () { throw failure; })()))]);
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
] satisfies { name: string; next: GeminiEvent; completed: boolean }[])('Gemini stream cancellation settles when $name', async ({ next, completed }) => {
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const waiting = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  queue.push([geminiProvider(env => {
    const now = env.clock();
    return {
      'response.http': { status: 200, statusText: '', body: null, headers: [], timing: { startedAt: now, headersAt: now } },
      'response.modelKey': 'gemini-key',
      'response.events': env.createStream({
        label: 'provider frames',
        async *iterate(signal) {
          yield eventFrame<GeminiEvent>({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
          yield eventFrame(next);
          await new Promise<void>(resolve => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
            waiting.resolve();
          });
        },
        onClose: () => stopped.resolve(),
      }),
    };
  })]);
  const response = await makeApp(3600).request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"finishReason":"STOP"');
  const pending = reader.read();
  await waiting.promise;
  await reader.cancel();
  await pending;
  await stopped.promise;
  await flushBackground();
  expect(dump.stored).toHaveLength(1);
  expect(dump.stored[0].meta.error === null).toBe(completed);
});
