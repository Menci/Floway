import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, parseSSEText, requestAppWithWarmModels, setupAppTest, sseAnthropicMessagesResponse, sseOpenAIChatCompletionsResponse, sseOpenAIResponsesResponse, sseResponse } from '../../../test-utils/app.ts';
import { flushBackground } from '../../../test-utils/background-tracker.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { withMockedFetch } from '@floway-dev/test-utils';

const model = 'gemini-test';
const contents = [{ role: 'user', parts: [{ text: 'hello' }] }];

const setup = async (endpoints: ModelEndpoints = { geminiGenerateContent: {} }) => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'gemini-upstream',
    config: {
      baseUrl: 'https://gemini.example.com',
      ingressHeadersRules: [],
      apiKey: 'gemini-upstream-key',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: model, endpoints }],
    },
  }));
  return {
    repo,
    request: (path: string, payload: Record<string, unknown> = { contents }) => requestAppWithWarmModels(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
      body: JSON.stringify(payload),
    }),
  };
};

const generation = {
  candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'native answer' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  extension: { mode: 'verbatim' },
};

test('Gemini public actions stream and collect the same preserved native protocol response', async () => {
  const { request, repo } = await setup({ geminiGenerateContent: {}, openaiChatCompletions: {} });
  await withMockedFetch(async upstream => {
    const url = new URL(upstream.url);
    expect(url.pathname).toBe(`/v1beta/models/${model}:streamGenerateContent`);
    expect(url.searchParams.get('alt')).toBe('sse');
    expect(upstream.headers.get('x-goog-api-key')).toBe('gemini-upstream-key');
    expect(await upstream.json()).toEqual({ contents, extension: true });
    return sseResponse([{ data: generation }]);
  }, async () => {
    const stream = await request(`/v1/models/${model}:streamGenerateContent`, { contents, extension: true });
    expect(stream.status).toBe(200);
    expect(JSON.parse(parseSSEText(await stream.text())[0]!.data)).toMatchObject(generation);

    const json = await request(`/v1beta/models/models/${model}:generateContent`, { contents, extension: true });
    expect(json.status).toBe(200);
    expect(await json.json()).toMatchObject(generation);
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, requests: 2 }]);
  expect(await repo.performance.listAll()).toMatchObject([{ model, operation: 'chat', requests: 2 }]);
});

test('Gemini countTokens carries both request forms, nested model and bodyless success without billing', async () => {
  const { request, repo } = await setup();
  const observed: unknown[] = [];
  await withMockedFetch(async upstream => {
    expect(new URL(upstream.url).pathname).toBe(`/v1beta/models/${model}:countTokens`);
    observed.push(await upstream.json());
    return observed.length === 1 ? Response.json({ totalTokens: 7 }) : new Response(null, { status: 204 });
  }, async () => {
    const path = `/v1beta/models/${model}:countTokens`;
    const first = await request(path, { contents });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ totalTokens: 7 });
    const second = await request(path, { generateContentRequest: { model: 'ignored', contents, systemInstruction: { parts: [{ text: 'important' }] } } });
    expect(second.status).toBe(204);
    expect(await second.text()).toBe('');
  });
  await flushBackground();
  expect(observed).toEqual([
    { generateContentRequest: { model: `models/${model}`, contents } },
    { generateContentRequest: { model: `models/${model}`, contents, systemInstruction: { parts: [{ text: 'important' }] } } },
  ]);
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ model, operation: 'chat', requests: 2 }]);
});

test('Gemini countTokens filters out candidates supporting only a translated generation wire', async () => {
  const { request, repo } = await setup({ openaiChatCompletions: {} });
  await withMockedFetch(upstream => {
    throw new Error(`The count unexpectedly reached ${upstream.url}`);
  }, async () => {
    const response = await request(`/v1beta/models/${model}:countTokens`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { status: 'INVALID_ARGUMENT', message: `Model ${model} does not support countTokens.` } });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toEqual([]);
});

test.each(['generateContent', 'streamGenerateContent'])('Gemini %s maps a native RPC error code while preserving JSON and headers', async action => {
  const { request } = await setup();
  const body = { error: { code: 412, status: 'FAILED_PRECONDITION', message: 'account is not ready' } };
  await withMockedFetch(() => Response.json(body, { status: 400, headers: { 'request-id': 'req-google-rpc' } }), async () => {
    const response = await request(`/v1beta/models/${model}:${action}`);
    expect(response.status).toBe(412);
    expect(response.headers.get('request-id')).toBe('req-google-rpc');
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();
});

test('Gemini maps a non-JSON upstream error to INTERNAL while retaining the original text and headers', async () => {
  const { request } = await setup();
  const message = 'upstream needs attention';
  const body = { error: { code: 409, status: 'ABORTED', message } };
  await withMockedFetch(() => new Response(message, { status: 409, headers: { 'request-id': 'text-error' } }), async () => {
    const response = await request(`/v1/models/${model}:generateContent`);
    expect(response.status).toBe(500);
    expect(response.headers.get('request-id')).toBe('text-error');
    expect(await response.json()).toEqual({ error: { code: 500, status: 'INTERNAL', message } });
  });
  await withMockedFetch(() => new Response(JSON.stringify(body), { status: 409, headers: { 'content-type': 'text/plain' } }), async () => {
    const response = await request(`/v1/models/${model}:generateContent`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(body);
  });
  await flushBackground();
});

test('Gemini generation translates through Chat Completions after dropping unsupported source fields', async () => {
  const { request, repo } = await setup({ openaiChatCompletions: {}, anthropicMessages: {} });
  await withMockedFetch(async upstream => {
    expect(upstream.url).toBe('https://gemini.example.com/v1/chat/completions');
    expect(await upstream.json()).toMatchObject({
      model, stream: true, messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true },
    });
    return sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_http', created: 1, model,
      choices: [{ message: { role: 'assistant', content: 'translated answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  }, async () => {
    const response = await request(`/v1beta/models/${model}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'hello' }, { fileData: { fileUri: 'gs://file' } }] }],
      tools: [{ googleSearch: {} }],
      safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [{ text: 'translated answer' }] } }] });
  });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ model, requests: 1 }]);
});

test.each([false, true])('Gemini sets thought visibility to %s for translated Chat Completions reasoning', async includeThoughts => {
  const { request } = await setup({ openaiChatCompletions: {} });
  await withMockedFetch(() => {
    const chunk = { id: 'chatcmpl_http', model, created: 1, object: 'chat.completion.chunk' };
    return sseResponse([
      { data: { ...chunk, choices: [{ index: 0, delta: { reasoning_content: 'first thought' }, finish_reason: null }] } },
      { data: { ...chunk, choices: [{ index: 0, delta: { content: 'visible answer' }, finish_reason: 'stop' }] } },
      { data: '[DONE]' },
    ]);
  }, async () => {
    const response = await request(`/v1beta/models/${model}:generateContent`, {
      contents, generationConfig: { thinkingConfig: { includeThoughts } },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { candidates: Array<{ content: { parts: Array<{ text?: string; thought?: boolean }> } }> };
    const parts = body.candidates.flatMap(candidate => candidate.content.parts);
    expect(parts.some(part => part.text === 'first thought' && part.thought === true)).toBe(includeThoughts);
    expect(parts.some(part => part.text === 'visible answer')).toBe(true);
  });
  await flushBackground();
});

test.each(['anthropicMessages', 'openaiResponses'] as const)('Gemini generation translates through %s when preferred wires are absent', async protocol => {
  const { request } = await setup({ [protocol]: {} });
  await withMockedFetch(async upstream => {
    const payload = await upstream.json();
    if (protocol === 'anthropicMessages') {
      expect(upstream.url).toBe('https://gemini.example.com/v1/messages');
      expect(payload).toMatchObject({ model, stream: true, messages: [{ role: 'user' }] });
      return sseAnthropicMessagesResponse({
        type: 'message', id: 'msg_1', model, role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'translated answer' }], usage: { input_tokens: 3, output_tokens: 2 },
      });
    }
    expect(upstream.url).toBe('https://gemini.example.com/v1/responses');
    expect(payload).toMatchObject({ model, stream: true, input: [{ role: 'user' }] });
    return sseOpenAIResponsesResponse({
      id: 'resp_gemini', model, object: 'response', status: 'completed', created_at: 1,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'translated answer', annotations: [] }] }],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      error: null,
      incomplete_details: null,
    });
  }, async () => {
    const response = await request(`/v1beta/models/${model}:generateContent`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ candidates: [{ content: { parts: [{ text: 'translated answer' }] } }] });
  });
  await flushBackground();
});
