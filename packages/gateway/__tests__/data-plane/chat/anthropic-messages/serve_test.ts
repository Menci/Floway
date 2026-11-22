import { expect, test } from 'vitest';

import { anthropicMessagesCountTokensPipeline, anthropicMessagesGeneratePipeline, type AnthropicMessagesServeFacts } from '../../../../src/data-plane/chat/anthropic-messages/serve-pipeline.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createManagedProtocolFrames, mockChatPipelineServices, stubRouteCandidate, stubStreamProviderPipeline } from '../../../test-utils/chat-pipeline.ts';
import { pipeline, runPipeline, terminal } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { createAnthropicMessagesUsage } from '@floway-dev/protocols/anthropic-messages';
import type { HttpOutcome, ProviderPipelineAnthropicMessagesCountTokensInput, ProviderPipelineAnthropicMessagesInput, ProviderPipelineServices } from '@floway-dev/provider';

const payload = (overrides: Partial<AnthropicMessagesPayload> = {}): AnthropicMessagesPayload => ({
  model: 'test-model',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const facts = (value: AnthropicMessagesPayload, beta: readonly string[] = []): AnthropicMessagesServeFacts => ({
  'request.http': {
    method: 'POST',
    url: 'https://gateway.example/v1/messages',
    headers: [['anthropic-beta', beta.join(',')]],
    body: value,
    protocol: 'anthropic-messages',
  },
  'request.inboundHeaders': [['anthropic-beta', beta.join(',')]],
  'request.payload': value,
  'request.anthropicBeta': beta,
});

const messageEvents = (): readonly AnthropicMessagesStreamEventEx[] => [{
  type: 'message_start',
  message: {
    container: null, diagnostics: null, stop_details: null, id: 'msg_serve', type: 'message', role: 'assistant', model: 'resolved-model', content: [], stop_reason: null, stop_sequence: null,
    usage: createAnthropicMessagesUsage(10, 0),
  },
}, {
  type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' },
  usage: { input_tokens: null, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null },
}, { type: 'message_stop' }];

test('generate routes a native candidate and exposes the beta list to the provider', async () => {
  initRepo(new InMemoryRepo());
  let observedBeta: readonly string[] = [];
  const providerPipeline = stubStreamProviderPipeline<ProviderPipelineAnthropicMessagesInput, AnthropicMessagesStreamEventEx>('test.anthropic-messages', (input, env) => {
    observedBeta = input['request.anthropicBeta'];
    return {
      ok: true,
      events: createManagedProtocolFrames(env, messageEvents(), { label: 'anthropic-messages.events' }),
      modelKey: 'wire-model',
      http: { status: 200, statusText: 'OK', headers: Object.freeze([Object.freeze(['content-type', 'text/event-stream'] as const)]), timing: { startedAtMs: 1, headersAtMs: 2 } },
    };
  });
  const candidate = stubRouteCandidate({ modelId: 'resolved-model', endpoints: { anthropicMessages: {} } });
  const { services } = mockChatPipelineServices({ entries: [{ candidate, pipelines: { anthropicMessages: providerPipeline } }] });
  const outcome = await runPipeline(anthropicMessagesGeneratePipeline, facts(payload(), ['context-1m-2025-08-07']), { services });
  expect(outcome.status).toBe(200);
  expect(observedBeta).toEqual(['context-1m-2025-08-07']);
  expect(outcome.body).not.toBeNull();
});

test('generate filters unsupported endpoints and renders model-unsupported as 400', async () => {
  initRepo(new InMemoryRepo());
  const candidate = stubRouteCandidate({ endpoints: { openaiCompletions: {} } });
  const { services } = mockChatPipelineServices({ entries: [{ candidate }] });
  const outcome = await runPipeline(anthropicMessagesGeneratePipeline, facts(payload()), { services });
  expect(outcome.status).toBe(400);
  const body = JSON.parse(new TextDecoder().decode(outcome.body as Uint8Array));
  expect(body.error.type).toBe('invalid_request_error');
});

test('count tokens proxies the upstream measurement and stamps the resolved model', async () => {
  initRepo(new InMemoryRepo());
  const observedModels: string[] = [];
  const providerPipeline = pipeline<ProviderPipelineAnthropicMessagesCountTokensInput>('test.anthropic-messages.count-tokens')
    .end(terminal<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome, ProviderPipelineServices>({
      name: 'test.anthropic-messages.count-tokens.end',
      execute: async (input, env): Promise<HttpOutcome> => {
        observedModels.push(input['request.payload'].messages[0]?.role ?? 'none');
        return {
          status: 200,
          statusText: 'OK',
          headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
          body: env.createStream<Uint8Array>({ label: 'count.body', async *iterate() { yield new TextEncoder().encode('{"input_tokens":42}'); } }),
          timing: { startedAtMs: 1, headersAtMs: 2 },
        };
      },
    }));
  const candidate = stubRouteCandidate({ modelId: 'resolved-model', endpoints: { anthropicMessages: {} } });
  const { services } = mockChatPipelineServices({ entries: [{ candidate, pipelines: { anthropicMessagesCountTokens: providerPipeline } }] });
  const outcome = await runPipeline(anthropicMessagesCountTokensPipeline, facts(payload()), { services });
  expect(outcome.status).toBe(200);
  expect(new TextDecoder().decode(outcome.body as Uint8Array)).toBe('{"input_tokens":42}');
  expect(observedModels).toEqual(['user']);
});
