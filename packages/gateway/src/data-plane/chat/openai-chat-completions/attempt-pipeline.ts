import { inputErrorChatOutcome } from './errors.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { createIncludeUsageStreamOptionsStage } from './stages/include-usage-stream-options.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { normalizeUsage } from './stages/normalize-usage.ts';
import { stripPromptCacheKey } from './stages/strip-prompt-cache-key.ts';
import { vendorDeepSeekNormalize } from './stages/vendor-deepseek-normalize.ts';
import { vendorKimiNormalize } from './stages/vendor-kimi-normalize.ts';
import { vendorQwenNormalize } from './stages/vendor-qwen-normalize.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import { filterInboundHeaderEntries, routeCandidatePerformanceContext } from '../../pipeline/index.ts';
import {
  applyTranslationTripToOutcome,
  providerStreamOutcomeToChatOutcome,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type OpenAIChatCompletionsAttemptInput,
} from '../pipeline/index.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { BoundDispatch, Pipeline, StageEnv } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type {
  ChatTargetApi,
  ProviderPipelineStreamOutcome,
  RouteCandidate,
} from '@floway-dev/provider';
import {
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaOpenAIResponses,
} from '@floway-dev/translate';

// `/v1/chat/completions` prefers a native OpenAI Chat Completions target, then
// Anthropic Messages, then OpenAI Responses.
export const openaiChatCompletionsTarget = chatTargetPicker([
  'openaiChatCompletions',
  'anthropicMessages',
  'openaiResponses',
]);

interface TargetFacts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

type DispatchPlan =
  | {
    readonly type: 'native';
    readonly candidate: RouteCandidate;
    readonly headers: readonly import('@floway-dev/pipeline').HeaderEntry[];
    readonly body: Omit<OpenAIChatCompletionsPayloadEx, 'model'>;
  }
  | {
    readonly type: 'translated';
    readonly targetApi: 'anthropicMessages' | 'openaiResponses';
    readonly candidate: RouteCandidate;
    readonly headers: readonly import('@floway-dev/pipeline').HeaderEntry[];
    readonly body: import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesPayload | import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload;
  };

type DispatchInnerOutcome =
  | ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>
  | ChatAttemptOutcome<import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx>
  | ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>;

const inboundHeadersForCandidate = (
  facts: OpenAIChatCompletionsAttemptInput,
  env: StageEnv<ChatPipelineServices>,
): readonly import('@floway-dev/pipeline').HeaderEntry[] => filterInboundHeaderEntries(
  facts['request.inboundHeaders'],
  env.providerFor(facts['route.candidate'].upstreamId).inboundHeaderAllowlist,
);

const translatedInputError = (
  error: { readonly message: string; readonly param?: string; readonly code?: string },
  candidate: RouteCandidate,
  env: StageEnv<ChatPipelineServices>,
) => inputErrorChatOutcome(error, routeCandidatePerformanceContext(env, candidate, 'chat'));

const translateOrNative = defineStage<
  TargetFacts,
  { readonly 'dispatch.plan': DispatchPlan },
  DispatchInnerOutcome,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'translateOrNative',
  provides: ['dispatch.plan'],
  execute: async (facts: Readonly<TargetFacts>, next: (provided: { readonly 'dispatch.plan': DispatchPlan }) => Promise<DispatchInnerOutcome>, env: StageEnv<ChatPipelineServices>) => {
    const candidate = facts['route.candidate'];
    const payload = { ...facts['request.payload'] };
    if (facts['route.targetApi'] === 'openaiChatCompletions') {
      if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIChatCompletions(payload, candidate.rules);
      const { model: _model, ...body } = payload;
      const providerOutcome = await next({
        'dispatch.plan': {
          type: 'native',
          candidate,
          headers: inboundHeadersForCandidate(facts, env),
          body,
        },
      }) as ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>;
      return await providerStreamOutcomeToChatOutcome(
        providerOutcome,
        candidate,
        'openaiChatCompletions',
        env,
        billableUsageFromOpenAIChatCompletionsEvent,
      );
    }

    const targetApi = facts['route.targetApi'];
    if (targetApi !== 'anthropicMessages' && targetApi !== 'openaiResponses') {
      throw new Error(`Unexpected OpenAI Chat Completions target '${targetApi}'`);
    }
    const options = {
      sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: candidate.limits.max_output_tokens,
    };
    if (targetApi === 'anthropicMessages') {
      const trip = await routeOpenAIChatCompletionsViaAnthropicMessages({ ...payload, stream: true }, options);
      if (trip.type === 'input-error') return translatedInputError(trip, candidate, env);
      const inner = await next({
        'dispatch.plan': { type: 'translated', targetApi, candidate, headers: facts['request.inboundHeaders'], body: trip.target },
      }) as ChatAttemptOutcome<import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx>;
      return applyTranslationTripToOutcome(env, trip, targetApi, inner);
    }
    const trip = await routeOpenAIChatCompletionsViaOpenAIResponses({ ...payload, stream: true }, options);
    if (trip.type === 'input-error') return translatedInputError(trip, candidate, env);
    const inner = await next({
      'dispatch.plan': { type: 'translated', targetApi, candidate, headers: facts['request.inboundHeaders'], body: trip.target },
    }) as ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>;
    return applyTranslationTripToOutcome(env, trip, targetApi, inner);
  },
});

const selectDispatch = async (
  facts: Readonly<TargetFacts & { readonly 'dispatch.plan': DispatchPlan }>,
  env: StageEnv<ChatPipelineServices>,
): Promise<BoundDispatch<DispatchInnerOutcome, ChatPipelineServices>> => {
  const plan = facts['dispatch.plan'];
  if (plan.type === 'native') {
    const provider = env.providerFor(plan.candidate.upstreamId);
    const target = provider.pipelines?.openaiChatCompletions;
    if (target === undefined) throw new Error(`Provider ${plan.candidate.upstreamId} has no openaiChatCompletions pipeline`);
    return handoff(target, {
      'route.candidate': plan.candidate,
      'provider.model': plan.candidate.providerModel,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.body,
    });
  }
  if (plan.targetApi === 'anthropicMessages') {
    const { anthropicMessagesAttemptPipeline } = await import('../anthropic-messages/attempt-pipeline.ts');
    return handoff(anthropicMessagesAttemptPipeline, {
      'route.candidate': plan.candidate,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.body as import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesPayload,
      'request.anthropicBeta': [],
    });
  }
  const { openaiResponsesAttemptPipeline } = await import('../openai-responses/attempt-pipeline.ts');
  return handoff(openaiResponsesAttemptPipeline, {
    'route.candidate': plan.candidate,
    'request.inboundHeaders': plan.headers,
    'request.payload': plan.body as import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload,
    'request.action': 'generate',
  });
};

const dispatchStage = (facts: Readonly<TargetFacts & { readonly 'dispatch.plan': DispatchPlan }>, env: StageEnv<ChatPipelineServices>) =>
  selectDispatch(facts, env);

export const openaiChatCompletionsAttemptPipeline: Pipeline<
  OpenAIChatCompletionsAttemptInput,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatPipelineServices
> = pipeline<OpenAIChatCompletionsAttemptInput>('gateway.openai-chat-completions.attempt')
  .use(createIncludeUsageStreamOptionsStage(openaiChatCompletionsTarget))
  .use(normalizeUsage)
  .use(disableReasoningOnForcedToolChoice)
  .use(normalizeEmptyToolsToolChoice)
  .use(applyRoleCompatibility)
  .use(stripPromptCacheKey)
  .use(normalizeExclusiveCachedTokens)
  .use(vendorDeepSeekNormalize)
  .use(vendorQwenNormalize)
  .use(vendorKimiNormalize)
  .use(translateOrNative)
  .end(dispatch({
    name: 'gateway.openai-chat-completions.attempt.dispatch',
    select: dispatchStage,
  }));
