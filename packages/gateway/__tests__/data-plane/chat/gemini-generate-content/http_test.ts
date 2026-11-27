import { expect, test, vi } from 'vitest';

import { geminiGenerateContentHttpEntry } from '../../../../src/data-plane/chat/gemini-generate-content/pipeline/ingress.ts';
import { geminiGenerateContentCountTokensIngress } from '../../../../src/data-plane/non-chat/count-tokens/pipeline.ts';
import { servePipelineHttp } from '../../../../src/data-plane/shared/pipeline-http.ts';
import { customCandidate, operationHost, requestFor } from '../../non-chat/count-tokens/fixtures.ts';
import { mountedChatPanic } from '../pipeline/http-panic-fixtures.ts';
import { HttpTransportError, type Fetcher } from '@floway-dev/http';

const path = '/v1beta/models/public-model';
const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];
const candidate = (id = 'gemini') => customCandidate(id, { geminiGenerateContent: {} });

test.each(['generateContent', 'countTokens'])('renders a pre-head Gemini panic for %s with INTERNAL and diagnostics', async action => {
  const { status, text, failure, cause } = await mountedChatPanic(
    `/v1beta/models/test-model:${action}`, { contents }, { geminiGenerateContent: {} },
  );
  expect(status).toBe(500);
  expect(JSON.parse(text)).toMatchObject({
    error: {
      code: 500, status: 'INTERNAL', message: failure.message,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: failure.stack?.split('\n') },
        { '@type': 'type.googleapis.com/google.protobuf.Struct', value: { cause: { message: cause.message } } },
      ],
    },
  });
});

test('emits a bare Gemini INTERNAL JSON error for a post-head panic', async () => {
  const first = sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'first content' }] } }] });
  const { status, text, failure } = await mountedChatPanic(
    '/v1beta/models/test-model:streamGenerateContent', { contents }, { geminiGenerateContent: {} }, new Uint8Array(await first.arrayBuffer()),
  );
  expect(status).toBe(200);
  expect(text).toContain('first content');
  const trailer = text.split('\n\n').at(-1);
  expect(trailer).toMatch(/^\{"error":/);
  expect(JSON.parse(trailer!)).toMatchObject({
    error: {
      code: 500, status: 'INTERNAL', message: failure.message, details: [
        { '@type': 'type.googleapis.com/google.rpc.DebugInfo', stackEntries: failure.stack?.split('\n') },
        { '@type': 'type.googleapis.com/google.protobuf.Struct' },
      ],
    },
  });
});

test.each([false, true])('Gemini Generate Content retains the nested transport diagnostic for stream=%s', async stream => {
  const cause = new TypeError('nested transport cause');
  const failure = new HttpTransportError(new Error('broken socket', { cause }));
  const head = sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] });
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
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry, requestFor(`${path}:${stream ? 'streamGenerateContent' : 'generateContent'}`, { contents }), host.options);
  expect(response.status).toBe(stream ? 200 : 500);
  const body = await response.text();
  expect(body).toContain('"name":"TypeError"');
  expect(body).toContain('"message":"nested transport cause"');
  expect(body).toContain('type.googleapis.com/google.rpc.DebugInfo');
  expect(body).toContain('type.googleapis.com/google.protobuf.Struct');
  await host.settle();
});
const sse = (...events: unknown[]) => new Response(events
  .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
  headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'wire-id' },
});
const finished = { candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }] };
const streamError = { error: { code: 429, message: 'try later', status: 'RESOURCE_EXHAUSTED' } };

test.each(['generateContent', 'streamGenerateContent'])('preserves the native HTTP status, headers and Google RPC error for %s', async action => {
  const error = { error: { code: 412, status: 'FAILED_PRECONDITION', message: 'account is not ready' } };
  const host = operationHost([candidate()], async () => Response.json(error, {
    status: 400, headers: { 'request-id': 'req-google-rpc' },
  }));
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry, requestFor(`${path}:${action}`, { contents }), host.options);
  expect(response.status).toBe(400);
  expect(response.headers.get('request-id')).toBe('req-google-rpc');
  await expect(response.json()).resolves.toEqual(error);
  await host.settle();
});

test.each([false, true])('encodes a Gemini stream failure for stream=%s', async stream => {
  const host = operationHost([candidate()], async () => sse(streamError));
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry,
    requestFor(`${path}:${stream ? 'streamGenerateContent' : 'generateContent'}`, { contents }), host.options);
  expect(response.status).toBe(stream ? 200 : 429);
  expect(JSON.parse(await response.text())).toEqual(streamError);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'gemini', failed: true }));
});

test.each([false, true])('reports unfinished Gemini EOF for stream=%s', async stream => {
  const unfinished = { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'partial' }] } }] };
  const host = operationHost([candidate()], async () => sse(unfinished));
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry,
    requestFor(`${path}:${stream ? 'streamGenerateContent' : 'generateContent'}`, { contents }), host.options);
  expect(response.status).toBe(stream ? 200 : 500);
  const text = await response.text();
  expect(text).toContain('"status":"INTERNAL"');
  expect(text).toContain('stackEntries');
  if (stream) expect(text).toContain('"text":"partial"');
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ upstream: 'gemini', failed: true }));
});

test('accepts a models/ path prefix, prefers the native wire and preserves opaque history', async () => {
  const inputContents = [
    ...contents,
    { role: 'model', parts: [{ text: 'history', thoughtSignature: 'client-owned-signature' }] },
  ];
  const fetcher = vi.fn<Fetcher>(async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1beta/models/wire-model:streamGenerateContent');
    expect(JSON.parse(String(init.body))).toEqual({ contents: inputContents });
    return sse(finished);
  });
  const host = operationHost([customCandidate('both', { openaiChatCompletions: {}, geminiGenerateContent: {} })], fetcher);
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry,
    requestFor('/v1beta/models/models/public-model:streamGenerateContent', { contents: inputContents }), host.options);
  expect(response.status).toBe(200);
  expect(response.headers.get('x-goog-request-id')).toBe('wire-id');
  const wire = await response.text();
  expect(wire).toContain('"text":"hello"');
  expect(wire).toContain('"finishReason":"STOP"');
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', model: 'public-model' });
  await host.settle();
  expect(fetcher).toHaveBeenCalledOnce();
});

test('applies alias rules to the translated Gemini wire target', async () => {
  const target = customCandidate('chat', { openaiChatCompletions: {} });
  const host = operationHost([{
    ...target, rules: { reasoning: { effort: 'high' }, verbosity: 'low' },
  }], async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/chat/completions');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'wire-model', reasoning_effort: 'high', verbosity: 'low' });
    return sse({
      id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'wire-model',
      choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }],
    });
  });
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry,
    requestFor('/v1beta/models/alias:generateContent', { contents }), host.options);
  expect(response.status).toBe(200);
  expect(host.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ kind: 'chat', model: 'alias' });
  await host.settle();
});

test('retains a native Gemini candidate after the translated candidate rejects input', async () => {
  const fetcher = vi.fn<Fetcher>(async url => {
    expect(new URL(url).hostname).toBe('gemini.example');
    return sse(finished);
  });
  const host = operationHost([customCandidate('messages', { anthropicMessages: {} }), candidate()], fetcher);
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry, requestFor(`${path}:generateContent`, {
    contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AQID' } }] }],
  }), host.options);
  expect(response.status).toBe(200);
  await host.settle();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(host.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ upstream: 'gemini', failed: false }));
});

test('rejects a Gemini request when a known model exposes only a non-generation endpoint', async () => {
  const fetcher = vi.fn<Fetcher>(async () => { throw new Error('Unsupported request reached transport'); });
  const host = operationHost([customCandidate('embed', { openaiEmbeddings: {} })], fetcher);
  const response = await servePipelineHttp(geminiGenerateContentHttpEntry, requestFor(`${path}:generateContent`, { contents }), host.options);
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: { status: 'INVALID_ARGUMENT', message: expect.stringContaining('generateContent') } });
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  { payload: { input_tokens: 19 }, status: 200, expected: { totalTokens: 19 } },
  { payload: { total_tokens: 19 }, status: 200, expected: { totalTokens: 19 } },
  { payload: { other: 19 }, status: 502, expected: { error: { status: 'UNAVAILABLE' } } },
])('translates Gemini count-tokens usage with status $status', async ({ payload, status, expected }) => {
  const host = operationHost([customCandidate('messages', { anthropicMessages: {} })], async (url, init) => {
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    expect(new Headers(init.headers).get('anthropic-beta')).toBeNull();
    expect(JSON.parse(String(init.body))).not.toHaveProperty('stream');
    return Response.json(payload);
  });
  const response = await servePipelineHttp(geminiGenerateContentCountTokensIngress, requestFor(`${path}:countTokens`, { contents }), host.options);
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toMatchObject(expected);
  await host.settle();
});

test.each([false, true])('cleans Gemini count input only for a translated target (native=%s)', async native => {
  const generation = {
    contents: [{ role: 'user', parts: [{ text: 'hello' }, { fileData: { fileUri: 'gs://file' } }] }],
    safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
    tools: [{ googleSearch: {} }],
  };
  const target = native ? candidate() : customCandidate('messages', { anthropicMessages: {} });
  const host = operationHost([target], async (url, init) => {
    const body = JSON.parse(String(init.body)) as unknown;
    if (native) {
      expect(new URL(url).pathname).toBe('/v1beta/models/wire-model:countTokens');
      expect(body).toEqual({ generateContentRequest: { ...generation, model: 'models/wire-model' } });
      return Response.json({ totalTokens: 3 });
    }
    expect(new URL(url).pathname).toBe('/v1/messages/count_tokens');
    expect(body).toEqual({
      model: 'wire-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
    });
    return Response.json({ input_tokens: 3 });
  });
  const response = await servePipelineHttp(geminiGenerateContentCountTokensIngress, requestFor(`${path}:countTokens`, {
    generateContentRequest: generation,
  }), host.options);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ totalTokens: 3 });
  await host.settle();
});
