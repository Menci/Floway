import { expect, test, vi } from 'vitest';

import { readHttpBytes, readWireJson, responsesFixture, responsesUpstream, unusedBody, wireEvents, type WireRequest } from './fixture.ts';
import { createAnthropicMessagesBody } from '../../../../src/data-plane/chat/anthropic-messages/body.ts';
import { anthropicMessagesEgress } from '../../../../src/data-plane/chat/anthropic-messages/egress.ts';
import { createOpenAIChatCompletionsBody } from '../../../../src/data-plane/chat/openai-chat-completions/body.ts';
import { openaiChatCompletionsEgress } from '../../../../src/data-plane/chat/openai-chat-completions/egress.ts';
import { syntheticEventsFromResult } from '../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { SidecarDomain } from '../../../../src/data-plane/chat/shared/sidecar-codec.ts';
import { encodeBase64UrlJson } from '../../../../src/shared/base64url-json.ts';
import { chatUpstream } from '../shared/fixture.ts';
import { initExternalResourceFetcher } from '@floway-dev/platform';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';

const chatCompletions = createOpenAIChatCompletionsBody({
  egress: openaiChatCompletionsEgress,
  messages: unusedBody,
  responses: unusedBody,
});
const messages = createAnthropicMessagesBody({
  egress: anthropicMessagesEgress,
  responses: unusedBody,
  chatCompletions: unusedBody,
});
type ChatInput = OpenAIChatCompletionsPayloadEx;

const textChunks = async function* (): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const base = { id: 'chat_test', object: 'chat.completion.chunk' as const, model: 'test-model', created: 0 };
  yield eventFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] });
  yield eventFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  yield doneFrame();
};

const chatFixture = (
  respond: (payload: ChatInput) => AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  flags: readonly FlagId[] = [],
) => {
  const target = chatUpstream({
    upstreamId: 'chat', endpoints: { openaiChatCompletions: {} }, flags,
    fetcher: async (_url, init) => wireEvents(respond(await readWireJson(init.body))),
  });
  return responsesFixture([target], undefined, { chatCompletions });
};

const completed = (_request: WireRequest) => wireEvents(syntheticEventsFromResult({
  id: 'resp_upstream', object: 'response', model: 'test-model', status: 'completed', output: [], error: null, incomplete_details: null,
}));

test('native provider request facts preserve own JSON property names and freeze nested data', async () => {
  const metadata = JSON.parse('{"__proto__":{"retained":true},"nested":{"value":"source"}}') as Record<string, string>;
  const source = { model: 'test-model', input: [{ type: 'message' as const, role: 'user' as const, content: 'hello' }], metadata };
  const respond = vi.fn(completed);
  const fixture = responsesFixture([responsesUpstream('responses', respond)]);
  const handle = fixture.request(source);
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  const providerEntry = fixture.events.find(event => event.k === 'enter' && event.edge === 'into' && Object.hasOwn(event.facts, 'provider.upstream'));
  if (providerEntry?.k !== 'enter') throw new Error('Expected the native provider to receive request facts');
  const body = providerEntry.facts['request.payload'];
  expect(body).toMatchObject({ metadata: { nested: { value: 'source' } }, input: [expect.objectContaining({ type: 'message' })] });
  if (typeof body !== 'object' || body === null || !('metadata' in body) || !('input' in body)) throw new Error('Expected canonical payload facts');
  const { metadata: providerMetadata, input } = body;
  if (typeof providerMetadata !== 'object' || providerMetadata === null || !('nested' in providerMetadata) || !Array.isArray(input)) throw new Error('Expected nested payload facts');
  expect(Object.hasOwn(providerMetadata, '__proto__')).toBe(true);
  expect(Object.isFrozen(providerMetadata.nested)).toBe(true);
  expect(Object.isFrozen(input[0])).toBe(true);
  expect(respond).toHaveBeenCalledTimes(1);
  expect(source.metadata.nested).toEqual({ value: 'source' });
  expect(source.input[0].role).toBe('user');
});

test('a translated source reaches the Responses body without opening storage or unwrapping native affinity', async () => {
  const respond = vi.fn(completed);
  const openStore = vi.fn(() => { throw new Error('Unexpected durable store access from a foreign source'); });
  const target = responsesUpstream('responses', respond);
  const fixture = responsesFixture([target], openStore);
  const codec = fixture.services.affinityCodec;
  const carrier = await codec.wrap(undefined, {
    upstreamId: target.candidate.upstreamId, modelId: target.candidate.modelId,
    opaqueBlobCompatibilityIdentity: { upstreamId: target.candidate.upstreamId, key: target.candidate.modelId },
  }, 'openai-responses.reasoning.encrypted_content');
  const unwrap = vi.spyOn(codec, 'unwrap');
  const input = [{ type: 'reasoning' as const, id: 'rs_source_edge', summary: [], encrypted_content: carrier }];
  const handle = fixture.invokeBody({ model: 'test-model', input }, target.candidate);
  const outcome = (await handle.result)['response.openaiResponses'];
  if (outcome.kind !== 'stream') throw new Error('Expected Responses events');
  await Array.fromAsync(outcome.events);
  expect(await handle.done).toEqual({ ok: true });
  expect(openStore).toHaveBeenCalledTimes(0);
  expect(unwrap).toHaveBeenCalledTimes(0);
  expect(respond.mock.calls[0]?.[0].payload.input).toEqual(input);
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
  expect(respond.mock.calls[0]?.[0].messages).toEqual([
    { role: 'developer', content: 'base instructions' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: 'inline instructions' },
  ]);
});

test('translation to Anthropic Messages filters source headers and keeps a remote image URL', async () => {
  initExternalResourceFetcher(() => { throw new Error('Unexpected download of an Anthropic URL image'); });
  const captured: { headers: Headers; payload: { messages: unknown[] } }[] = [];
  const target = chatUpstream({
    upstreamId: 'messages', endpoints: { anthropicMessages: {} }, ingressHeadersRules: [],
    fetcher: async (_url, init) => {
      captured.push({ headers: new Headers(init.headers), payload: await readWireJson(init.body) });
      return wireEvents((async function* () {
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
      })());
    },
  });
  const fixture = responsesFixture([target], undefined, { messages });
  const handle = fixture.request({
    model: 'test-model',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/image.png', detail: 'auto' }] }],
  }, 'generate', [['anthropic-beta', 'source-only'], ['x-test', 'abc']]);
  expect((await handle.result)['response.http'].status).toBe(200);
  expect(await handle.done).toEqual({ ok: true });
  expect(captured[0]?.headers.has('x-test')).toBe(false);
  expect(captured[0]?.headers.has('anthropic-beta')).toBe(false);
  expect(captured[0]?.payload.messages).toEqual([expect.objectContaining({
    role: 'user', content: expect.arrayContaining([expect.objectContaining({ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } })]),
  })]);
});

test('Responses restores signed hosted-tool replay data without durable state', async () => {
  const respond = vi.fn(completed);
  const target = responsesUpstream('responses', respond, ['openai-responses-web-search-shim']);
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
  expect(respond.mock.calls[0]?.[0].payload.input).toContainEqual(expect.objectContaining({
    type: 'function_call', call_id: 'call_orig_xyz', name: 'web_search', arguments: '{"search_query":[{"q":"example"}]}',
  }));
  expect(respond.mock.calls[0]?.[0].payload.input).toContainEqual(expect.objectContaining({
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
  const body = respond.mock.calls[0]?.[0];
  expect(JSON.stringify(body?.messages)).toContain('files_read_2');
  expect(respond.mock.calls[1]?.[0]).toEqual(body);
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
  expect(respond.mock.calls[0]?.[0].messages).toEqual([
    { role: 'user', content: 'Write unit tests' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_goal', type: 'function', function: { name: 'create_goal', arguments: '{"objective":"Write unit tests"}' } }] },
    { role: 'tool', tool_call_id: 'call_goal', content: '{"goal":{"status":"active"}}' },
    { role: 'user', content: '<external_goal_objective>Write unit tests</external_goal_objective>' },
  ]);
});
