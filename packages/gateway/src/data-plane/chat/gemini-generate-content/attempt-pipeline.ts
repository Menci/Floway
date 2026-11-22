import {
  gatewayErrorStatus,
  geminiGenerateContentInternalErrorPayload,
  normalizeGeminiChatFailure,
} from './errors.ts';
import { stripSafetySettings } from './stages/strip-safety-settings.ts';
import { createStripUnsupportedPartFieldsStage } from './stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from './stages/suppress-thought-parts.ts';
import { filterInboundHeaderEntries, routeCandidatePerformanceContext } from '../../pipeline/index.ts';
import {
  applyTranslationTripToOutcome,
  plainOutcomeFromHttpOutcome,
  providerStreamOutcomeToChatOutcome,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type ChatPlainOutcome,
  type GeminiGenerateContentAttemptInput,
} from '../pipeline/index.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../shared/alias-rules.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { BoundDispatch, HeaderEntry, Pipeline, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import {
  billableUsageFromGeminiGenerateContentEvent,
  type GeminiGenerateContentPayload,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import {
  toInternalDebugError,
  type ChatTargetApi,
  type HttpOutcome,
  type ProviderPipelineStreamOutcome,
  type RouteCandidate,
} from '@floway-dev/provider';
import {
  routeGeminiGenerateContentViaAnthropicMessages,
  routeGeminiGenerateContentViaOpenAIChatCompletions,
  routeGeminiGenerateContentViaOpenAIResponses,
} from '@floway-dev/translate';

export type GeminiCountTokensAttemptOutcome =
  | ChatPlainOutcome
  | Extract<ChatAttemptOutcome<never>, { type: 'api-error' }>;

// A native Gemini wire is always preferred. Generate then tries OpenAI Chat
// Completions, Anthropic Messages, and OpenAI Responses; count tokens has only
// Anthropic Messages as a translated target.
export const geminiGenerateContentGenerateTarget = chatTargetPicker([
  'geminiGenerateContent',
  'openaiChatCompletions',
  'anthropicMessages',
  'openaiResponses',
]);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker([
  'geminiGenerateContent',
  'anthropicMessages',
]);

interface TargetFacts extends GeminiGenerateContentAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

type GenerateDispatchPlan =
  | {
    readonly type: 'native';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: GeminiGenerateContentPayload;
  }
  | {
    readonly type: 'translated';
    readonly targetApi: 'anthropicMessages' | 'openaiChatCompletions' | 'openaiResponses';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: AnthropicMessagesPayload | OpenAIChatCompletionsPayloadEx | CanonicalOpenAIResponsesPayload;
  };

type GenerateDispatchInnerOutcome =
  | ProviderPipelineStreamOutcome<GeminiGenerateContentStreamEvent>
  | ChatAttemptOutcome<import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx>
  | ChatAttemptOutcome<import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsStreamEvent>
  | ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>;

const inboundHeadersForCandidate = (
  facts: GeminiGenerateContentAttemptInput,
  env: StageEnv<ChatPipelineServices>,
): readonly HeaderEntry[] => filterInboundHeaderEntries(
  facts['request.inboundHeaders'],
  env.providerFor(facts['route.candidate'].upstreamId).inboundHeaderAllowlist,
);

const translatedInputError = (
  error: { readonly message: string; readonly param?: string; readonly code?: string },
  candidate: RouteCandidate,
  env: StageEnv<ChatPipelineServices>,
): Extract<ChatAttemptOutcome<never>, { type: 'api-error' }> => ({
  type: 'api-error',
  source: 'gateway',
  http: { status: 400, headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]) },
  body: new TextEncoder().encode(JSON.stringify({
    error: {
      code: 400,
      message: error.message,
      status: gatewayErrorStatus(400),
      ...(error.param === undefined && error.code === undefined ? {} : {
        details: [{
          '@type': 'type.googleapis.com/google.protobuf.Struct',
          value: {
            ...(error.param === undefined ? {} : { param: error.param }),
            ...(error.code === undefined ? {} : { code: error.code }),
          },
        }],
      }),
    },
  })),
  performance: routeCandidatePerformanceContext(env, candidate, 'chat'),
});

const translateOrNative = defineStage<
  TargetFacts,
  { readonly 'dispatch.plan': GenerateDispatchPlan },
  GenerateDispatchInnerOutcome,
  ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'translateOrNative',
  provides: ['dispatch.plan'],
  execute: async (facts: Readonly<TargetFacts>, next: (provided: { readonly 'dispatch.plan': GenerateDispatchPlan }) => Promise<GenerateDispatchInnerOutcome>, env: StageEnv<ChatPipelineServices>) => {
    const candidate = facts['route.candidate'];
    const targetApi = facts['route.targetApi'];
    const payload = { ...facts['request.payload'] };
    if (targetApi === 'geminiGenerateContent') {
      if (candidate.rules !== undefined) applyRulesToUpstreamGeminiGenerateContent(payload, candidate.rules);
      const providerOutcome = await next({
        'dispatch.plan': {
          type: 'native',
          candidate,
          headers: inboundHeadersForCandidate(facts, env),
          payload,
        },
      }) as ProviderPipelineStreamOutcome<GeminiGenerateContentStreamEvent>;
      const outcome = await providerStreamOutcomeToChatOutcome(
        providerOutcome,
        candidate,
        targetApi,
        env,
        billableUsageFromGeminiGenerateContentEvent,
      );
      return outcome.type === 'events' ? outcome : normalizeGeminiChatFailure(outcome);
    }

    const request = { ...payload, model: candidate.modelId };
    const options = {
      sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: candidate.limits.max_output_tokens,
    };
    if (targetApi === 'anthropicMessages') {
      const trip = await routeGeminiGenerateContentViaAnthropicMessages(request, options);
      if (trip.type === 'input-error') return normalizeGeminiChatFailure(translatedInputError(trip, candidate, env));
      const inner = await next({
        'dispatch.plan': { type: 'translated', targetApi, candidate, headers: facts['request.inboundHeaders'], payload: trip.target },
      }) as ChatAttemptOutcome<import('@floway-dev/protocols/anthropic-messages').AnthropicMessagesStreamEventEx>;
      return normalizeGeminiChatFailure(applyTranslationTripToOutcome(env, trip, targetApi, inner));
    }
    if (targetApi === 'openaiChatCompletions') {
      const trip = await routeGeminiGenerateContentViaOpenAIChatCompletions(request, options);
      if (trip.type === 'input-error') return normalizeGeminiChatFailure(translatedInputError(trip, candidate, env));
      const inner = await next({
        'dispatch.plan': { type: 'translated', targetApi, candidate, headers: facts['request.inboundHeaders'], payload: trip.target },
      }) as ChatAttemptOutcome<import('@floway-dev/protocols/openai-chat-completions').OpenAIChatCompletionsStreamEvent>;
      return normalizeGeminiChatFailure(applyTranslationTripToOutcome(env, trip, targetApi, inner));
    }
    const trip = await routeGeminiGenerateContentViaOpenAIResponses(request, options);
    if (trip.type === 'input-error') return normalizeGeminiChatFailure(translatedInputError(trip, candidate, env));
    const inner = await next({
      'dispatch.plan': { type: 'translated', targetApi, candidate, headers: facts['request.inboundHeaders'], payload: trip.target },
    }) as ChatAttemptOutcome<import('@floway-dev/protocols/openai-responses').OpenAIResponsesStreamEventEx>;
    return normalizeGeminiChatFailure(applyTranslationTripToOutcome(env, trip, targetApi, inner));
  },
});

const selectGenerateDispatch = async (
  facts: Readonly<TargetFacts & { readonly 'dispatch.plan': GenerateDispatchPlan }>,
  env: StageEnv<ChatPipelineServices>,
): Promise<BoundDispatch<GenerateDispatchInnerOutcome, ChatPipelineServices>> => {
  const plan = facts['dispatch.plan'];
  if (plan.type === 'native') {
    const provider = env.providerFor(plan.candidate.upstreamId);
    const target = provider.pipelines?.geminiGenerateContent;
    if (target === undefined) throw new Error(`Provider ${plan.candidate.upstreamId} has no geminiGenerateContent pipeline`);
    return handoff(target, {
      'route.candidate': plan.candidate,
      'provider.model': plan.candidate.providerModel,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.payload,
      'request.action': 'generate',
    });
  }
  if (plan.targetApi === 'anthropicMessages') {
    const { anthropicMessagesAttemptPipeline } = await import('../anthropic-messages/attempt-pipeline.ts');
    return handoff(anthropicMessagesAttemptPipeline, {
      'route.candidate': plan.candidate,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.payload as AnthropicMessagesPayload,
      'request.anthropicBeta': [],
    });
  }
  if (plan.targetApi === 'openaiChatCompletions') {
    const { openaiChatCompletionsAttemptPipeline } = await import('../openai-chat-completions/attempt-pipeline.ts');
    return handoff(openaiChatCompletionsAttemptPipeline, {
      'route.candidate': plan.candidate,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.payload as OpenAIChatCompletionsPayloadEx,
    });
  }
  const { openaiResponsesAttemptPipeline } = await import('../openai-responses/attempt-pipeline.ts');
  return handoff(openaiResponsesAttemptPipeline, {
    'route.candidate': plan.candidate,
    'request.inboundHeaders': plan.headers,
    'request.payload': plan.payload as CanonicalOpenAIResponsesPayload,
    'request.action': 'generate',
  });
};

export const geminiGenerateContentAttemptPipeline: Pipeline<
  GeminiGenerateContentAttemptInput,
  ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  ChatPipelineServices
> = pipeline<GeminiGenerateContentAttemptInput>('gateway.gemini-generate-content.attempt')
  .use(createStripUnsupportedPartFieldsStage(geminiGenerateContentGenerateTarget))
  .use(stripUnsupportedTools)
  .use(stripSafetySettings)
  .use(suppressThoughtParts)
  .use(translateOrNative)
  .end(dispatch({
    name: 'gateway.gemini-generate-content.attempt.dispatch',
    select: selectGenerateDispatch,
  }));

type CountPlan =
  | {
    readonly type: 'native';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: GeminiGenerateContentPayload;
  }
  | {
    readonly type: 'translated';
    readonly candidate: RouteCandidate;
    readonly headers: readonly HeaderEntry[];
    readonly payload: AnthropicMessagesPayload;
  };

type CountDispatchInnerOutcome = HttpOutcome | ChatPlainOutcome;

const countTokensTranslateOrNative = defineStage<
  TargetFacts,
  { readonly 'dispatch.plan': CountPlan },
  CountDispatchInnerOutcome,
  GeminiCountTokensAttemptOutcome,
  never,
  ChatPipelineServices
>({
  name: 'countTokensTranslateOrNative',
  provides: ['dispatch.plan'],
  execute: async (facts: Readonly<TargetFacts>, next: (provided: { readonly 'dispatch.plan': CountPlan }) => Promise<CountDispatchInnerOutcome>, env: StageEnv<ChatPipelineServices>) => {
    const candidate = facts['route.candidate'];
    if (facts['route.targetApi'] === 'geminiGenerateContent') {
      const http = await next({
        'dispatch.plan': {
          type: 'native',
          candidate,
          headers: inboundHeadersForCandidate(facts, env),
          payload: facts['request.payload'],
        },
      }) as HttpOutcome;
      return await plainOutcomeFromHttpOutcome(http, candidate.upstreamId);
    }
    const trip = await routeGeminiGenerateContentViaAnthropicMessages(
      { ...facts['request.payload'], model: candidate.modelId },
      {
        sidecarCodec: env.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: candidate.limits.max_output_tokens,
      },
    );
    if (trip.type === 'input-error') {
      return normalizeGeminiChatFailure(translatedInputError(trip, candidate, env)) as GeminiCountTokensAttemptOutcome;
    }
    const { stream: _stream, ...target } = trip.target;
    const inner = await next({
      'dispatch.plan': {
        type: 'translated',
        candidate,
        headers: facts['request.inboundHeaders'],
        payload: target,
      },
    }) as ChatPlainOutcome;
    return reshapeAnthropicMessagesCountAsGeminiGenerateContent(inner);
  },
});

const selectCountDispatch = async (
  facts: Readonly<TargetFacts & { readonly 'dispatch.plan': CountPlan }>,
  env: StageEnv<ChatPipelineServices>,
): Promise<BoundDispatch<CountDispatchInnerOutcome, ChatPipelineServices>> => {
  const plan = facts['dispatch.plan'];
  if (plan.type === 'native') {
    const provider = env.providerFor(plan.candidate.upstreamId);
    const target = provider.pipelines?.geminiGenerateContentCountTokens;
    if (target === undefined) throw new Error(`Provider ${plan.candidate.upstreamId} has no geminiGenerateContentCountTokens pipeline`);
    return handoff(target, {
      'route.candidate': plan.candidate,
      'provider.model': plan.candidate.providerModel,
      'request.inboundHeaders': plan.headers,
      'request.payload': plan.payload,
      'request.action': 'countTokens',
    });
  }
  const { anthropicMessagesCountTokensAttemptPipeline } = await import('../anthropic-messages/attempt-pipeline.ts');
  return handoff(anthropicMessagesCountTokensAttemptPipeline, {
    'route.candidate': plan.candidate,
    'request.inboundHeaders': plan.headers,
    'request.payload': plan.payload,
    'request.anthropicBeta': [],
  });
};

const reshapeAnthropicMessagesCountAsGeminiGenerateContent = (result: ChatPlainOutcome): ChatPlainOutcome => {
  if (result.body === null && (result.http.status === 204 || result.http.status === 205 || result.http.status === 304)) {
    return result;
  }
  const text = new TextDecoder().decode(result.body ?? new Uint8Array());
  const jsonHeaders = Object.freeze([
    Object.freeze(['content-type', 'application/json'] as const),
    ...result.http.headers.filter(([name]) => name.toLowerCase() !== 'content-type'),
  ]);
  if (result.http.status !== 200) {
    return {
      ...result,
      http: { ...result.http, headers: jsonHeaders },
      body: new TextEncoder().encode(JSON.stringify({
        error: {
          code: result.http.status,
          message: text || 'Upstream token counting request failed.',
          status: gatewayErrorStatus(result.http.status),
        },
      })),
    };
  }
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch {}
  const counts = decoded !== null && typeof decoded === 'object'
    ? decoded as { input_tokens?: unknown; total_tokens?: unknown }
    : {};
  const totalTokens = typeof counts.input_tokens === 'number'
    ? counts.input_tokens
    : typeof counts.total_tokens === 'number'
      ? counts.total_tokens
      : null;
  if (totalTokens === null) {
    return {
      type: 'plain',
      http: {
        status: 502,
        headers: Object.freeze([Object.freeze(['content-type', 'application/json'] as const)]),
      },
      body: new TextEncoder().encode(
        JSON.stringify(geminiGenerateContentInternalErrorPayload(502, toInternalDebugError(new Error('Invalid upstream token counting response.')))),
      ),
    };
  }
  return {
    ...result,
    http: { ...result.http, headers: jsonHeaders },
    body: new TextEncoder().encode(JSON.stringify({ totalTokens })),
  };
};

export const geminiGenerateContentCountTokensAttemptPipeline: Pipeline<
  GeminiGenerateContentAttemptInput,
  GeminiCountTokensAttemptOutcome,
  ChatPipelineServices
> = pipeline<GeminiGenerateContentAttemptInput>('gateway.gemini-generate-content.count-tokens.attempt')
  .use(createStripUnsupportedPartFieldsStage(geminiGenerateContentCountTokensTarget))
  .use(stripUnsupportedTools)
  .use(stripSafetySettings)
  .use(countTokensTranslateOrNative)
  .end(dispatch({
    name: 'gateway.gemini-generate-content.count-tokens.dispatch',
    select: selectCountDispatch,
  }));
