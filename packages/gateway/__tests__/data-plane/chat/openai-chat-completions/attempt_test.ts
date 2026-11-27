import { expect, test, vi } from 'vitest';

import { openaiChatCompletionsAttempt } from '../../../../src/data-plane/chat/openai-chat-completions/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsPayloadEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubUpstream, stubUpstreamModel } from '@floway-dev/test-utils';
import { decodeResponseBody, type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type UpstreamOpenAIResponsesResult, type UpstreamStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/upstream';
import type { FlagId } from '@floway-dev/upstream/flags';

const API_KEY_ID = 'key_chat_completions_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<OpenAIChatCompletionsPayloadEx> = {}): OpenAIChatCompletionsPayloadEx => ({
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeOpenAIChatCompletionsEvents = (): readonly OpenAIChatCompletionsStreamEvent[] => [
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: { content: 'hi' }, finish_reason: null }],
  },
  {
    id: 'chatcmpl_test', object: 'chat.completion.chunk', created: 0, model: 'test-model',
    choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
  },
];

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEventEx[] => [
  {
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null,
      id: 'msg_cc_via_m', type: 'message', role: 'assistant', content: [],
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

const makeProtocolFrames = async function* <TEvent>(events: readonly TEvent[]): AsyncGenerator<ProtocolFrame<TEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  endpoints?: ModelEndpoints;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamOpenAIResponsesResult>;
  callGeminiGenerateContent?: (model: unknown, body: GeminiGenerateContentPayload, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<UpstreamStreamResult<GeminiGenerateContentStreamEvent>>;
  enabledFlags?: ReadonlySet<FlagId>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
  const instance = stubUpstream({
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessages: overrides.callAnthropicMessages,
    callOpenAIResponses: overrides.callOpenAIResponses,
    callGeminiGenerateContent: overrides.callGeminiGenerateContent,
  });
  return {
    upstream: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      instance,
    },
    model: stubUpstreamModel({ endpoints, enabledFlags: new Set<FlagId>(overrides.enabledFlags ?? []) }),
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

test('generate native target applies role compatibility flags in target-chain order', async () => {
  installRepo();
  let observedBody: Omit<OpenAIChatCompletionsPayloadEx, 'model'> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (_model, body): Promise<UpstreamStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    observedBody = body as Omit<OpenAIChatCompletionsPayloadEx, 'model'>;
    return {
      ok: true,
      events: makeProtocolFrames(makeOpenAIChatCompletionsEvents()),
      modelKey: 'k',
      http: { status: 200, headers: new Headers() },
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
      endpoints: { openaiChatCompletions: {} },
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
  const callAnthropicMessages = vi.fn(async (_model, _body, _signal, opts): Promise<UpstreamStreamResult<AnthropicMessagesStreamEventEx>> => {
    anthropicBeta = opts?.anthropicBeta;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', http: { status: 200, headers: new Headers() } };
  });
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages, endpoints: { anthropicMessages: {} } }),
    headers: new Headers({ 'anthropic-beta': 'must-not-cross-source-protocols' }),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(anthropicBeta, []);
});

test('generate preserves translated instructions before rewriting inline system messages', async () => {
  installRepo();
  const observedBodies: Omit<OpenAIResponsesPayloadEx, 'model'>[] = [];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<UpstreamOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<OpenAIResponsesPayloadEx, 'model'>);
    return {
      action: 'generate',
      ok: true,
      events: makeProtocolFrames([{
        type: 'response.completed', sequence_number: 0, response: {
          id: 'resp_x', object: 'response', model: 'test-model', status: 'completed',
          output: [], error: null, incomplete_details: null,
        },
      }]),
      modelKey: 'k',
      http: { status: 200, headers: new Headers() },
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
      endpoints: { openaiResponses: {} },
      enabledFlags: new Set<FlagId>(['rewrite-system-to-developer']),
    }),
    headers: new Headers(),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed OpenAI Responses body');
  assertEquals('instructions' in observedBody, false);
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected OpenAI Responses input array');
  assertEquals(input[0], { type: 'message', role: 'developer', content: 'base instructions' });
  assertEquals(input[1], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[2], { type: 'message', role: 'developer', content: 'inline instructions' });
});

test('generate translates through GenerateContent, strips model, and preserves relay HTTP error semantics', async () => {
  installRepo();
  let capturedBody: GeminiGenerateContentPayload | undefined;
  const result = await openaiChatCompletionsAttempt.generate({
    payload: makePayload({ reasoning_effort: 'high', messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Say hello' }] }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContent: async (_model, body) => {
        capturedBody = body;
        return {
          ok: true,
          modelKey: 'k',
          http: { status: 200, headers: new Headers() },
          events: makeProtocolFrames<GeminiGenerateContentStreamEvent>([{
            responseId: 'gem_chat_1',
            modelVersion: 'test-model',
            candidates: [{
              index: 0,
              content: { role: 'model', parts: [{ thought: true, text: 'Reason.' }, { text: 'Hello!' }] },
              finishReason: 'STOP',
            }],
          }]),
        };
      },
    }),
    headers: new Headers(),
  });
  expect(capturedBody).toBeDefined();
  expect('model' in capturedBody!).toBe(false);
  expect(result.type).toBe('events');
  if (result.type !== 'events') throw new Error('unreachable');
  const assembled = await collectOpenAIChatCompletionsProtocolEventsToResult(result.events);
  expect(assembled.choices[0]?.message.content).toBe('Hello!');
  expect(assembled.choices[0]?.message.reasoning_text).toBe('Reason.');

  const relayErr = await openaiChatCompletionsAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      endpoints: { geminiGenerateContent: {} },
      callGeminiGenerateContent: async () => ({
        ok: false,
        modelKey: 'k',
        http: new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'too long' } }), {
          status: 422,
          headers: new Headers({ 'content-type': 'application/json' }),
        }),
      }),
    }),
    headers: new Headers(),
  });
  expect(relayErr.type).toBe('api-error');
  if (relayErr.type !== 'api-error') throw new Error('unreachable');
  expect(relayErr.http.status).toBe(422);
  expect(JSON.parse(decodeResponseBody(relayErr.body))).toEqual({
    error: { code: 'context_length_exceeded', message: 'too long' },
  });
});
