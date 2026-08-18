import { test, vi } from 'vitest';

import { openaiChatCompletionsAttempt } from '../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesPayload, OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assert, assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_chat_completions_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<OpenAIChatCompletionsPayload> = {}): OpenAIChatCompletionsPayload => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
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

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEvent[] => [
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
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>;
  enabledFlags?: ReadonlySet<FlagId>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} };
  const provider = stubProvider({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessages: overrides.callAnthropicMessages,
    callOpenAIResponses: overrides.callOpenAIResponses,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, instance: provider,
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

test('generate native openai-chat-completions target calls provider.callOpenAIChatCompletions', async () => {
  installRepo();
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await openaiChatCompletionsAttempt.generate({
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

test('generate native target applies role compatibility flags in target-chain order', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayload, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (_model, body): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedBody = body as Omit<OpenAIChatCompletionsPayload, 'model'>;
    return {
      ok: true,
      events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()),
      modelKey: 'k',
      headers: new Headers(),
    };
  });
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'system', content: 'base instructions' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callOpenAIChatCompletions,
      endpoints: { chatCompletions: {} },
      enabledFlags: new Set([
        'rewrite-developer-to-system',
        'rewrite-mid-conv-system-to-user',
        'rewrite-system-to-developer',
      ]),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(observedBody?.messages, [
    { role: 'system', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'user', content: 'inline instructions' },
  ]);
});

test('generate translates through the Anthropic Messages target when only that endpoint is exposed', async () => {
  installRepo();
  let anthropicBeta: readonly string[] | undefined;
  const callAnthropicMessages = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    anthropicBeta = opts?.anthropicBeta;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers() };
  });
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages, endpoints: { messages: {} } }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
  assertEquals(anthropicBeta, []);
});

test('generate injects the platform external-image loader into Chat-to-Anthropic-Messages translation', async () => {
  installRepo();
  initExternalResourceFetcher(url => {
    assertEquals(url.href, 'https://example.com/image.png');
    return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }));
  });
  let observedBody: Omit<AnthropicMessagesPayload, 'model'> | undefined;
  const callAnthropicMessages = vi.fn(async (_model, body): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    observedBody = body as Omit<AnthropicMessagesPayload, 'model'>;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers() };
  });
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
      }],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages, endpoints: { messages: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  const message = observedBody?.messages[0];
  assert(message?.role === 'user' && Array.isArray(message.content));
  const image = message.content.find(block => block.type === 'image');
  assert(image?.type === 'image');
  assertEquals(image.source, { type: 'base64', media_type: 'image/png', data: 'AQID' });
});

test('generate translates through the OpenAI Responses target when only that endpoint is exposed', async () => {
  installRepo();
  const respResp: OpenAIResponsesResult = {
    id: 'resp_x', object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }],
    }],
    output_text: 'hi', error: null, incomplete_details: null,
  };
  const callOpenAIResponses = vi.fn(async (): Promise<ProviderOpenAIResponsesResult> => ({
    action: 'generate', ok: true,
    events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: respResp }]),
    modelKey: 'k',
    headers: new Headers(),
  }));
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIResponses, endpoints: { responses: {} } }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
});

test('generate preserves translated instructions before rewriting inline system messages', async () => {
  installRepo();
  const observedBodies: Omit<OpenAIResponsesPayload, 'model'>[] = [];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<OpenAIResponsesPayload, 'model'>);
    return {
      action: 'generate',
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed', sequence_number: 0, response: {
          id: 'resp_x', object: 'response', model: 'test-model', status: 'completed',
          output: [], output_text: '', error: null, incomplete_details: null,
        },
      }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });

  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'system', content: 'base instructions' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callOpenAIResponses,
      endpoints: { responses: {} },
      enabledFlags: new Set<FlagId>(['rewrite-system-to-developer']),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed OpenAI Responses body');
  assertEquals(observedBody.instructions, 'base instructions');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected OpenAI Responses input array');
  assertEquals(input[0], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[1], { type: 'message', role: 'developer', content: 'inline instructions' });
});

test('generate propagates upstream response headers onto the EventResult so respond can forward them', async () => {
  installRepo();
  const upstreamHeaders = new Headers({
    'anthropic-ratelimit-unified-status': 'allowed',
    'cf-ray': 'cf_ray_cc',
  });
  const callOpenAIChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions }),
    headers: new Headers(),
  });
  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('cf-ray'), 'cf_ray_cc');
  await collectEvents(result.events);
});
