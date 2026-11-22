import { klona } from 'klona/json';

import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { agentMessageShim } from './stages/agent-message-shim.ts';
import { answerWebSocketWarmup } from './stages/answer-websocket-warmup.ts';
import { applyRoleCompatibility } from './stages/apply-role-compatibility.ts';
import { collaborationShim } from './stages/collaboration-shim.ts';
import { compactShim } from './stages/compact-shim.ts';
import { disableReasoningOnForcedToolChoice } from './stages/disable-reasoning-on-forced-tool-choice.ts';
import { forceStoreFalse } from './stages/force-store-false.ts';
import { normalizeEmptyToolsToolChoice } from './stages/normalize-empty-tools-tool-choice.ts';
import { normalizeExclusiveCachedTokens } from './stages/normalize-exclusive-cached-tokens.ts';
import { withOpenAIResponsesServerToolShim } from './stages/server-tool-shim.ts';
import { filterInboundHeaderEntries, routeCandidateModelIdentity, routeCandidatePerformanceContext } from '../../pipeline/index.ts';
import {
  applyTranslationTripToOutcome,
  openAiErrorChatOutcome,
  providerStreamOutcomeToChatOutcome,
  readUpstreamApiErrorFromHttpOutcome,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type OpenAIResponsesAttemptInput,
} from '../pipeline/index.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { imageGenerationServerTool } from './stages/server-tools/image-generation.ts';
import { webSearchServerTool } from './stages/server-tools/web-search.ts';
import { standaloneToolOutputShim } from './stages/standalone-tool-output-shim.ts';
import { stripPromptCacheKey } from './stages/strip-prompt-cache-key.ts';
import { vendorDeepSeekNormalize } from './stages/vendor-deepseek-normalize.ts';
import { vendorQwenNormalize } from './stages/vendor-qwen-normalize.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from './usage.ts';
import { createAnthropicMessagesBillableUsageReader } from '../anthropic-messages/usage.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from '../openai-chat-completions/usage.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { defineRequestStage, defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { BoundDispatch, Pipeline, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, ProviderPipelineResponsesOutcome, ProviderPipelineStreamOutcome } from '@floway-dev/provider';
import {
  routeOpenAIResponsesViaAnthropicMessages,
  routeOpenAIResponsesViaOpenAIChatCompletions,
  type TranslateInputError,
} from '@floway-dev/translate';

// `/v1/responses` generate prefers the native OpenAI Responses target, then the
// translated Anthropic Messages path, then OpenAI Chat Completions. The same
// picker covers compact because every Responses target is reachable through
// the compact shim.
export const openaiResponsesTarget = chatTargetPicker([
  'openaiResponses',
  'anthropicMessages',
  'openaiChatCompletions',
]);

interface PreparedFacts extends OpenAIResponsesAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

const prepare = defineStage<
  OpenAIResponsesAttemptInput,
  Pick<PreparedFacts, 'request.payload' | 'route.targetApi'>,
  ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  never,
  ChatPipelineServices
>({
  name: 'prepareOpenAIResponsesAttempt',
  provides: ['request.payload', 'route.targetApi'],
  execute: async (facts, next) => {
    const candidate = facts['route.candidate'];
    const payload = {
      ...klona(facts['request.payload']),
      model: candidate.modelId,
    } as CanonicalOpenAIResponsesPayload;
    payload.input = normalizeAssistantInputText(payload.input);
    return await next({
      'request.payload': payload,
      'route.targetApi': openaiResponsesTarget.pick(candidate.endpoints),
    });
  },
});

type NativeDispatchPlan = {
  readonly type: 'native';
  readonly action: 'generate' | 'compact';
  readonly payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>;
};

type AnthropicDispatchPlan = {
  readonly type: 'anthropicMessages';
  readonly payload: AnthropicMessagesPayload;
};

type ChatDispatchPlan = {
  readonly type: 'openaiChatCompletions';
  readonly payload: OpenAIChatCompletionsPayloadEx;
};

type DispatchPlan = NativeDispatchPlan | AnthropicDispatchPlan | ChatDispatchPlan;

type DispatchInnerOutcome =
  | ProviderPipelineResponsesOutcome
  | ChatAttemptOutcome<AnthropicMessagesStreamEventEx>
  | ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>;

const translatedInputError = (
  error: TranslateInputError,
  candidate: import('@floway-dev/provider').RouteCandidate,
  env: import('@floway-dev/pipeline').StageEnv<ChatPipelineServices>,
) => openAiErrorChatOutcome(
  400,
  error.message,
  { param: error.param ?? 'input', code: error.code ?? null },
  routeCandidatePerformanceContext(env, candidate, 'chat'),
);

const translateOrNative = defineRequestStage<
  PreparedFacts,
  { readonly 'dispatch.plan': DispatchPlan },
  never,
  ChatPipelineServices
>({
  name: 'translateOrNative',
  provides: ['dispatch.plan'],
  execute: (async (facts: Readonly<PreparedFacts>, next: (provided: { readonly 'dispatch.plan': DispatchPlan }) => Promise<unknown>, env: StageEnv<ChatPipelineServices>) => {
    const candidate = facts['route.candidate'];
    const targetApi = facts['route.targetApi'];
    const payload = {
      ...klona(facts['request.payload']),
      model: candidate.modelId,
    } as CanonicalOpenAIResponsesPayload;

    if (targetApi === 'openaiResponses') {
      if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIResponses(payload, candidate.rules);
      const { model: _model, ...providerPayload } = payload;
      const action = facts['request.action'];
      const nativePayload = action === 'compact'
        ? omitCompactFields(providerPayload)
        : providerPayload;
      const raw = await next({ 'dispatch.plan': { type: 'native', action, payload: nativePayload } }) as ProviderPipelineResponsesOutcome;
      if (raw.action === 'generate') {
        return await providerStreamOutcomeToChatOutcome(
          raw,
          candidate,
          'openaiResponses',
          env,
          billableUsageFromOpenAIResponsesEvent,
        );
      }
      const performance = routeCandidatePerformanceContext(env, candidate, 'chat');
      if (!raw.ok) return await readUpstreamApiErrorFromHttpOutcome(raw.http, candidate.upstreamId, performance);
      const modelIdentity = routeCandidateModelIdentity(candidate, raw.modelKey);
      const billableUsage = billableUsageFromOpenAIResponsesResult(raw.result);
      const usageId = env.usageLedger.register({
        modelIdentity,
        performance,
        ...(billableUsage === null ? {} : { billableUsage }),
      });
      return {
        type: 'events',
        events: env.createStream({
          label: 'openai-responses.compact.events',
          async *iterate() {
            yield* syntheticEventsFromCompaction(raw.result);
          },
        }),
        modelIdentity,
        performance,
        http: {
          status: raw.http.status,
          statusText: raw.http.statusText,
          headers: raw.http.headers,
        },
        usageId,
      };
    }

    if (facts['request.action'] === 'compact') {
      throw new Error(`openaiResponsesAttempt: action='compact' reached dispatch on targetApi='${targetApi}' — compactShim must pivot the action`);
    }

    if (targetApi === 'anthropicMessages') {
      const trip = await routeOpenAIResponsesViaAnthropicMessages(
        { ...payload, stream: true },
        {
          sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
          fallbackMaxOutputTokens: candidate.limits.max_output_tokens,
        },
      );
      if (trip.type === 'input-error') return translatedInputError(trip, candidate, env);
      const rawInner = await next({
        'dispatch.plan': { type: 'anthropicMessages', payload: trip.target },
      }) as ChatAttemptOutcome<AnthropicMessagesStreamEventEx> | ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;
      const inner = 'type' in rawInner
        ? rawInner
        : await providerStreamOutcomeToChatOutcome(
            rawInner,
            candidate,
            'anthropicMessages',
            env,
            createAnthropicMessagesBillableUsageReader(),
          );
      return applyTranslationTripToOutcome(env, trip, targetApi, inner);
    }

    const trip = await routeOpenAIResponsesViaOpenAIChatCompletions(
      { ...payload, stream: true },
      { sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) },
    );
    if (trip.type === 'input-error') return translatedInputError(trip, candidate, env);
    const rawInner = await next({
      'dispatch.plan': { type: 'openaiChatCompletions', payload: trip.target },
    }) as ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent> | ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>;
    const inner = 'type' in rawInner
      ? rawInner
      : await providerStreamOutcomeToChatOutcome(
          rawInner,
          candidate,
          'openaiChatCompletions',
          env,
          billableUsageFromOpenAIChatCompletionsEvent,
        );
    return applyTranslationTripToOutcome(env, trip, targetApi, inner);
  }) as never,
});

const omitCompactFields = (
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
): Omit<CanonicalOpenAIResponsesPayload, 'model'> => {
  const { stream: _stream, store: _store, ...rest } = payload;
  return rest;
};

export const openaiResponsesAttemptPipeline: Pipeline<
  OpenAIResponsesAttemptInput,
  ChatAttemptOutcome<OpenAIResponsesStreamEventEx>,
  ChatPipelineServices
> = pipeline<OpenAIResponsesAttemptInput>('gateway.openai-responses.attempt')
  .use(prepare)
  .use(answerWebSocketWarmup)
  .use(agentMessageShim)
  .use(standaloneToolOutputShim)
  .use(compactShim)
  .use(collaborationShim)
  .use(withOpenAIResponsesServerToolShim([webSearchServerTool, imageGenerationServerTool]))
  .use(disableReasoningOnForcedToolChoice)
  .use(normalizeEmptyToolsToolChoice)
  .use(applyRoleCompatibility)
  .use(stripPromptCacheKey)
  .use(forceStoreFalse)
  .use(normalizeExclusiveCachedTokens)
  .use(vendorDeepSeekNormalize)
  .use(vendorQwenNormalize)
  .use(translateOrNative)
  .end(dispatch<OpenAIResponsesAttemptInput & { readonly 'dispatch.plan': DispatchPlan }, ChatAttemptOutcome<OpenAIResponsesStreamEventEx>, ChatPipelineServices>({
    name: 'gateway.openai-responses.attempt.dispatch',
    select: (async (
      facts: Readonly<OpenAIResponsesAttemptInput & { readonly 'dispatch.plan': DispatchPlan }>,
      env: StageEnv<ChatPipelineServices>,
    ) => {
      const candidate = facts['route.candidate'];
      const plan = facts['dispatch.plan'];
      if (plan.type === 'native') {
        const provider = env.providerFor(candidate.upstreamId);
        const target = provider.pipelines?.openaiResponses;
        if (target === undefined) throw new Error(`Provider ${candidate.upstreamId} has no openaiResponses pipeline`);
        return handoff(target, {
          'route.candidate': candidate,
          'provider.model': candidate.providerModel,
          'request.inboundHeaders': filterInboundHeaderEntries(
            facts['request.inboundHeaders'],
            provider.inboundHeaderAllowlist,
          ),
          'request.payload': plan.payload,
          'request.action': plan.action,
        }) as unknown as BoundDispatch<DispatchInnerOutcome, ChatPipelineServices>;
      }
      if (plan.type === 'anthropicMessages') {
        const { anthropicMessagesAttemptPipeline } = await import('../anthropic-messages/attempt-pipeline.ts');
        return handoff(anthropicMessagesAttemptPipeline, {
          'route.candidate': candidate,
          'request.inboundHeaders': facts['request.inboundHeaders'],
          'request.payload': plan.payload,
          'request.anthropicBeta': [],
        }) as unknown as BoundDispatch<DispatchInnerOutcome, ChatPipelineServices>;
      }
      const { openaiChatCompletionsAttemptPipeline } = await import('../openai-chat-completions/attempt-pipeline.ts');
      return handoff(openaiChatCompletionsAttemptPipeline, {
        'route.candidate': candidate,
        'request.inboundHeaders': facts['request.inboundHeaders'],
        'request.payload': plan.payload,
      }) as unknown as BoundDispatch<DispatchInnerOutcome, ChatPipelineServices>;
    }) as never,
  }));
