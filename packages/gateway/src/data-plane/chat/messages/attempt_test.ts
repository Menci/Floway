import { test, vi } from 'vitest';

import { messagesAttempt } from './attempt.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesResult } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import { assertEquals, assertExists, stubProvider, stubInternalModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_attempt_test';

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

const makePayload = (overrides: Partial<MessagesPayload> = {}): MessagesPayload => ({
  model: 'test-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeMessagesEvents = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
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

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

test('generate native messages target calls provider.callMessages with no rewrite', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await messagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callMessages }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate translate-to-responses branch routes through responsesAttempt', async () => {
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
  const result = await messagesAttempt.generate({
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

test('countTokens proxies the upstream response as a plain result', async () => {
  installRepo();
  const callMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 7 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
    modelKey: 'k',
  }));

  const result = await messagesAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callMessagesCountTokens }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.status, 200);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.input_tokens, 7);
  assertEquals(callMessagesCountTokens.mock.calls.length, 1);
});

test('countTokens refuses a non-messages candidate', async () => {
  installRepo();
  let thrown: unknown = null;
  try {
    await messagesAttempt.countTokens({
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

test('generate attaches the performance context and records upstream_success', async () => {
  const repo = installRepo();
  const background: Promise<unknown>[] = [];
  const ctx: ChatGatewayCtx = {
    ...makeGatewayCtx(),
    runtimeLocation: 'SJC',
    backgroundScheduler: (promise: Promise<unknown>) => { background.push(promise); },
  };
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'gpt-test', headers: new Headers(),
  }));

  const result = await messagesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate: makeCandidate({ upstream: 'up_perf', callMessages }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  // The full performance dimension set rides every chat result so both
  // telemetry scopes record.
  assertExists(result.performance);
  assertEquals(result.performance.keyId, API_KEY_ID);
  assertEquals(result.performance.model, 'test-model');
  assertEquals(result.performance.upstream, 'up_perf');
  assertEquals(result.performance.modelKey, 'gpt-test');
  assertEquals(result.performance.stream, true);
  assertEquals(result.performance.runtimeLocation, 'SJC');

  await collectEvents(result.events);
  await Promise.all(background);
  const upstreamSamples = await repo.performance.query({ metricScope: 'upstream_success', start: '0000', end: '9999' });
  assertEquals(upstreamSamples.length, 1);
  assertEquals(upstreamSamples[0]?.upstream, 'up_perf');
  assertEquals(upstreamSamples[0]?.requests, 1);
});

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'request-id': 'req_messages_xyz',
  });
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeMessagesEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await messagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callMessages }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('request-id'), 'req_messages_xyz');
  await collectEvents(result.events);
});
