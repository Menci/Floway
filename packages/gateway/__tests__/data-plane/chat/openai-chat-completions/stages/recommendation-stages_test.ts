import { describe, expect, test, vi } from 'vitest';

import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/disable-reasoning-on-forced-tool-choice.ts';
import { createIncludeUsageStreamOptionsStage } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/normalize-exclusive-cached-tokens.ts';
import { stripPromptCacheKey } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/strip-prompt-cache-key.ts';
import { vendorKimiNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-kimi-normalize.ts';
import { vendorQwenNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/stages/vendor-qwen-normalize.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../../../../../src/data-plane/chat/openai-chat-completions/usage.ts';
import type { ChatAttemptOutcome } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { createManagedProtocolFrames, mockChatPipelineServices, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

const payload = (overrides: Partial<OpenAIChatCompletionsPayloadEx> = {}): OpenAIChatCompletionsPayloadEx => ({
  model: 'client-model',
  messages: [{ role: 'user', content: 'hello' }],
  ...overrides,
});

const facts = (options: {
  readonly overrides?: Partial<OpenAIChatCompletionsPayloadEx>;
  readonly targetApi?: 'openaiChatCompletions' | 'anthropicMessages' | 'openaiResponses';
  readonly enabledFlags?: NonNullable<Parameters<typeof stubRouteCandidate>[0]>['enabledFlags'];
} = {}) => ({
  'route.candidate': stubRouteCandidate({
    modelId: 'candidate-model',
    endpoints: options.targetApi === undefined ? { openaiChatCompletions: {} } : { [options.targetApi]: {} },
    ...(options.enabledFlags === undefined ? {} : { enabledFlags: options.enabledFlags }),
  }),
  'request.inboundHeaders': [],
  'request.payload': payload(options.overrides),
  'route.targetApi': options.targetApi ?? 'openaiChatCompletions' as const,
});

const collectEvents = async (outcome: ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>) => {
  if (outcome.type !== 'events') throw new Error(`Expected events, received ${outcome.type}`);
  const events: OpenAIChatCompletionsStreamEvent[] = [];
  for await (const frame of outcome.events) if (frame.type === 'event') events.push(frame.event);
  return events;
};

describe('OpenAI Chat Completions stages', () => {
  test('stamps target and forces upstream usage without mutating the source payload', async () => {
    const source = facts();
    const next = vi.fn(async (_provided: { readonly 'request.payload': OpenAIChatCompletionsPayloadEx }) => ({
      type: 'plain' as const,
      http: { status: 200, headers: [] },
      body: null,
    }));
    await runChatStage({
      stage: createIncludeUsageStreamOptionsStage({ pick: () => 'openaiChatCompletions' }),
      facts: source,
      next,
    });

    expect(source['request.payload'].stream_options).toBeUndefined();
    expect(next.mock.calls[0][0]['request.payload']).toMatchObject({
      model: 'candidate-model',
      stream_options: { include_usage: true },
    });
  });

  test('applies opt-in request compatibility rewrites by flag', async () => {
    const next = vi.fn(async (_provided: { readonly 'request.payload': OpenAIChatCompletionsPayloadEx }) => ({
      type: 'plain' as const,
      http: { status: 200, headers: [] },
      body: null,
    }));
    await runChatStage({
      stage: disableReasoningOnForcedToolChoice,
      facts: facts({ overrides: { tools: [{ type: 'function', function: { name: 'x', parameters: {} } }], tool_choice: 'required' }, enabledFlags: ['disable-reasoning-on-forced-tool-choice'] }),
      next,
    });
    expect(next.mock.calls[0][0]['request.payload'].reasoning_effort).toBe('none');

    await runChatStage({
      stage: normalizeEmptyToolsToolChoice,
      facts: facts({ overrides: { tools: [], tool_choice: 'auto' }, enabledFlags: ['empty-tools-tool-choice-none'] }),
      next,
    });
    expect(next.mock.calls[1][0]['request.payload'].tool_choice).toBe('none');

    await runChatStage({
      stage: stripPromptCacheKey,
      facts: facts({ overrides: { prompt_cache_key: 'thread' }, enabledFlags: ['strip-prompt-cache-key'] }),
      next,
    });
    expect(next.mock.calls[2][0]['request.payload']).not.toHaveProperty('prompt_cache_key');

    await runChatStage({
      stage: vendorQwenNormalize,
      facts: facts({ overrides: { reasoning_effort: 'none' }, enabledFlags: ['vendor-qwen'] }),
      next,
    });
    expect(next.mock.calls[3][0]['request.payload']).toMatchObject({ enable_thinking: false });
  });

  test('applies role rewrites only on the native target in declared order', async () => {
    const messages = [
      { role: 'system' as const, content: 'base' },
      { role: 'user' as const, content: 'hello' },
      { role: 'system' as const, content: 'inline' },
    ];
    const next = vi.fn(async (_provided: { readonly 'request.payload': OpenAIChatCompletionsPayloadEx }) => ({
      type: 'plain' as const,
      http: { status: 200, headers: [] },
      body: null,
    }));
    await runChatStage({
      stage: applyRoleCompatibility,
      facts: facts({ overrides: { messages }, enabledFlags: ['rewrite-system-to-developer', 'rewrite-developer-to-system', 'rewrite-mid-conv-system-to-user'] }),
      next,
    });
    expect(next.mock.calls[0][0]['request.payload'].messages.map(message => message.role)).toEqual(['system', 'user', 'user']);
  });

  test('relocates usage and refreshes the ledger after cache normalization', async () => {
    const { services } = mockChatPipelineServices();
    const usageId = services.usageLedger.register({ modelIdentity: testTelemetryModelIdentity });
    const outcome = (events: import('@floway-dev/pipeline').ManagedStream<import('@floway-dev/protocols/common').ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) => ({
      type: 'events' as const,
      events,
      modelIdentity: testTelemetryModelIdentity,
      usageId,
    });
    const event: OpenAIChatCompletionsStreamEvent = {
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'm',
      choices: [],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 3,
        total_tokens: 10,
        prompt_tokens_details: { cached_tokens: 5 },
      } as never,
    };
    const result = await runChatStage({
      stage: normalizeExclusiveCachedTokens,
      facts: facts({ enabledFlags: ['usage-exclusive-cached-tokens'] }),
      services,
      next: (_provided, env) => outcome(createManagedProtocolFrames(env, [event])),
    });
    const events = await collectEvents(result.outcome);
    expect(events).toHaveLength(1);
    expect(events[0].usage?.prompt_tokens).toBe(7);
    const ledger = result.services.usageLedger.read(usageId, { modelIdentity: testTelemetryModelIdentity });
    expect(ledger.billableUsage).toEqual(billableUsageFromOpenAIChatCompletionsEvent(events[0]));
  });

  test('normalizes DeepSeek and Kimi usage before metering consumers read it', async () => {
    const { services } = mockChatPipelineServices();
    const usageId = services.usageLedger.register({ modelIdentity: testTelemetryModelIdentity });
    const usageEvent: OpenAIChatCompletionsStreamEvent = {
      id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cached_tokens: 4 } as never,
    };
    const result = await runChatStage({
      stage: vendorKimiNormalize,
      facts: facts({ enabledFlags: ['vendor-kimi'] }),
      services,
      next: (_provided, env) => ({
        type: 'events' as const, events: createManagedProtocolFrames(env, [usageEvent]), modelIdentity: testTelemetryModelIdentity, usageId,
      }),
    });
    const events = await collectEvents(result.outcome);
    expect(events[0].usage?.prompt_tokens_details).toMatchObject({ cached_tokens: 4 });
    expect(result.services.usageLedger.read(usageId, { modelIdentity: testTelemetryModelIdentity }).billableUsage?.cacheRead).toBe(4);
  });
});
