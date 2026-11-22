import { nativeDispatchPlan, prepareTranslatedDispatch } from './dispatch-plan.ts';
import type {
  AnthropicMessagesDispatchPlan,
  AnthropicMessagesDispatchedOutcome,
  AnthropicMessagesGenerateOutcome,
  AnthropicMessagesPreparedFacts,
} from './types.ts';
import { routeCandidatePerformanceContext } from '../../../pipeline/index.ts';
import { applyTranslationTripToOutcome, gatewayInputErrorOutcome } from '../../pipeline/index.ts';
import type { ChatAttemptOutcome, ChatPipelineServices } from '../../pipeline/index.ts';
import { providerStreamOutcomeToChatOutcome } from '../../pipeline/stream-outcome.ts';
import { inputErrorFields } from '../../shared/errors.ts';
import { createAnthropicMessagesBillableUsageReader } from '../usage.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderPipelineStreamOutcome } from '@floway-dev/provider';
import type { TranslateInputError } from '@floway-dev/translate';

const inputErrorOutcome = (
  trip: TranslateInputError,
  candidate: import('@floway-dev/provider').RouteCandidate,
  env: import('@floway-dev/pipeline').StageEnv<ChatPipelineServices>,
): AnthropicMessagesGenerateOutcome => gatewayInputErrorOutcome(
  400,
  {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: trip.message,
      ...(inputErrorFields(trip) === undefined ? {} : { provider_specific_fields: inputErrorFields(trip) }),
    },
  },
  routeCandidatePerformanceContext(env, candidate, 'chat'),
);

export const translateOrNative = defineStage<
  AnthropicMessagesPreparedFacts,
  { readonly 'dispatch.plan': AnthropicMessagesDispatchPlan },
  AnthropicMessagesDispatchedOutcome,
  AnthropicMessagesGenerateOutcome,
  never,
  ChatPipelineServices
>({
  name: 'translateOrNative',
  provides: ['dispatch.plan'],
  execute: async (facts, next, env) => {
    const candidate = facts['route.candidate'];
    if (facts['route.targetApi'] === 'anthropicMessages') {
      const plan: Extract<AnthropicMessagesDispatchPlan, { targetApi: 'anthropicMessages' }> = nativeDispatchPlan(facts, env);
      const providerOutcome = await next({ 'dispatch.plan': plan }) as ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;
      return await providerStreamOutcomeToChatOutcome(
        providerOutcome,
        candidate,
        'anthropicMessages',
        env,
        createAnthropicMessagesBillableUsageReader(),
      );
    }

    const translated = await prepareTranslatedDispatch(facts, env);
    if (translated.type === 'input-error') return inputErrorOutcome(translated, candidate, env);
    if (translated.targetApi === 'openaiResponses') {
      const inner = await next({ 'dispatch.plan': translated.plan }) as ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>;
      return applyTranslationTripToOutcome(env, translated.trip, 'openaiResponses', inner);
    }
    const inner = await next({ 'dispatch.plan': translated.plan }) as ChatAttemptOutcome<import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsStreamEvent>;
    return applyTranslationTripToOutcome(env, translated.trip, 'openaiChatCompletions', inner);
  },
});
