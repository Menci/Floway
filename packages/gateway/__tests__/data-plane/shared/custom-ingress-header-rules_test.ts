import { test } from 'vitest';

import { buildCustomUpstreamRecord, requestApp, setupAppTest, sseOpenAIChatCompletionsResponse, sseAnthropicMessagesResponse } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

// One instance, one rule set, every client protocol. `x-route` is passed
// through and extended, `x-configured` is supplied entirely by the operator,
// and `x-dropped` carries no rule at all.
const INGRESS_HEADERS_RULES = [
  { key: 'x-route', value: null },
  { key: 'x-route', value: 'appended' },
  { key: 'x-configured', value: 'first' },
  { key: 'x-configured', value: 'second' },
];

const registerUpstream = async (repo: Awaited<ReturnType<typeof setupAppTest>>['repo']): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_rules',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: {},
      ingressHeadersRules: INGRESS_HEADERS_RULES,
      modelsFetch: { enabled: false },
      models: [
        { upstreamModelId: 'chat-model', endpoints: { openaiChatCompletions: {} } },
        { upstreamModelId: 'messages-model', endpoints: { anthropicMessages: {} } },
        { upstreamModelId: 'embedding-model', endpoints: { openaiEmbeddings: {} } },
        { upstreamModelId: 'completions-model', endpoints: { openaiCompletions: {} } },
        { upstreamModelId: 'image-model', endpoints: { openaiImagesGenerations: {} } },
        { upstreamModelId: 'transcription-model', endpoints: { openaiAudioTranscriptions: {} } },
        { upstreamModelId: 'rerank-model', kind: 'rerank', endpoints: { rerank: {} }, rerankTarget: { protocol: 'cohere-v2' } },
      ],
    },
  }));
};

// A client that repeats `x-route`, sends its own `x-configured`, and sends a
// name the instance has no rule for.
const clientHeaders = (apiKey: string, contentType: string | null): Headers => {
  const headers = new Headers({ 'x-api-key': apiKey });
  if (contentType !== null) headers.set('content-type', contentType);
  headers.append('x-route', 'client-a');
  headers.append('x-route', 'client-b');
  headers.set('x-configured', 'client-copy');
  headers.set('x-dropped', 'gone');
  return headers;
};

const assertUpstreamHeaders = (observed: Headers | undefined): void => {
  assertExists(observed);
  assertEquals(observed.get('x-route'), 'client-a, client-b, appended');
  assertEquals(observed.get('x-configured'), 'first, second');
  assertEquals(observed.get('x-dropped'), null);
};

interface RouteCase {
  name: string;
  path: string;
  body: () => BodyInit;
  contentType: string | null;
  upstreamPath: string;
  upstreamResponse: () => Response;
}

const CASES: RouteCase[] = [
  {
    name: '/v1/chat/completions reaches a Chat Completions upstream',
    path: '/v1/chat/completions',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'chat-model', messages: [{ role: 'user', content: 'hi' }] }),
    upstreamPath: '/v1/chat/completions',
    upstreamResponse: () => sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_1', model: 'chat-model', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },
  {
    name: '/v1/messages translates onto a Chat Completions upstream',
    path: '/v1/messages',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'chat-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    upstreamPath: '/v1/chat/completions',
    upstreamResponse: () => sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_2', model: 'chat-model', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },
  {
    name: '/v1/responses translates onto a Chat Completions upstream',
    path: '/v1/responses',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'chat-model', input: 'hi' }),
    upstreamPath: '/v1/chat/completions',
    upstreamResponse: () => sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_3', model: 'chat-model', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },
  {
    name: '/v1/chat/completions translates onto a Messages upstream',
    path: '/v1/chat/completions',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'messages-model', messages: [{ role: 'user', content: 'hi' }] }),
    upstreamPath: '/v1/messages',
    upstreamResponse: () => sseAnthropicMessagesResponse({
      id: 'msg_1', model: 'messages-model', role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  },
  {
    name: '/v1beta Gemini translates onto a Chat Completions upstream',
    path: '/v1beta/models/chat-model:generateContent',
    contentType: 'application/json',
    body: () => JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    upstreamPath: '/v1/chat/completions',
    upstreamResponse: () => sseOpenAIChatCompletionsResponse({
      id: 'chatcmpl_4', model: 'chat-model', created: 1,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  },
  {
    name: '/v1/messages/count_tokens reaches a Messages upstream',
    path: '/v1/messages/count_tokens',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'messages-model', messages: [{ role: 'user', content: 'hi' }] }),
    upstreamPath: '/v1/messages/count_tokens',
    upstreamResponse: () => jsonResponse({ input_tokens: 1 }),
  },
  {
    name: '/v1/embeddings reaches an Embeddings upstream',
    path: '/v1/embeddings',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'embedding-model', input: 'hi' }),
    upstreamPath: '/v1/embeddings',
    upstreamResponse: () => jsonResponse({
      object: 'list', model: 'embedding-model',
      data: [{ object: 'embedding', index: 0, embedding: [0.1] }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
  },
  {
    name: '/v1/completions reaches a Completions upstream',
    path: '/v1/completions',
    contentType: 'application/json',
    // Asks to stream, because the upstream below answers with one. A
    // non-streaming request whose upstream replies `text/event-stream` has no
    // body this protocol can read, and the pipeline answers 502 rather than
    // serving something it never parsed.
    body: () => JSON.stringify({ model: 'completions-model', prompt: 'hi', stream: true }),
    upstreamPath: '/v1/completions',
    upstreamResponse: () => new Response(
      'data: {"id":"cmpl_1","object":"text_completion","created":1,"model":"completions-model","choices":[{"index":0,"text":"ok","finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  },
  {
    name: '/v1/images/generations reaches an Images upstream',
    path: '/v1/images/generations',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'image-model', prompt: 'hi' }),
    upstreamPath: '/v1/images/generations',
    upstreamResponse: () => jsonResponse({ created: 1, data: [{ b64_json: 'abc' }] }),
  },
  {
    name: '/v1/audio/transcriptions reaches a Transcriptions upstream',
    path: '/v1/audio/transcriptions',
    contentType: null,
    body: () => {
      const form = new FormData();
      form.set('model', 'transcription-model');
      form.set('file', new File([new Uint8Array([1, 2])], 'voice.ogg', { type: 'audio/ogg' }));
      return form;
    },
    upstreamPath: '/v1/audio/transcriptions',
    upstreamResponse: () => jsonResponse({ text: 'ok' }),
  },
  {
    name: '/v1/rerank reaches a Rerank upstream',
    path: '/v1/rerank',
    contentType: 'application/json',
    body: () => JSON.stringify({ model: 'rerank-model', query: 'q', documents: ['one'] }),
    upstreamPath: '/v2/rerank',
    upstreamResponse: () => jsonResponse({ results: [{ index: 0, relevance_score: 1 }] }),
  },
];

for (const routeCase of CASES) {
  test(routeCase.name, async () => {
    const { apiKey, repo } = await setupAppTest();
    await registerUpstream(repo);
    let observed: Headers | undefined;
    let observedPath: string | undefined;

    const response = await withMockedFetch(
      request => {
        observedPath = new URL(request.url).pathname;
        observed = request.headers;
        return routeCase.upstreamResponse();
      },
      () => requestApp(routeCase.path, {
        method: 'POST',
        headers: clientHeaders(apiKey.key, routeCase.contentType),
        body: routeCase.body(),
      }),
    );

    assertEquals(response.status, 200);
    assertEquals(observedPath, routeCase.upstreamPath);
    assertUpstreamHeaders(observed);
  });
}
