import { test, vi } from 'vitest';

import { anthropicMessagesAttempt } from '../../../../src/data-plane/chat/anthropic-messages/attempt.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesClientTool, AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ModelEndpoints, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesPayload, OpenAIResponsesResult } from '@floway-dev/protocols/openai-responses';
import { type AnthropicMessagesUpstreamCallOptions, type ModelCandidate, directFetcher, type ProviderCallResult, type ProviderOpenAIResponsesResult, type ProviderStreamResult, type OpenAIResponsesAction, type UpstreamCallOptions } from '@floway-dev/provider';
import type { FlagId } from '@floway-dev/provider/flags';
import { assertEquals, assertExists, stubProvider, stubInternalModel, stubProviderModel } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_attempt_test';

const makeGatewayCtx = () => mockChatGatewayCtx({ apiKeyId: API_KEY_ID, wantsStream: true });

const makePayload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const makeAnthropicMessagesEvents = (): readonly AnthropicMessagesStreamEvent[] => [
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
  callAnthropicMessages?: (model: unknown, body: unknown, signal?: AbortSignal, opts?: AnthropicMessagesUpstreamCallOptions) => Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>>;
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

test('generate native messages target calls provider.callAnthropicMessages with no rewrite', async () => {
  installRepo();
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers(),
  }));
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
});

test('generate carries anthropic-beta through the Anthropic Messages boundary outside the provider allowlist', async () => {
  installRepo();
  let upstreamHeaders: Headers | undefined;
  let upstreamAnthropicBeta: readonly string[] | undefined;
  const callAnthropicMessages = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    upstreamHeaders = opts?.headers;
    upstreamAnthropicBeta = opts?.anthropicBeta;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers() };
  });

  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages }),
    headers: new Headers({
      'anthropic-beta': 'must-not-enter-ordinary-headers',
      'x-unlisted': 'discard',
    }),
    anthropicBeta: ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20'],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertExists(upstreamHeaders);
  assertEquals(Object.fromEntries(upstreamHeaders), {});
  assertEquals(upstreamAnthropicBeta, ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20']);
});

test('generate translate-to-responses branch routes through openaiResponsesAttempt', async () => {
  installRepo();
  let upstreamHeaders: Headers | undefined;
  const respResp: OpenAIResponsesResult = {
    id: 'resp_x', object: 'response', model: 'test-model', status: 'completed',
    output: [{
      type: 'message', id: 'msg_resp', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }],
    }],
    output_text: 'hi', error: null, incomplete_details: null,
  };
  const callOpenAIResponses = vi.fn(async (_model, _body, _action, _signal, opts): Promise<ProviderOpenAIResponsesResult> => {
    upstreamHeaders = opts?.headers;
    return {
      action: 'generate', ok: true,
      events: makeProtocolFrames([{ type: 'response.completed', sequence_number: 0, response: respResp }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIResponses, endpoints: { openaiResponses: {} } }),
    headers: new Headers({ 'anthropic-beta': 'must-not-enter-ordinary-headers' }),
    anthropicBeta: ['context-1m-2025-08-07'],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
  assertEquals(upstreamHeaders?.has('anthropic-beta'), false);
});

test('generate does not carry Anthropic Messages beta metadata through translation to OpenAI Chat Completions', async () => {
  installRepo();
  let upstreamHeaders: Headers | undefined;
  const callOpenAIChatCompletions = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    upstreamHeaders = opts?.headers;
    return {
      ok: true,
      events: makeProtocolFrames([{
        id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });

  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions, endpoints: { openaiChatCompletions: {} } }),
    headers: new Headers({ 'anthropic-beta': 'must-not-enter-ordinary-headers' }),
    anthropicBeta: ['context-1m-2025-08-07'],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(upstreamHeaders?.has('anthropic-beta'), false);
});

test('Anthropic inline tool additions reach a Chat upstream through the stable dispatcher', async () => {
  installRepo();
  let upstreamBody: Record<string, unknown> | undefined;
  const callOpenAIChatCompletions = vi.fn(async (_model, body): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    upstreamBody = body as Record<string, unknown>;
    return {
      ok: true,
      events: makeProtocolFrames([{
        id: 'chatcmpl_dynamic', object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }]),
      modelKey: 'k',
      headers: new Headers(),
    };
  });
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'user', content: 'Look up this customer.' },
        {
          role: 'system', content: [{
            type: 'tool_addition', tool: {
              type: 'tool_definition', definition: {
                name: 'lookup_customer', description: 'Look up a customer.', input_schema: { type: 'object', properties: { id: { type: 'string' } } },
              },
            },
          }],
        },
        { role: 'user', content: 'Use the new tool.' },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions, endpoints: { openaiChatCompletions: {} } }),
    headers: new Headers(),
    anthropicBeta: ['inline-tools-2026-09-15'],
  });
  if (result.type !== 'events') throw new Error('Expected events');
  await collectEvents(result.events);
  assertExists(upstreamBody);
  const tools = upstreamBody.tools as Array<{ function: { name: string } }>;
  assertEquals(tools.map(tool => tool.function.name), ['call_additional_tool']);
  const messages = upstreamBody.messages as Array<{ role: string; content: string }>;
  assertEquals(messages.map(message => message.role), ['user', 'system', 'user']);
  assertEquals(messages[1].content.includes('lookup_customer'), true);
});

test('Anthropic sees the real dynamic tool while Chat history replays the dispatcher', async () => {
  installRepo();
  const calls: Array<Record<string, unknown>> = [];
  const callOpenAIChatCompletions = vi.fn(async (_model, body): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    calls.push(body as Record<string, unknown>);
    return {
      ok: true,
      events: makeProtocolFrames(calls.length === 1
        ? [{
            id: 'chatcmpl_tool', object: 'chat.completion.chunk', created: 1, model: 'test-model',
            choices: [{
              index: 0, delta: {
                tool_calls: [{
                  index: 0, id: 'call_lookup', type: 'function', function: {
                    name: 'call_additional_tool', arguments: '{"handle":"tool/function//lookup_customer","arguments":{"id":"42"}}',
                  },
                }],
              }, finish_reason: 'tool_calls',
            }],
          }]
        : [{
            id: 'chatcmpl_done', object: 'chat.completion.chunk', created: 1, model: 'test-model',
            choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
          }]),
      modelKey: 'k', headers: new Headers(),
    };
  });
  const addition = {
    role: 'system' as const, content: [{
      type: 'tool_addition' as const, tool: {
        type: 'tool_definition' as const, definition: {
          name: 'lookup_customer', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        },
      },
    }],
  };
  const candidate = makeCandidate({ callOpenAIChatCompletions, endpoints: { openaiChatCompletions: {} } });
  const first = await anthropicMessagesAttempt.generate({
    payload: makePayload({ messages: [{ role: 'user', content: 'Look up customer 42.' }, addition] }),
    ctx: makeGatewayCtx(), candidate, headers: new Headers(), anthropicBeta: [],
  });
  if (first.type !== 'events') throw new Error('Expected events');
  const firstEvents = await collectEvents(first.events);
  const toolStart = firstEvents.find(event => event.type === 'content_block_start' && event.content_block.type === 'tool_use');
  if (toolStart?.type !== 'content_block_start' || toolStart.content_block.type !== 'tool_use') throw new Error('Expected real tool use');
  assertEquals(toolStart.content_block.name, 'lookup_customer');
  assertEquals(toolStart.content_block.id, 'call_lookup');
  assertEquals(JSON.stringify(firstEvents).includes('call_additional_tool'), false);

  const second = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'user', content: 'Look up customer 42.' }, addition,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_lookup', name: 'lookup_customer', input: { id: '42' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_lookup', content: 'Ada' }] },
      ],
    }),
    ctx: makeGatewayCtx(), candidate, headers: new Headers(), anthropicBeta: [],
  });
  if (second.type !== 'events') throw new Error('Expected events');
  await collectEvents(second.events);
  const messages = calls[1].messages as Array<{ role: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
  const replayed = messages.find(message => message.tool_calls?.length);
  assertExists(replayed?.tool_calls);
  assertEquals(replayed.tool_calls[0].function.name, 'call_additional_tool');
  assertEquals(JSON.parse(replayed.tool_calls[0].function.arguments), {
    handle: 'tool/function//lookup_customer', arguments: { id: '42' },
  });
});

test('the dynamic tool flag routes a native Anthropic target through the dispatcher once', async () => {
  installRepo();
  let upstreamBody: AnthropicMessagesPayload | undefined;
  const callAnthropicMessages = vi.fn(async (_model, body): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => {
    upstreamBody = body as AnthropicMessagesPayload;
    return { ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: new Headers() };
  });
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      messages: [
        { role: 'user', content: 'Use the added tool.' },
        {
          role: 'system', content: [{
            type: 'tool_addition', tool: {
              type: 'tool_definition', definition: {
                name: 'lookup_customer', input_schema: { type: 'object' },
              },
            },
          }],
        },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages, endpoints: { openaiResponses: {}, anthropicMessages: {} }, enabledFlags: new Set(['dynamic-tool-shim']) }),
    headers: new Headers(), anthropicBeta: [],
  });
  if (result.type !== 'events') throw new Error('Expected events');
  await collectEvents(result.events);
  assertEquals(callAnthropicMessages.mock.calls.length, 1);
  assertExists(upstreamBody);
  assertEquals(upstreamBody.tools?.map(tool => tool.name), ['call_additional_tool']);
  assertEquals(upstreamBody.messages.map(message => message.role), ['user', 'system']);
  assertEquals(JSON.stringify(upstreamBody.messages).includes('tool_addition'), false);
});

test('Anthropic hosted tool search loads a deferred tool and continues on a Chat upstream', async () => {
  installRepo();
  const upstreamBodies: Array<Record<string, unknown>> = [];
  const callOpenAIChatCompletions = vi.fn(async (_model, body): Promise<ProviderStreamResult<OpenAIChatCompletionsStreamEvent>> => {
    upstreamBodies.push(body as Record<string, unknown>);
    const search = upstreamBodies.length === 1;
    const toolName = search ? 'search_additional_tools' : 'call_additional_tool';
    const args = search
      ? '{"paths":["lookup_customer"]}'
      : '{"handle":"tool/function//lookup_customer","arguments":{"id":"42"}}';
    return {
      ok: true,
      events: makeProtocolFrames([{
        id: `chatcmpl_search_${upstreamBodies.length}`, object: 'chat.completion.chunk', created: 1, model: 'test-model',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${upstreamBodies.length}`, type: 'function', function: { name: toolName, arguments: args } }] }, finish_reason: 'tool_calls' }],
      }]),
      modelKey: 'k', headers: new Headers(),
    };
  });
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      messages: [{ role: 'user', content: 'Find the customer tool and look up customer 42.' }],
      tools: [
        { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
        {
          name: 'lookup_customer', description: 'Look up customer by ID.', defer_loading: true, input_schema: {
            type: 'object', properties: { id: { type: 'string' } }, required: ['id'],
          },
        },
      ],
    }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callOpenAIChatCompletions, endpoints: { openaiChatCompletions: {} } }),
    headers: new Headers(), anthropicBeta: [],
  });
  if (result.type !== 'events') throw new Error('Expected events');
  const events = await collectEvents(result.events);
  assertEquals(upstreamBodies.length, 2);
  const firstTools = upstreamBodies[0].tools as Array<{ function: { name: string } }>;
  const secondTools = upstreamBodies[1].tools as Array<{ function: { name: string } }>;
  assertEquals(firstTools.map(tool => tool.function.name), ['search_additional_tools', 'call_additional_tool']);
  assertEquals(secondTools, firstTools);
  const blocks = events.filter(event => event.type === 'content_block_start').map(event => event.content_block);
  assertEquals(blocks.map(block => block.type), ['server_tool_use', 'tool_search_tool_result', 'tool_use']);
  const invoked = blocks.at(-1);
  if (invoked?.type !== 'tool_use') throw new Error('Expected client tool use');
  assertEquals(invoked.name, 'lookup_customer');
});

test('generate lets the target system-to-developer rewrite take precedence over the source system-to-user rewrite', async () => {
  installRepo();
  const observedBodies: Omit<OpenAIResponsesPayload, 'model'>[] = [];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<OpenAIResponsesPayload, 'model'>);
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
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed OpenAI Responses body');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected OpenAI Responses input array');
  assertEquals(input[0], { type: 'message', role: 'user', content: 'hello' });
  assertEquals(input[1], { type: 'message', role: 'developer', content: 'inline instructions' });
});

test('generate translate-to-responses branch rewrites a multi-block system prefix to developer', async () => {
  installRepo();
  const observedBodies: Omit<OpenAIResponsesPayload, 'model'>[] = [];
  const callOpenAIResponses = vi.fn(async (_model, body): Promise<ProviderOpenAIResponsesResult> => {
    observedBodies.push(body as Omit<OpenAIResponsesPayload, 'model'>);
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

  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload({
      system: [{ type: 'text', text: 'base A' }, { type: 'text', text: 'base B' }],
      messages: [
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
    anthropicBeta: [],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  await collectEvents(result.events);
  assertEquals(callOpenAIResponses.mock.calls.length, 1);
  const observedBody = observedBodies[0];
  if (!observedBody) throw new Error('expected observed OpenAI Responses body');
  const input = observedBody.input;
  if (!Array.isArray(input)) throw new Error('expected OpenAI Responses input array');
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
  const callAnthropicMessagesCountTokens = vi.fn(async (): Promise<ProviderCallResult> => ({
    response: new Response(JSON.stringify({ input_tokens: 7 }), { status: 200, headers: new Headers({ 'content-type': 'application/json' }) }),
    modelKey: 'k',
  }));

  const result = await anthropicMessagesAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessagesCountTokens }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  assertEquals(result.type, 'plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  assertEquals(result.status, 200);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.input_tokens, 7);
  assertEquals(callAnthropicMessagesCountTokens.mock.calls.length, 1);
});

test('countTokens carries anthropic-beta through the Anthropic Messages boundary outside the provider allowlist', async () => {
  installRepo();
  let upstreamHeaders: Headers | undefined;
  let upstreamAnthropicBeta: readonly string[] | undefined;
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, _body, _signal, opts): Promise<ProviderCallResult> => {
    upstreamHeaders = opts?.headers;
    upstreamAnthropicBeta = opts?.anthropicBeta;
    return { response: Response.json({ input_tokens: 7 }), modelKey: 'k' };
  });

  await anthropicMessagesAttempt.countTokens({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessagesCountTokens }),
    headers: new Headers({
      'anthropic-beta': 'must-not-enter-ordinary-headers',
      'x-unlisted': 'discard',
    }),
    anthropicBeta: ['context-1m-2025-08-07'],
  });

  assertExists(upstreamHeaders);
  assertEquals(Object.fromEntries(upstreamHeaders), {});
  assertEquals(upstreamAnthropicBeta, ['context-1m-2025-08-07']);
});

test('countTokens applies generation request transforms before provider dispatch', async () => {
  installRepo();
  const observedBodies: Array<Omit<AnthropicMessagesPayload, 'model'>> = [];
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    observedBodies.push(body as Omit<AnthropicMessagesPayload, 'model'>);
    return { response: Response.json({ input_tokens: 9 }), modelKey: 'k' };
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

test('countTokens prepares the generation web-search request shape', async () => {
  installRepo();
  const observedBodies: Array<Omit<AnthropicMessagesPayload, 'model'>> = [];
  const callAnthropicMessagesCountTokens = vi.fn(async (_model, body): Promise<ProviderCallResult> => {
    observedBodies.push(body as Omit<AnthropicMessagesPayload, 'model'>);
    return { response: Response.json({ input_tokens: 11 }), modelKey: 'k' };
  });

  const result = await anthropicMessagesAttempt.countTokens({
    payload: makePayload({ tools: [{ type: 'web_search_20260209', max_uses: 3 }] }),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({
      callAnthropicMessagesCountTokens,
      enabledFlags: new Set<FlagId>(['anthropic-messages-web-search-shim']),
    }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  assertEquals(result.type, 'plain');
  const tool = observedBodies[0]?.tools?.[0] as AnthropicMessagesClientTool | undefined;
  if (tool === undefined) throw new Error('expected rewritten web-search tool');
  assertEquals(tool.name, 'web_search');
  assertEquals('type' in tool, false);
  assertEquals(tool.input_schema, {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  });
});

test('countTokens refuses a non-anthropic-messages candidate', async () => {
  installRepo();
  let thrown: unknown = null;
  try {
    await anthropicMessagesAttempt.countTokens({
      payload: makePayload(),
      ctx: makeGatewayCtx(),
      candidate: makeCandidate({ endpoints: { openaiResponses: {} } }),
      headers: new Headers(),
      anthropicBeta: [],
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
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'gpt-test', headers: new Headers(),
  }));

  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx,
    candidate: makeCandidate({ upstream: 'up_perf', callAnthropicMessages }),
    headers: new Headers(),
    anthropicBeta: [],
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
  const callAnthropicMessages = vi.fn(async (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> => ({
    ok: true, events: makeProtocolFrames(makeAnthropicMessagesEvents()), modelKey: 'k', headers: upstreamHeaders,
  }));
  const result = await anthropicMessagesAttempt.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    candidate: makeCandidate({ callAnthropicMessages }),
    headers: new Headers(),
    anthropicBeta: [],
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  assertEquals(result.headers?.get('anthropic-ratelimit-unified-status'), 'allowed');
  assertEquals(result.headers?.get('request-id'), 'req_messages_xyz');
  await collectEvents(result.events);
});
