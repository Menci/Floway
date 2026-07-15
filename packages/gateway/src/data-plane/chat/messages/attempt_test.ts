import { test, vi } from 'vitest';

import { messagesAttempt } from './attempt.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-helpers/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesClientTool, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult } from '@floway-dev/protocols/responses';
import { type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderResponsesResult, type ProviderStreamResult, type ResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assertEquals, assertExists, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

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
  enabledFlags?: ReadonlySet<FlagId>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} };
  const provider = stubProvider({
    callMessages: overrides.callMessages,
    callResponses: overrides.callResponses,
    callChatCompletions: overrides.callChatCompletions,
    callMessagesCountTokens: overrides.callMessagesCountTokens,
  });
  return {
    provider: {
      upstream, kind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, instance: provider,
    },
    model: stubInternalModel({
      endpoints,
      providerModels: {
        [upstream]: stubProviderModel({ endpoints, enabledFlags: new Set<FlagId>(overrides.enabledFlags ?? []) }),
      },
    }, upstream),
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

test('generate lets target promotion take precedence over source demotion', async () => {
  installRepo();
  const observedBodies: Omit<ResponsesPayload, 'model'>[] = [];
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBodies.push(body as Omit<ResponsesPayload, 'model'>);
    return {
      action: 'generate',
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: {
          id: 'resp_x',
          object: 'response',
          model: 'test-model',
          status: 'completed',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });

  const result = await messagesAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callResponses,
      endpoints: { responses: {} },
      enabledFlags: new Set<FlagId>([
        'demote-interleaved-system-to-user',
        'promote-system-to-developer',
      ]),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callResponses.mock.calls.length, 1);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed Responses body');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected Responses input array');
  assertEquals(input[0], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[1], { type: 'message', role: 'developer', content: 'inline instructions' });
});

test('generate translate-to-responses branch promotes multi-block system prefix', async () => {
  installRepo();
  const observedBodies: Omit<ResponsesPayload, 'model'>[] = [];
  const callResponses = vi.fn(async (_model, body): Promise<ProviderResponsesResult> => {
    observedBodies.push(body as Omit<ResponsesPayload, 'model'>);
    return {
      action: 'generate',
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed',
        sequence_number: 0,
        response: {
          id: 'resp_x',
          object: 'response',
          model: 'test-model',
          status: 'completed',
          output: [],
          output_text: '',
          error: null,
          incomplete_details: null,
        },
      }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });

  const result = await messagesAttempt.generate({
    payload: makePayload({
      system: [{ type: 'text', text: 'base A' }, { type: 'text', text: 'base B' }],
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callResponses,
      endpoints: { responses: {} },
      enabledFlags: new Set<FlagId>(['promote-system-to-developer']),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callResponses.mock.calls.length, 1);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed Responses body');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected Responses input array');
  assertEquals(input[0], {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'base A' }, { type: 'input_text', text: 'base B' }],
  });
  assertEquals(input[1], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[2], { type: 'message', role: 'developer', content: 'inline instructions' });
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

test('countTokens applies generation request transforms before provider dispatch', async () => {
  installRepo();
  const observedBodies: Array<Omit<MessagesPayload, 'model'>> = [];
  const callMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    observedBodies.push(body as Omit<MessagesPayload, 'model'>);
    return { response: Response.json({ input_tokens: 9 }), modelKey: 'k' };
  });

  const result = await messagesAttempt.countTokens({
    payload: makePayload({
      system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
      messages: [
        { role: 'system', content: 'inline rules' },
        { role: 'user', content: 'hello' },
      ],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      output_config: { effort: 'high' },
      tool_choice: { type: 'tool', name: 'lookup' },
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callMessagesCountTokens,
      enabledFlags: new Set<FlagId>([
        'strip-billing-attribution',
        'disable-reasoning-on-forced-tool-choice',
        'demote-interleaved-system-to-user',
      ]),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'plain');
  assertEquals(observedBodies, [{
    max_tokens: 32,
    system: 'base rules',
    messages: [
      { role: 'user', content: 'inline rules' },
      { role: 'user', content: 'hello' },
    ],
    thinking: { type: 'disabled' },
    tool_choice: { type: 'tool', name: 'lookup' },
  }]);
});

test('countTokens prepares the generation web-search request shape', async () => {
  installRepo();
  const observedBodies: Array<Omit<MessagesPayload, 'model'>> = [];
  const callMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    observedBodies.push(body as Omit<MessagesPayload, 'model'>);
    return { response: Response.json({ input_tokens: 11 }), modelKey: 'k' };
  });

  const result = await messagesAttempt.countTokens({
    payload: makePayload({ tools: [{ type: 'web_search_20260209', max_uses: 3 }] }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callMessagesCountTokens,
      enabledFlags: new Set<FlagId>(['messages-web-search-shim']),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'plain');
  const tool = observedBodies[0]?.tools?.[0] as MessagesClientTool | undefined;
  if (tool === undefined) throw new Error('expected rewritten web-search tool');
  assertEquals(tool.name, 'web_search');
  assertEquals('type' in tool, false);
  assertEquals(tool.input_schema, {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  });
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

test('generate attaches the performance context to the result', async () => {
  installRepo();
  const ctx = mockChatGatewayCtx({
    apiKeyId: API_KEY_ID,
    wantsStream: true,
    runtimeLocation: 'SJC',
  });
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
  // result.performance carries the full dimension set that respond.ts will
  // use to record telemetry once the stream settles.
  assertExists(result.performance);
  assertEquals(result.performance.keyId, API_KEY_ID);
  assertEquals(result.performance.model, 'test-model');
  assertEquals(result.performance.upstream, 'up_perf');
  assertEquals(result.performance.runtimeLocation, 'SJC');

  await collectEvents(result.events);
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
