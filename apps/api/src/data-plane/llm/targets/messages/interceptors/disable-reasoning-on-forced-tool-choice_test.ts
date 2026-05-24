import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { TelemetryModelIdentity } from '../../../../../repo/types.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { ModelProvider, UpstreamModel } from '../../../../providers/types.ts';
import type { MessagesInvocation, RequestContext } from '../../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../shared/errors/result.ts';
import type { ProtocolFrame } from '@copilot-gateway/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@copilot-gateway/protocols/messages';

const stubProvider = (): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  getPricingForModelKey: () => null,
  callChatCompletions: () => Promise.reject(new Error('unexpected call')),
  callResponses: () => Promise.reject(new Error('unexpected call')),
  callMessages: () => Promise.reject(new Error('unexpected call')),
  callMessagesCountTokens: () => Promise.reject(new Error('unexpected call')),
  callEmbeddings: () => Promise.reject(new Error('unexpected call')),
  callImagesGenerations: () => Promise.reject(new Error('unexpected call')),
  callImagesEdits: () => Promise.reject(new Error('unexpected call')),
});

const stubUpstreamModel = (): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  upstreamEndpoints: ['messages'],
  enabledFlags: new Set<string>(),
});

const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key', cost: null,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set(['disable-reasoning-on-forced-tool-choice']),
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

test('messages forced tool_choice disables thinking and strips output_config', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'x' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.thinking, { type: 'disabled' });
  assertEquals(input.payload.output_config, undefined);
});

test('messages any tool_choice also disables thinking', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    tool_choice: { type: 'any' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.thinking, { type: 'disabled' });
});

test('messages non-forced tool_choice leaves reasoning untouched', async () => {
  for (const type of ['auto', 'none'] as const) {
    const input = invocation({
      model: 'm',
      messages: [],
      max_tokens: 1,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tool_choice: { type },
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

    assertEquals(input.payload.thinking, {
      type: 'enabled',
      budget_tokens: 1024,
    });
  }
});
