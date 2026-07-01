import { test, vi } from 'vitest';

import { geminiAttempt } from './attempt.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_gemini_attempt_test';

const makeGatewayCtx = (): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: true,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(API_KEY_ID),
});

const makePayload = (overrides: Partial<GeminiPayload> = {}): GeminiPayload => ({
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

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
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

const makeResponsesResultEvent = (id = 'resp_test'): ResponsesStreamEvent => {
  const response: ResponsesResult = {
    id, object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi from responses' }],
    }],
    output_text: 'hi from responses', error: null, incomplete_details: null,
  };
  return { type: 'response.completed', sequence_number: 0, response };
};

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
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
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderCallResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
    callChatCompletions: overrides.callChatCompletions,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, kind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, instance: provider, supportsResponsesItemReference: true,
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

test('generate translates through Chat Completions when targetApi is chat-completions', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await geminiAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callChatCompletions }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});

test('generate translates through Messages when targetApi is messages', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await geminiAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callMessages, endpoints: { messages: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate translates through Responses when targetApi is responses', async () => {
  installRepo();
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true, events: makeProtocolFrames([makeResponsesResultEvent()]), modelKey: 'k', headers: new Headers(),
  }));
  const result = await geminiAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callResponses, endpoints: { responses: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('countTokens translates Gemini to Messages count_tokens and reshapes to totalTokens envelope', async () => {
  installRepo();
  let upstreamBody: Record<string, unknown> | undefined;
  const callMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    upstreamBody = body as Record<string, unknown>;
    return {
      response: new Response(JSON.stringify({ input_tokens: 42 }), {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
      }),
      modelKey: 'k',
    };
  });
  const result = await geminiAttempt.countTokens({
    payload: makePayload({ systemInstruction: { parts: [{ text: 'system' }] } }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callMessagesCountTokens }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.status, 200);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body, { totalTokens: 42 });
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
  // The Messages count_tokens body should never carry the translation-time
  // `stream: true` flag — that field belongs to the streaming path only.
  if (upstreamBody === undefined) throw new Error('upstreamBody not captured');
  assertEquals('stream' in upstreamBody, false);
});

test('countTokens accepts the upstream total_tokens dialect and refuses unknown shapes with a 502', async () => {
  installRepo();
  const totalTokensResp = await geminiAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callMessagesCountTokens: async () => ({
        response: new Response(JSON.stringify({ total_tokens: 19 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
        modelKey: 'k',
      }),
    }),
    headers: new Headers(),
  });
  assertEquals(totalTokensResp.type, 'plain');
  if (totalTokensResp.type !== 'plain') throw new Error('unreachable');
  assertEquals(JSON.parse(new TextDecoder().decode(totalTokensResp.body)), { totalTokens: 19 });

  const unexpectedResp = await geminiAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callMessagesCountTokens: async () => ({
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

test('countTokens refuses a non-messages candidate', async () => {
  installRepo();
  let thrown: unknown = null;
  try {
    await geminiAttempt.countTokens({
      payload: makePayload(),
      ctx: makeGatewayCtx(),
      candidate: makeCandidate({ endpoints: { responses: {} } }),
      headers: new Headers(),
    });
  } catch (error) {
    thrown = error;
  }
  if (!(thrown instanceof Error)) throw new Error('expected an Error to be thrown');
  assertEquals(thrown.message.includes('chatTargetPicker.pick'), true);
});

test('generate propagates upstream response headers through the chat-completions translation', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'x-request-id': 'req_gemini_xyz',
  });
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await geminiAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callChatCompletions }),
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('x-request-id'), 'req_gemini_xyz');
  await collectEvents(result.events);
});
