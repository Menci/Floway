import { test, vi } from 'vitest';

import { geminiGenerateContentAttempt } from '../../../../src/data-plane/chat/gemini-generate-content/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_gemini_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<GeminiGenerateContentPayload> = {}): GeminiGenerateContentPayload => ({
  contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
  ...overrides,
});

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', content: [],
      model: 'test-model', stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

const makeOpenAIResponsesResultEvent = (id = 'resp_test'): OpenAIResponsesStreamEvent => {
  const response: OpenAIResponsesResult = {
    id, object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi from responses', annotations: [] }],
    }],
    output_text: 'hi from responses', error: null, incomplete_details: null,
  };
  return { type: 'response.completed', sequence_number: 0, response };
};

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callAnthropicMessages: overrides.callAnthropicMessages,
    callOpenAIResponses: overrides.callOpenAIResponses,
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
    },
    model: stubInternalModel(overrides.endpoints ? { endpoints: overrides.endpoints } : {}, upstream),
    fetcher: directFetcher,
  };
};

const collectEvents = async <TEvent>(events: AsyncIterable<ProtocolFrame<TEvent>>): Promise<TEvent[]> => {
  const out: TEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate translates through OpenAI Chat Completions when targetApi is openai-chat-completions', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await geminiGenerateContentAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIChatCompletions.mock.calls.length, 1);
});

test('generate translates through Anthropic Messages when targetApi is messages', async () => {
  installRepo();
  let callOptions: AnthropicMessagesUpstreamCallOptions | undefined;
  const callAnthropicMessages = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    callOptions = opts;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers() };
  });
  const result = await geminiGenerateContentAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages, endpoints: { anthropicMessages: {} } }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
  assertEquals(callOptions?.anthropicBeta, []);
  assertEquals(callOptions?.headers.has('anthropic-beta'), false);
});

test('generate translates through OpenAI Responses when targetApi is responses', async () => {
  installRepo();
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true, events: makeProtocolFrames([makeOpenAIResponsesResultEvent()]), modelKey: 'k', headers: new Headers(),
  }));
  const result = await geminiGenerateContentAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIResponses, endpoints: { openaiResponses: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('countTokens translates Gemini generateContent to Anthropic Messages count_tokens and reshapes to totalTokens envelope', async () => {
  installRepo();
  let upstreamBody: Record<string, unknown> | undefined;
  let callOptions: AnthropicMessagesUpstreamCallOptions | undefined;
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body, _signal, opts): Promise<ProviderCallResult> => {
    upstreamBody = body as Record<string, unknown>;
    callOptions = opts;
    return {
      response: new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      modelKey: 'k',
    };
  });
  const result = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload({ systemInstruction: { parts: [{ text: 'system' }] } }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessagesCountTokens }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.status, 200);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body, { totalTokens: 42 });
  assertEquals(callAnthropicMessagesCountTokens.mock.calls.length, 1);
  assertEquals(callOptions?.anthropicBeta, []);
  assertEquals(callOptions?.headers.has('anthropic-beta'), false);
  // The Anthropic Messages count_tokens body should never carry the translation-time
  // `stream: true` flag — that field belongs to the streaming path only.
  if (upstreamBody === undefined) throw new Error('upstreamBody not captured');
  assertEquals('stream' in upstreamBody, false);
});

test('countTokens accepts the upstream total_tokens dialect and refuses unknown shapes with a 502', async () => {
  installRepo();
  const totalTokensResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        response: new Response(JSON.stringify({ total_tokens: 19 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(totalTokensResp.type, 'plain');
  if (totalTokensResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(JSON.parse(new TextDecoder().decode(totalTokensResp.body)), { totalTokens: 19 });

  const unexpectedResp = await geminiGenerateContentAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens: async () => ({
        response: new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(unexpectedResp.type, 'plain');
  if (unexpectedResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(unexpectedResp.status, 502);
  const body = JSON.parse(new TextDecoder().decode(unexpectedResp.body));
  assertEquals(body.error.code, 502);
  assertEquals(body.error.status, 'UNAVAILABLE');
});

test('countTokens refuses a non-anthropic-messages candidate', async () => {
  installRepo();
  let thrown: unknown = null;
  try {
    await geminiGenerateContentAttempt.countTokens({
      payload: makePayload(),
      ctx: makeGatewayCtx(),
      candidate: makeCandidate({ endpoints: { openaiResponses: {} } }),
      headers: new Headers(),
    });
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error)) throw new Error('expected an Error to be thrown');
  assertEquals(thrown.message.includes('chatTargetPicker.pick'), true);
});

test('generate propagates upstream response headers through the openai-chat-completions translation', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'x-request-id': 'req_gemini_xyz',
  });
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await geminiGenerateContentAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions }),
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('x-request-id'), 'req_gemini_xyz');
  await collectEvents(result.events);
});
