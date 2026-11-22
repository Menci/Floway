import { expect, test } from 'vitest';

import {
  anthropicMessagesAttemptPipeline,
  anthropicMessagesCountTokensAttemptPipeline,
} from '../../../../src/data-plane/chat/anthropic-messages/attempt-pipeline.ts';
import {
  runChatStage,
  createManagedProtocolFrames,
  mockChatPipelineServices,
  stubRouteCandidate,
} from '../../../test-utils/chat-pipeline.ts';
import { createDumpDecoder, createDumpEncoder, pipeline, projectWireView, runPipeline, terminal } from '@floway-dev/pipeline';
import type { RunTraceSink } from '@floway-dev/pipeline';
import { createAnthropicMessagesUsage, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type {
  HttpOutcome,
  ProviderPipelineAnthropicMessagesCountTokensInput,
  ProviderPipelineAnthropicMessagesInput,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
} from '@floway-dev/provider';

const traceSink = (): { readonly sink: RunTraceSink; readonly read: () => ReturnType<ReturnType<typeof createDumpDecoder>['pushNdjsonChunk']> } => {
  const encoder = createDumpEncoder({ detectRawSecretLeaks: false });
  const chunks: Uint8Array[] = [];
  return {
    sink: { push: event => { for (const encoded of encoder.encodeBatch([event])) chunks.push(new TextEncoder().encode(`${JSON.stringify(encoded)}\n`)); } },
    read: () => {
      const decoder = createDumpDecoder();
      const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return decoder.pushNdjsonChunk(bytes, { final: true });
    },
  };
};

const payload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'alias-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const messageEvents = (): readonly AnthropicMessagesStreamEventEx[] => [
  {
    type: 'message_start',
    message: {
      container: null, diagnostics: null, stop_details: null, id: 'msg_1', type: 'message', role: 'assistant', model: 'resolved-model', content: [], stop_reason: null, stop_sequence: null,
      usage: createAnthropicMessagesUsage(4, 0),
    },
  },
  { type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' }, usage: { input_tokens: null, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null } },
  { type: 'message_stop' },
];

test('generate stamps the candidate model, strips the beta header, applies alias rules and dispatches natively through Dump V2', async () => {
  const trace = traceSink();
  let observed: Readonly<ProviderPipelineAnthropicMessagesInput> | undefined;
  const providerPipeline = pipeline<ProviderPipelineAnthropicMessagesInput>('test.anthropic-messages')
    .end(terminal<ProviderPipelineAnthropicMessagesInput, ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>, ProviderPipelineServices>({
      name: 'test.anthropic-messages.upstream',
      tap: 'upstream',
      execute: async (facts, env) => {
        observed = facts;
        return {
          ok: true,
          events: createManagedProtocolFrames(env, messageEvents(), { label: 'anthropic-messages.protocol.events' }),
          modelKey: 'wire-model',
          http: { status: 200, statusText: 'OK', headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]), timing: { startedAtMs: 1, headersAtMs: 2 } },
        };
      },
    }));
  const candidate = stubRouteCandidate({
    upstreamId: 'up_native',
    modelId: 'resolved-model',
    upstreamModelId: 'wire-model',
    endpoints: { anthropicMessages: {} },
    rules: { reasoning: { effort: 'high', budget_tokens: 2048 }, serviceTier: 'fast' },
  });
  const { services } = mockChatPipelineServices({ entries: [{ candidate, pipelines: { anthropicMessages: providerPipeline } }] });
  const outcome = await runPipeline(anthropicMessagesAttemptPipeline, {
    'route.candidate': candidate,
    'request.inboundHeaders': [['anthropic-beta', 'claude-code-20250219'], ['x-ok', 'yes']],
    'request.payload': payload(),
    'request.anthropicBeta': ['context-1m-2025-08-07'],
  }, { services, traceSink: trace.sink });

  expect(outcome.type).toBe('events');
  if (observed === undefined) throw new Error('provider pipeline was not dispatched');
  expect(observed['request.inboundHeaders']).toEqual([]);
  expect(observed['request.anthropicBeta']).toEqual(['context-1m-2025-08-07']);
  expect(observed['request.payload']).toMatchObject({
    messages: [{ role: 'user', content: 'hello' }],
    output_config: { effort: 'high' },
    thinking: { type: 'enabled', budget_tokens: 2048 },
    speed: 'fast',
  });
  expect(observed['request.payload']).not.toHaveProperty('model');

  const wire = projectWireView(trace.read());
  expect(wire.upstreamAttempts).toHaveLength(1);
  expect(wire.upstreamAttempts[0]).toMatchObject({
    isSubRun: false,
    candidate: { upstreamId: 'up_native', modelId: 'resolved-model', upstreamModelId: 'wire-model' },
  });
  if (outcome.type === 'events') for await (const _frame of outcome.events) { /* drain the managed stream */ }
});

test('translated dispatch keeps the trip outside facts and hands the target protocol payload to the sibling pipeline', async () => {
  const facts = {
    'route.candidate': stubRouteCandidate({ modelId: 'resolved-model', endpoints: { openaiResponses: {} } }),
    'route.targetApi': 'openaiResponses' as const,
    'request.inboundHeaders': [],
    'request.payload': payload({ system: 'be concise' }),
    'request.anthropicBeta': [],
    'web-search.state': undefined,
  };
  const { outcome } = await runChatStage({
    stage: (await import('../../../../src/data-plane/chat/anthropic-messages/stages/translate-or-native.ts')).translateOrNative,
    facts,
    next: (nextFacts, env) => {
      const plan = nextFacts['dispatch.plan'];
      expect(plan.targetApi).toBe('openaiResponses');
      expect(plan).not.toHaveProperty('trip');
      expect(JSON.stringify(plan)).toContain('resolved-model');
      return {
        type: 'events' as const,
        events: createManagedProtocolFrames<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>(env, [{
          type: 'response.completed',
          sequence_number: 0,
          response: { id: 'resp_1', object: 'response', model: 'resolved-model', status: 'completed', output: [], error: null, incomplete_details: null },
        }], { label: 'openai-responses.protocol.events' }),
        modelIdentity: { model: 'resolved-model', upstream: 'up_test', modelKey: 'response-key', pricing: null },
      };
    },
  });
  expect(outcome.type).toBe('events');
  if (outcome.type === 'events') for await (const _frame of outcome.events) { /* drain */ }
});

test('count tokens runs the shared request transforms and converts the native provider HTTP outcome', async () => {
  let observedBody: ProviderPipelineAnthropicMessagesCountTokensInput['request.payload'] | undefined;
  const providerPipeline = pipeline<ProviderPipelineAnthropicMessagesCountTokensInput>('test.anthropic-messages.count-tokens')
    .end(terminal<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome, ProviderPipelineServices>({
      name: 'test.anthropic-messages.count-tokens.end',
      execute: async (facts, env): Promise<HttpOutcome> => {
        observedBody = facts['request.payload'];
        return {
          status: 200,
          statusText: 'OK',
          headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
          body: env.createStream<Uint8Array>({
            label: 'count-tokens.http.body',
            async *iterate() { yield new TextEncoder().encode('{"input_tokens":9}'); },
          }),
          timing: { startedAtMs: 1, headersAtMs: 2 },
        };
      },
    }));
  const candidate = stubRouteCandidate({
    modelId: 'resolved-model',
    endpoints: { anthropicMessages: {} },
    enabledFlags: ['strip-billing-attribution', 'disable-reasoning-on-forced-tool-choice', 'rewrite-mid-conv-system-to-user'],
    rules: { reasoning: { effort: 'high' } },
  });
  const { services } = mockChatPipelineServices({
    entries: [{
      candidate,
      pipelines: { anthropicMessagesCountTokens: providerPipeline },
    }],
  });
  const outcome = await runPipeline(anthropicMessagesCountTokensAttemptPipeline, {
    'route.candidate': candidate,
    'request.inboundHeaders': [['anthropic-beta', 'claude-code-20250219']],
    'request.payload': payload({
      system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;\nbase rules',
      messages: [
        { role: 'system', content: 'inline rules' },
        { role: 'user', content: 'hello' },
      ],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      output_config: { effort: 'low' },
      tool_choice: { type: 'tool', name: 'lookup' },
    }),
    'request.anthropicBeta': ['context-1m-2025-08-07'],
  }, { services });

  expect(outcome.type).toBe('plain');
  expect(outcome.body).toEqual(new TextEncoder().encode('{"input_tokens":9}'));
  expect(observedBody).toMatchObject({
    system: 'base rules',
    messages: [
      { role: 'user', content: 'inline rules' },
      { role: 'user', content: 'hello' },
    ],
    thinking: { type: 'disabled' },
    tool_choice: { type: 'tool', name: 'lookup' },
  });
  expect(observedBody).not.toHaveProperty('model');
});
