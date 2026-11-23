import { expect, test, vi } from 'vitest';

import { http, providerResponses, responsesFixture, unusedBody, upstream } from './fixture.ts';
import { createAnthropicMessagesBody } from '../../../../src/data-plane/chat/anthropic-messages/body.ts';
import { anthropicMessagesEgress } from '../../../../src/data-plane/chat/anthropic-messages/egress.ts';
import { createOpenAIChatCompletionsBody } from '../../../../src/data-plane/chat/openai-chat-completions/body.ts';
import { openaiChatCompletionsEgress } from '../../../../src/data-plane/chat/openai-chat-completions/egress.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { readHttpBytes } from '../../../../src/data-plane/pipeline/non-chat.ts';
import { encodeBase64UrlJson } from '../../../../src/shared/base64url-json.ts';
import { generateProvider } from '../anthropic-messages/fixture.ts';
import { compose, defineEnding, type StageEnv } from '@floway-dev/pipeline';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProviderInput, ProviderResponsesInput, ProviderResponsesOutput, ProviderStreamOutput } from '@floway-dev/provider';

const chatCompletions = createOpenAIChatCompletionsBody({
  egress: openaiChatCompletionsEgress,
  messages: unusedBody('anthropicMessages'),
  responses: unusedBody('openaiResponses'),
});
const messages = createAnthropicMessagesBody({
  egress: anthropicMessagesEgress,
  responses: unusedBody('openaiResponses'),
  chatCompletions: unusedBody('openaiChatCompletions'),
});
type ChatInput = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type ChatOutput = ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>;

const textChunks = async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const base = { id: 'chat_test', object: 'chat.completion.chunk' as const, model: 'test-model', created: 0 };
  yield eventFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] });
  yield eventFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  yield doneFrame();
};

const chatProvider = (respond: (facts: ChatInput, env: StageEnv) => AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) =>
  compose<ChatInput, ChatOutput, {}>('test.chat-completions', {
    stages: [],
    ending: defineEnding<ChatInput, ChatOutput>({
      name: 'stubChatCompletions',
      request: { needs: ['provider.model', 'request.headers', 'request.payload'] },
      return: { provides: ['response.http', 'response.modelKey', 'response.events'] },
      execute: async (facts, _into, env) => ({
        ...http(),
        'response.modelKey': 'native-chat',
        'response.events': env.createStream({ label: 'stub Chat Completions events', iterate: () => respond(facts, env) }),
      }),
    }),
  });

const chatFixture = (
  respond: (facts: ChatInput, env: StageEnv) => AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  flags: readonly FlagId[] = [],
) => {
  const target = upstream('chat', { openaiChatCompletions: chatProvider(respond) }, flags);
  const endpoints = { openaiChatCompletions: {} };
  return responsesFixture([{
    ...target,
    candidate: { ...target.candidate, endpoints, providerModel: { ...target.candidate.providerModel, endpoints } },
  }], undefined, { chatCompletions });
};

const completed = (env: StageEnv): ProviderResponsesOutput => ({
  ...http(),
  'response.result': undefined,
  'response.modelKey': 'native-responses',
  'response.events': env.createStream({
    label: 'native Responses events',
    iterate: () => syntheticEventsFromResult({
      id: 'resp_upstream', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null,
    }),
  }),
});

test('native provider request facts preserve own JSON property names and freeze nested data', async () => {
  const metadata = JSON.parse('{"__proto__":{"retained":true},"nested":{"value":"source"}}') as Record<string, string>;
  const source = { model: 'test-model', input: [{ type: 'message' as const, role: 'user' as const, content: 'hello' }], metadata };
  const respond = vi.fn((facts: ProviderResponsesInput, env: StageEnv) => {
    const body = facts['request.payload'];
    expect(Object.hasOwn(body.metadata ?? {}, '__proto__')).toBe(true);
    expect(Object.isFrozen(body.metadata?.nested)).toBe(true);
    expect(Object.isFrozen(body.input[0])).toBe(true);
    return completed(env);
  });
  const fixture = responsesFixture([upstream('responses', { openaiResponses: providerResponses(respond) })]);
  const handle = fixture.request(source);
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(respond).toHaveBeenCalledTimes(1);
  expect(source.metadata.nested).toEqual({ value: 'source' });
  expect(source.input[0].role).toBe('user');
});

test('a translated source reaches the Responses body without opening storage or unwrapping native affinity', async () => {
  const respond = vi.fn((_facts: ProviderResponsesInput, env: StageEnv) => completed(env));
  const openStore = vi.fn(() => { throw new Error('Unexpected durable store access from a foreign source'); });
  const target = upstream('responses', { openaiResponses: providerResponses(respond) });
  const fixture = responsesFixture([target], openStore);
  const codec = fixture.services.affinityCodec;
  const carrier = await codec.wrap(undefined, {
    upstreamId: target.candidate.upstreamId, modelId: target.candidate.modelId,
    opaqueBlobCompatibilityIdentity: { upstreamId: target.candidate.upstreamId, key: target.candidate.modelId },
  }, 'openai-responses.reasoning.encrypted_content');
  const unwrap = vi.spyOn(codec, 'unwrap');
  const input = [{ type: 'reasoning' as const, id: 'rs_source_edge', summary: [], encrypted_content: carrier }];
  const handle = fixture.invokeBody({ model: 'test-model', input }, target.candidate);
  const events = (await handle.result)['response.openaiResponses'];
  if (events === undefined) throw new Error('Expected Responses events');
  for await (const event of events) void event;
  expect(await handle.done).toEqual({ ok: true });
  expect(openStore).toHaveBeenCalledTimes(0);
  expect(unwrap).toHaveBeenCalledTimes(0);
  expect(respond.mock.calls[0]?.[0]['request.payload'].input).toEqual(input);
});

test('the role rewrite applies on the Chat Completions wire after translation', async () => {
  const respond = vi.fn((_facts: ChatInput) => textChunks());
  const fixture = chatFixture(respond, ['rewrite-system-to-developer']);
  const handle = fixture.request({
    model: 'test-model',
    input: [
      { type: 'message', role: 'system', content: 'base instructions' },
      { type: 'message', role: 'user', content: 'hello' },
      { type: 'message', role: 'system', content: 'inline instructions' },
    ],
  });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(respond.mock.calls[0]?.[0]['request.payload'].messages).toEqual([
    { role: 'developer', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'inline instructions' },
  ]);
});

test('translation to Anthropic Messages filters source headers and keeps a remote image URL', async () => {
  initExternalResourceFetcher(() => { throw new Error('Unexpected download of an Anthropic URL image'); });
  const captured: Parameters<NonNullable<Parameters<typeof generateProvider>[0]>>[0][] = [];
  const target = upstream('messages', {
    anthropicMessages: generateProvider((facts, env) => {
      captured.push(facts);
      return {
        ...http(),
        'response.modelKey': 'messages',
        'response.events': env.createStream({
          label: 'stub Messages events',
          async *iterate() {
            yield eventFrame({
              type: 'message_start',
              message: {
                type: 'message', role: 'assistant', id: 'msg_1', model: 'test-model', content: [], stop_reason: null, stop_sequence: null,
                container: null, diagnostics: null, stop_details: null,
                usage: {
                  input_tokens: 1, output_tokens: 0, cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null,
                  inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null,
                },
              },
            });
            yield eventFrame({ type: 'message_stop' });
          },
        }),
      };
    }),
  });
  const endpoints = { anthropicMessages: {} };
  const fixture = responsesFixture([{
    ...target,
    candidate: { ...target.candidate, endpoints, providerModel: { ...target.candidate.providerModel, endpoints } },
  }], undefined, { messages });
  const handle = fixture.request({
    model: 'test-model',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }] }],
  }, 'generate', [['anthropic-beta', 'source-only'], ['x-test', 'abc']]);
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(captured[0]?.['request.headers']).toEqual([]);
  expect(captured[0]?.['request.anthropicBeta']).toEqual([]);
  expect(captured[0]?.['request.payload'].messages).toEqual([expect.objectContaining({
    role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } })]),
  })]);
});

test('Responses restores signed hosted-tool replay data without durable state', async () => {
  const respond = vi.fn((_facts: ProviderResponsesInput, env: StageEnv) => completed(env));
  const target = upstream('responses', { openaiResponses: providerResponses(respond) }, ['openai-responses-web-search-shim']);
  const fixture = responsesFixture([target]);
  const action = { type: 'search' as const, query: 'example', queries: ['example'] };
  const replay = await fixture.services.sidecarCodecs.codecFor(SidecarDomain.OpenAIResponsesHostedToolCall).encode({
    v: 1, type: 'web_search_call',
    functionCall: { type: 'function_call', call_id: 'call_orig_xyz', name: 'web_search', arguments: '{"search_query":[{"q":"example"}]}', status: 'completed' },
    data: { action, results: [{ type: 'text_result', url: 'https://example.com', title: 'Example', snippet: 'CACHED_SNIPPET_BODY' }] },
  });
  const carrier = await fixture.services.affinityCodec.wrap(replay, {
    upstreamId: target.candidate.upstreamId, modelId: target.candidate.modelId,
    opaqueBlobCompatibilityIdentity: { upstreamId: target.candidate.upstreamId, key: target.candidate.modelId },
  }, 'openai-responses.reasoning.encrypted_content');
  const handle = fixture.request({
    model: 'test-model', store: false, tools: [{ type: 'web_search' }],
    input: [
      { type: 'message', role: 'user', content: 'follow-up' },
      { type: 'reasoning', id: 'rs_affinity', summary: [], encrypted_content: carrier },
      { type: 'web_search_call', id: 'ws_history', status: 'completed', action },
    ],
  });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(respond.mock.calls[0]?.[0]['request.payload'].input).toContainEqual(expect.objectContaining({
    type: 'function_call', call_id: 'call_orig_xyz', name: 'web_search', arguments: '{"search_query":[{"q":"example"}]}',
  }));
  expect(respond.mock.calls[0]?.[0]['request.payload'].input).toContainEqual(expect.objectContaining({
    type: 'function_call_output', call_id: 'call_orig_xyz', output: expect.stringContaining('CACHED_SNIPPET_BODY'),
  }));
});

test('namespace wire mapping follows compact expansion across independent dispatches', async () => {
  const namespace = {
    type: 'namespace' as const, name: 'files', description: '',
    tools: [{ type: 'function' as const, name: 'read', parameters: { type: 'object' } }],
  };
  const history = { type: 'function_call' as const, name: 'read', namespace: 'files', call_id: 'past', arguments: '{}', status: 'completed' as const };
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'test-model', tools: [{ type: 'function', name: 'files_read' }, namespace],
    input: [{ type: 'compaction', encrypted_content: encodeBase64UrlJson([history, { type: 'function_call_output', call_id: 'past', output: 'done' }]) }],
  };
  const original = structuredClone(payload);
  const respond = vi.fn(async function* (_facts: ChatInput): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
    const base = { id: 'chat_isolation', object: 'chat.completion.chunk' as const, model: 'test-model', created: 0 };
    yield eventFrame({
      ...base, choices: [{
        index: 0, finish_reason: null,
        delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'next', type: 'function', function: { name: 'files_read_2', arguments: '{}' } }] },
      }],
    });
    yield eventFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    yield doneFrame();
  });
  const fixture = chatFixture(respond);
  for (const _ of [1, 2]) {
    const handle = fixture.request(payload);
    const response = (await handle.result)['response.http'];
    expect(response.status).toBe(200);
    const result = JSON.parse((await readHttpBytes(response.body)).utf8()) as OpenAIResponsesResultEx;
    expect(result.output).toContainEqual(expect.objectContaining({ type: 'function_call', name: 'read', namespace: 'files' }));
    expect(await handle.done).toEqual({ ok: true });
  }
  expect(respond.mock.calls).toHaveLength(2);
  const body = respond.mock.calls[0]?.[0]['request.payload'];
  expect(JSON.stringify(body?.messages)).toContain('files_read_2');
  expect(respond.mock.calls[1]?.[0]['request.payload']).toEqual(body);
  expect(payload).toEqual(original);
});

test('standalone function outputs become external user context before Chat Completions translation', async () => {
  const respond = vi.fn((_facts: ChatInput) => textChunks());
  const fixture = chatFixture(respond);
  const handle = fixture.request({
    model: 'test-model', tools: [{ type: 'function', name: 'create_goal', parameters: { type: 'object' } }],
    input: [
      { type: 'message', role: 'user', content: 'Write unit tests' },
      { type: 'function_call', call_id: 'call_goal', name: 'create_goal', arguments: '{"objective":"Write unit tests"}' },
      { type: 'function_call_output', call_id: 'call_goal', output: '{"goal":{"status":"active"}}' },
      { type: 'function_call_output', id: 'fco_goal', name: 'goal_objective', namespace: 'agent', output: 'Write unit tests' },
    ],
  });
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(respond.mock.calls[0]?.[0]['request.payload'].messages).toEqual([
    { role: 'user', content: 'Write unit tests' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_goal', type: 'function', function: { name: 'create_goal', arguments: '{"objective":"Write unit tests"}' } }] },
    { role: 'tool', tool_call_id: 'call_goal', content: '{"goal":{"status":"active"}}' },
    { role: 'user', content: '<external_goal_objective>Write unit tests</external_goal_objective>' },
  ]);
});
