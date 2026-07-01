import { test, vi } from 'vitest';

import { chatCompletionsAttempt } from './attempt.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_chat_completions_attempt_test';

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

const makePayload = (overrides: Partial<ChatCompletionsPayload> = {}): ChatCompletionsPayload => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeChatCompletionsEvents = (): readonly ChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_cc_via_m', type: 'message', role: 'assistant', content: [],
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

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<ChatCompletionsStreamEvent>>;
  callMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<MessagesStreamEvent>>;
  callResponses?: (model: unknown, body: unknown, action: ResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderResponsesResult>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const provider = stubProvider({
    callChatCompletions: overrides.callChatCompletions,
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
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

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

test('generate native chat-completions target calls provider.callChatCompletions', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await chatCompletionsAttempt.generate({
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

test('generate translates through the Messages target when only that endpoint is exposed', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await chatCompletionsAttempt.generate({
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

test('generate translates through the Responses target when only that endpoint is exposed', async () => {
  installRepo();
  const respResp: ResponsesResult = {
    id: 'resp_x', object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi' }],
    }],
    output_text: 'hi', error: null, incomplete_details: null,
  };
  const callResponses = vi.fn(async (): Promise<ProviderResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: respResp }]),
    modelKey: 'k',
    headers: new Headers(),
  }));
  const result = await chatCompletionsAttempt.generate({
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

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'cf-ray': 'cf_ray_cc',
  });
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeChatCompletionsEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await chatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callChatCompletions }),
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('cf-ray'), 'cf_ray_cc');
  await collectEvents(result.events);
});
