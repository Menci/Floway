import { test, vi } from 'vitest';

import { anthropicMessagesAttempt } from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayloadEx } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assertEquals, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEventEx[] => [
  {
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null,
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'test-model',
      stop_reason: null,
      stop_sequence: null,
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
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>>;
  callOpenAIResponses?: (model: unknown, body: unknown, action: OpenAIResponsesAction, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderOpenAIResponsesResult>;
  callOpenAIChatCompletions?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: UpstreamCallOptions) => Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>>;
  callAnthropicMessagesCountTokens?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderCallResult>;
  enabledFlags?: ReadonlySet<FlagId>;
} = {}): ModelCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const endpoints = overrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} };
  const provider = stubProvider({
    callAnthropicMessages: overrides.callAnthropicMessages,
    callOpenAIResponses: overrides.callOpenAIResponses,
    callOpenAIChatCompletions: overrides.callOpenAIChatCompletions,
    callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens,
  });
  return {
    provider: {
      upstreamId: upstream, kind: 'custom', name: upstream, inboundHeaderAllowlist: [],
      disabledPublicModelIds: [], modelPrefix: null, modelsCache: null, pipelines: {}, instance: provider,
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

test('generate and countTokens drop the Claude Code beta flag on candidates that strip billing attribution', async () => {
  installRepo();
  const upstreamAnthropicBeta: Array<readonly string[] | undefined> = [];
  const callAnthropicMessages = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEventEx>> => {
    upstreamAnthropicBeta.push(opts?.anthropicBeta);
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', http: { status: 200, headers: new Headers() } };
  });
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderCallResult> => {
    upstreamAnthropicBeta.push(opts?.anthropicBeta);
    return { http: Response.json({ input_tokens: 1 }), modelKey: 'k' };
  });
  const candidate = makeCandidate({ callAnthropicMessages, callAnthropicMessagesCountTokens, enabledFlags: new Set(['strip-billing-attribution']) });
  const anthropicBeta = ['claude-code-20250219', 'interleaved-thinking-2025-05-14'];

  const result = await anthropicMessagesAttempt.generate({ payload: makePayload(), ctx: makeGatewayCtx(), candidate, headers: new Headers(), anthropicBeta });
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  await anthropicMessagesAttempt.countTokens({ payload: makePayload(), ctx: makeGatewayCtx(), candidate, headers: new Headers(), anthropicBeta });

  assertEquals(upstreamAnthropicBeta, [['interleaved-thinking-2025-05-14'], ['interleaved-thinking-2025-05-14']]);
});

test('generate lets the target system-to-developer rewrite take precedence over the source system-to-user rewrite', async () => {
  installRepo();
  const observedBodies: Omit<OpenAIResponsesPayloadEx, 'model'>[] = [];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<OpenAIResponsesPayloadEx, 'model'>);
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
          error: null,
          incomplete_details: null,
        },
      }]),
      modelKey: 'k',
      http: { status: 200, headers: new Headers() },
    };
  });

  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline instructions' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callOpenAIResponses,
      endpoints: { openaiResponses: {} },
      enabledFlags: new Set<FlagId>([
        'rewrite-mid-conv-system-to-user',
        'rewrite-system-to-developer',
      ]),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed OpenAI Responses body');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected OpenAI Responses input array');
  assertEquals(input[0], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[1], { type: 'message', role: 'developer', content: 'inline instructions' });
});

test('countTokens applies generation request transforms before provider dispatch', async () => {
  installRepo();
  const observedBodies: Array<Omit<AnthropicMessagesPayload, 'model'>> = [];
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    observedBodies.push(body as Omit<AnthropicMessagesPayload, 'model'>);
    return { http: Response.json({ input_tokens: 9 }), modelKey: 'k' };
  });

  const result = await anthropicMessagesAttempt.countTokens({
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
      callAnthropicMessagesCountTokens,
      enabledFlags: new Set<FlagId>([
        'strip-billing-attribution',
        'disable-reasoning-on-forced-tool-choice',
        'rewrite-mid-conv-system-to-user',
      ]),
    }),
    headers: new Headers(),
    anthropicBeta: [],
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
