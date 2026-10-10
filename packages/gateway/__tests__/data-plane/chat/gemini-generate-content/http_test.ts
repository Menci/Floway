import { Hono } from 'hono';
import { test, vi } from 'vitest';

import { createAssistantTurnSidecarCodec } from '../../../../src/data-plane/chat/shared/assistant-turn-sidecar/codec.ts';
import type { AuthVars } from '../../../../src/middleware/auth.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import type { ApiKey, User } from '../../../../src/repo/types.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import { collectGeminiGenerateContentProtocolEventsToResult } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderStreamResult, type UpstreamCallOptions } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';
import { translateGeminiGenerateContentViaOpenAIChatCompletions } from '@floway-dev/translate';

const candidatesQueue: { readonly candidates: readonly ModelCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }[] = [];
vi.mock('../../../../src/data-plane/providers/resolution.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../src/data-plane/providers/resolution.ts')>();
  return {
    ...original,
    enumerateModelCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('http_test: no candidates enqueued');
      return next;
    }),
  };
});

const { geminiGenerateContentHttp } = await import('../../../../src/data-plane/chat/gemini-generate-content/http.ts');

const API_KEY_ID = 'key_gemini_http_test';

const queueCandidates = (candidates: readonly ModelCandidate[], sawModel = candidates.length > 0): void => {
  candidatesQueue.push({ candidates, sawModel, failedUpstreams: [] });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const buildApiKey = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: API_KEY_ID,
  userId: 1,
  name: 'http_test',
  key: 'sk-http-test',
  serverSecret: '00'.repeat(32),
  createdAt: '2026-01-01T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: null,
  openaiResponsesRetentionSeconds: 0,
  ...overrides,
});

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: 1,
  username: 'http_test',
  passwordHash: null,
  isAdmin: false,
  upstreamIds: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  ...overrides,
});

const makeApp = (): Hono<{ Variables: AuthVars }> => {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', buildApiKey());
    c.set('user', buildUser());
    await next();
  });
  app.post('/v1beta/models/:modelAction{.+}', geminiGenerateContentHttp);
  return app;
};

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_http', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: 'openaiChatCompletions' | 'anthropicMessages' | 'openaiResponses';
  endpoints?: ModelEndpoints;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'openaiChatCompletions';
  // When the test fixes `endpoints` directly, use it verbatim — that lets a
  // test pin a wrong-endpoint shape the picker rejects. Otherwise synthesize
  // a single-endpoint map from `targetApi` so the gemini serve layer's
  // picker (openai-chat-completions first, then messages, then responses) lands on
  // the requested wire.
  const endpoints = overrides.endpoints ?? (targetApi === 'openaiChatCompletions'
    ? { openaiChatCompletions: {} }
    : targetApi === 'anthropicMessages'
      ? { anthropicMessages: {} }
      : { openaiResponses: {} });
  const provider = stubProvider({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessages: overrides.callAnthropicMessages,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
    },
    model: stubInternalModel({ endpoints }, upstream),
    fetcher: directFetcher,
  };
};

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEventEx[] => [
  {
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null,
      id: 'msg_http_m', type: 'message', role: 'assistant', content: [],
      model: 'test-model', stop_reason: null, stop_sequence: null,
      usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 4, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { citations: null, type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { container: null, stop_details: null, stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null, output_tokens: 1 } },
  { type: 'message_stop' },
];

test('POST /v1beta/models/:model:generateContent returns a single JSON body for non-stream generate', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callOpenAIChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:streamGenerateContent streams a Gemini generateContent SSE body', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ callOpenAIChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/test-model:streamGenerateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'text/event-stream');
  const text = await response.text();
  assert(text.length > 0);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens returns the Gemini generateContent totalTokens envelope', async () => {
  installRepo();
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 23 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 23 });
  assertEquals(callAnthropicMessagesCountTokens.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:countTokens accepts the generateContentRequest envelope shape', async () => {
  installRepo();
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ total_tokens: 7 }), {
      status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    }),
    modelKey: 'k',
  }));
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      generateContentRequest: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
    }),
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 7 });
});

test('POST /v1beta/models/:model:generateContent translates through Anthropic Messages target end to end', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessages })]);

  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { candidates?: { content: { parts: { text: string }[] } }[] };
  assert(body.candidates && body.candidates.length > 0);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
});

test('POST /v1beta/models/:model:unknownAction returns a Google RPC 404 envelope', async () => {
  installRepo();
  // No candidates queued — the action parser short-circuits before routing.
  const response = await makeApp().request('/v1beta/models/test-model:unknownAction', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: '{}',
  });

  assertEquals(response.status, 404);
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 404);
  assertEquals(body.error.status, 'NOT_FOUND');
  assert(body.error.message.includes('Unknown Gemini model action'));
});

test('POST /v1beta/models/models/:model:generateContent accepts the models/ prefix in the path id', async () => {
  installRepo();
  let resolvedModel: string | undefined;
  const callOpenAIChatCompletions = vi.fn(async (model): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    resolvedModel = (model as { id: string }).id;
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers() };
  });
  queueCandidates([makeCandidate({ callOpenAIChatCompletions })]);

  const response = await makeApp().request('/v1beta/models/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 200);
  // The `models/` prefix is normalised away before reaching candidate enumeration.
  assertEquals(resolvedModel, stubInternalModel().id);
});

test('POST /v1beta/models/:model:generateContent renders the Gemini-generateContent-shaped model-unsupported 400 when no candidate matches the gemini-generate-content-generate picker', async () => {
  installRepo();
  // Queue a chat-kind candidate whose endpoints expose only `openaiCompletions` —
  // geminiGenerateContentGenerateTarget (openai-chat-completions > messages > responses) rejects
  // it, leaving zero viable candidates, and with sawModel=true the serve
  // renders model-unsupported as a 400.
  queueCandidates([makeCandidate({ upstream: 'up_x', endpoints: { openaiCompletions: {} } })]);

  const response = await makeApp().request('/v1beta/models/wrong-endpoint-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  });

  assertEquals(response.status, 400);
  assertEquals(response.headers.get('content-type')?.split(';')[0], 'application/json');
  const body = await response.json() as { error: { code: number; status: string; message: string } };
  assertEquals(body.error.code, 400);
  assertEquals(body.error.status, 'INVALID_ARGUMENT');
  assert(body.error.message.includes('does not support'));
});

test('POST generateContent restores unchanged numeric tokens from a signed assistant turn', async () => {
  installRepo();
  const argumentsText = '{"large":900719925474099312345,"overflow":1e999}';
  const rawJson = JSON as typeof JSON & { rawJSON: (text: string) => unknown };
  const expectedOutputTokens = Number('9007199254740993');
  const codec = createAssistantTurnSidecarCodec(buildApiKey());
  const trip = await translateGeminiGenerateContentViaOpenAIChatCompletions({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, { model: 'test-model', assistantTurnSidecar: codec });
  const events: OpenAIChatCompletionsStreamEvent[] = [
    { id: 'chat', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'lookup', arguments: argumentsText } }] }, finish_reason: null }] },
    { id: 'chat', object: 'chat.completion.chunk', model: 'test-model', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const generated = await collectGeminiGenerateContentProtocolEventsToResult(trip.events(makeProtocolFrames(events)));
  const contents = generated.candidates!.map(candidate => candidate.content!);
  let upstreamArguments: string | undefined;
  let upstreamMaxTokens: unknown;
  let upstreamReasoningEffort: unknown;
  const callOpenAIChatCompletions = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    const payload = body as { max_tokens?: unknown; reasoning_effort?: unknown; messages: { tool_calls?: { function: { arguments: string } }[] }[] };
    upstreamArguments = payload.messages[0]!.tool_calls![0]!.function.arguments;
    upstreamMaxTokens = payload.max_tokens;
    upstreamReasoningEffort = payload.reasoning_effort;
    return { ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers() };
  });
  queueCandidates([makeCandidate({ callOpenAIChatCompletions })]);
  const response = await makeApp().request('/v1beta/models/test-model:generateContent', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      contents,
      generationConfig: {
        maxOutputTokens: rawJson.rawJSON('9007199254740993'),
        thinkingConfig: { thinkingBudget: rawJson.rawJSON('9007199254740993') },
      },
    }),
  });
  assertEquals(response.status, 200);
  await response.text();
  assertEquals(upstreamArguments, argumentsText);
  assertEquals(typeof upstreamMaxTokens, 'number');
  assertEquals(upstreamMaxTokens, expectedOutputTokens);
  assertEquals(upstreamReasoningEffort, 'high');
});

test('POST countTokens preserves assistant argument tokens in nested generateContentRequest and keeps generation settings numeric', async () => {
  installRepo();
  const argumentsText = '{"large":900719925474099312345,"overflow":1e999}';
  const expectedSetting = Number('9007199254740993');
  let upstreamArguments: string | undefined;
  let upstreamMaxTokens: unknown;
  let upstreamThinkingBudget: unknown;
  const callAnthropicMessagesCountTokens = vi.fn(async (_model: unknown, body: unknown): Promise<ProviderCallResult> => {
    const payload = body as {
      max_tokens: unknown;
      thinking?: { budget_tokens?: unknown };
      messages: { content: { type: string; input: unknown }[] }[];
    };
    upstreamMaxTokens = payload.max_tokens;
    upstreamThinkingBudget = payload.thinking?.budget_tokens;
    upstreamArguments = JSON.stringify(payload.messages[0]!.content[0]!.input);
    return {
      response: new Response(JSON.stringify({ input_tokens: 7 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      modelKey: 'k',
    };
  });
  queueCandidates([makeCandidate({ targetApi: 'anthropicMessages', callAnthropicMessagesCountTokens })]);

  const response = await makeApp().request('/v1beta/models/test-model:countTokens', {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: `{"generateContentRequest":{"model":"test-model","contents":[{"role":"model","parts":[{"functionCall":{"name":"lookup","args":${argumentsText}}}]}],"generationConfig":{"maxOutputTokens":9007199254740993,"thinkingConfig":{"thinkingBudget":9007199254740993}}}}`,
  });

  assertEquals(response.status, 200);
  assertEquals(await response.json(), { totalTokens: 7 });
  assertEquals(upstreamArguments, argumentsText);
  assertEquals(typeof upstreamMaxTokens, 'number');
  assertEquals(upstreamMaxTokens, expectedSetting);
  assertEquals(typeof upstreamThinkingBudget, 'number');
  assertEquals(upstreamThinkingBudget, expectedSetting);
});
