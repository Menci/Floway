import { expect, test } from 'vitest';

import { renderAnthropicMessagesPipelineResponse } from '../../../../src/data-plane/chat/anthropic-messages/respond.ts';
import { anthropicMessagesGeneratePipeline, type AnthropicMessagesServeFacts } from '../../../../src/data-plane/chat/anthropic-messages/serve-pipeline.ts';
import type { ChatAttemptOutcome, ChatPipelineServices } from '../../../../src/data-plane/chat/pipeline/index.ts';
import type { DownstreamHttpOutcome } from '../../../../src/data-plane/pipeline/index.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { mockChatPipelineServices, stubRouteCandidate, stubStreamProviderPipeline } from '../../../test-utils/chat-pipeline.ts';
import { pipeline, runPipeline, terminal } from '@floway-dev/pipeline';
import type { ManagedStream, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { createAnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { readManagedBytes, type ProviderPipelineAnthropicMessagesInput } from '@floway-dev/provider';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const brokenOutcome = (
  env: StageEnv<ChatPipelineServices>,
  failure: Error,
): Extract<ChatAttemptOutcome<AnthropicMessagesStreamEventEx>, { type: 'events' }> => ({
  type: 'events',
  events: env.createStream<ProtocolFrame<AnthropicMessagesStreamEventEx>>({
    label: 'anthropic-messages.broken.events',
    async *iterate() {
      yield* [];
      throw failure;
    },
  }),
  modelIdentity: testTelemetryModelIdentity,
});

test('anthropic-messages streaming failures preserve SSE transport shape and nested diagnostics', async () => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  const { services } = mockChatPipelineServices({ ctxOverrides: { wantsStream: true } });
  services.affinity.select(stubRouteCandidate());
  const pipe = pipeline<Record<never, never>>('respond.anthropic-messages.stream-fail')
    .end(terminal<Record<never, never>, DownstreamHttpOutcome, ChatPipelineServices>({
      name: 'respond.anthropic-messages.stream-fail.end',
      execute: async (_facts, env) => await renderAnthropicMessagesPipelineResponse(brokenOutcome(env, failure), env),
    }));
  const outcome = await runPipeline(pipe, {}, { services });
  assertEquals(outcome.status, 200);
  const text = new TextDecoder().decode(await readManagedBytes(outcome.body as ManagedStream<Uint8Array>));
  const body = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6));
  assertEquals(body, {
    type: 'error',
    error: {
      type: 'api_error',
      message: 'broken',
      provider_specific_fields: {
        name: 'Error',
        stack: failure.stack,
        cause: { name: 'TypeError', message: 'nested', stack: cause.stack },
      },
    },
  });
  assertEquals(text.includes('event: error'), true);
});

test('anthropic-messages pre-stream internal failures preserve HTTP status and diagnostic fields', async () => {
  initRepo(new InMemoryRepo());
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  const candidate = stubRouteCandidate({
    modelId: 'test-model',
    endpoints: { anthropicMessages: {} },
    enabledFlags: ['anthropic-messages-web-search-shim'],
  });
  const providerPipeline = stubStreamProviderPipeline<ProviderPipelineAnthropicMessagesInput, AnthropicMessagesStreamEventEx>(
    'test.unused',
    () => { throw failure; },
  );
  const { services } = mockChatPipelineServices({
    ctxOverrides: { wantsStream: false },
    entries: [{ candidate, pipelines: { anthropicMessages: providerPipeline } }],
    webSearchProvider: async () => ({ type: 'disabled' }),
  });
  const facts: AnthropicMessagesServeFacts = {
    'request.http': {
      method: 'POST',
      url: 'https://gateway.example/v1/messages',
      headers: [],
      body: { model: 'test-model', max_tokens: 16, tools: [{ name: 'web_search', type: 'web_search_20260209' }], messages: [{ role: 'user', content: 'hi' }] },
      protocol: 'anthropic-messages',
    },
    'request.inboundHeaders': [],
    'request.payload': { model: 'test-model', max_tokens: 16, tools: [{ name: 'web_search', type: 'web_search_20260209' }], messages: [{ role: 'user', content: 'hi' }] },
    'request.anthropicBeta': [],
  };
  const outcome = await runPipeline(anthropicMessagesGeneratePipeline, facts, { services });
  assertEquals(outcome.status, 500);
  const parsed = JSON.parse(new TextDecoder().decode(outcome.body as Uint8Array));
  expect(parsed).toMatchObject({
    type: 'error',
    error: {
      type: 'internal_error',
      message: 'Native Anthropic Messages web search requires an enabled search provider.',
    },
  });
});

test('anthropic-messages collecting a broken stream retains the nested error cause in an HTTP 502', async () => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken';
  const { services } = mockChatPipelineServices({ ctxOverrides: { wantsStream: false } });
  services.affinity.select(stubRouteCandidate());
  const pipe = pipeline<Record<never, never>>('respond.anthropic-messages.collect-fail')
    .end(terminal<Record<never, never>, DownstreamHttpOutcome, ChatPipelineServices>({
      name: 'respond.anthropic-messages.collect-fail.end',
      execute: async (_facts, env) => await renderAnthropicMessagesPipelineResponse(brokenOutcome(env, failure), env),
    }));
  const outcome = await runPipeline(pipe, {}, { services });
  assertEquals(outcome.status, 502);
  assertEquals(JSON.parse(new TextDecoder().decode(outcome.body as Uint8Array)), {
    type: 'error',
    error: {
      type: 'internal_error',
      message: 'broken',
      provider_specific_fields: {
        name: 'Error',
        stack: failure.stack,
        cause: { name: 'TypeError', message: 'nested', stack: cause.stack },
      },
    },
  });
});

const pipelineOutcome = (
  env: StageEnv<ChatPipelineServices>,
  events: readonly AnthropicMessagesStreamEventEx[],
): Extract<ChatAttemptOutcome<AnthropicMessagesStreamEventEx>, { type: 'events' }> => ({
  type: 'events',
  events: env.createStream<ProtocolFrame<AnthropicMessagesStreamEventEx>>({
    label: 'anthropic-messages.protocol.events',
    async *iterate() {
      for (const event of events) yield eventFrame(event);
      yield doneFrame();
    },
  }),
  modelIdentity: { model: 'test-model', upstream: 'up_test', modelKey: 'wire', pricing: null },
});

const completeEvents: readonly AnthropicMessagesStreamEventEx[] = [{
  type: 'message_start',
  message: {
    container: null,
    diagnostics: null,
    stop_details: null,
    id: 'msg_pipeline',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: createAnthropicMessagesUsage(2, 0),
  },
}, {
  type: 'message_stop',
}];

test.each([false, true])('pipeline responder renders collected JSON or managed SSE with Anthropic ping metadata (stream=%s)', async stream => {
  const { services } = mockChatPipelineServices({ ctxOverrides: { wantsStream: stream } });
  services.affinity.select(stubRouteCandidate());
  const pipe = pipeline<Record<never, never>>('respond.anthropic-messages')
    .end(terminal<Record<never, never>, { readonly result: Awaited<ReturnType<typeof renderAnthropicMessagesPipelineResponse>> }, ChatPipelineServices>({
      name: 'respond.anthropic-messages.end',
      execute: async (_facts, env) => ({ result: await renderAnthropicMessagesPipelineResponse(pipelineOutcome(env, completeEvents), env) }),
    }));
  const { result } = await runPipeline(pipe, {}, { services });
  expect(result.status).toBe(200);
  if (!stream) {
    expect(JSON.parse(new TextDecoder().decode(result.body as Uint8Array))).toMatchObject({ id: 'msg_pipeline', role: 'assistant' });
    return;
  }
  expect(result.sse).toEqual({ keepAliveWire: 'event: ping\ndata: {"type":"ping"}\n\n' });
  expect(result.headers).toContainEqual(['content-type', 'text/event-stream']);
  const bytes = await readManagedBytes(result.body as ManagedStream<Uint8Array>);
  expect(new TextDecoder().decode(bytes)).toContain('event: message_stop');
});
