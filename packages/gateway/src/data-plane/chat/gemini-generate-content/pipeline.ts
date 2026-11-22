import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import {
  geminiGenerateContentAttemptPipeline,
  geminiGenerateContentCountTokensAttemptPipeline,
  geminiGenerateContentCountTokensTarget,
  geminiGenerateContentGenerateTarget,
} from './attempt-pipeline.ts';
import type { GeminiCountTokensAttemptOutcome } from './attempt-pipeline.ts';
import { renderGeminiGenerateContentFailure, geminiGenerateContentInternalErrorPayload, normalizeGeminiChatFailure } from './errors.ts';
import { geminiGenerateContentCountOutcome, respondGeminiGenerateContentOutcome } from './respond.ts';
import { gatewayJsonOutcome, inboundHeaderEntriesFromHeaders, type DownstreamHttpOutcome } from '../../pipeline/index.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import {
  chatApiErrorToDownstreamOutcome,
  createChatEdgeHttpStage,
  failoverChatCandidates,
  selectRouteAffinityCandidates,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type ChatPlainOutcome,
} from '../pipeline/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { ProviderModelsUnavailableError, toInternalDebugError, type RouteCandidate } from '@floway-dev/provider';

export type GeminiGenerateContentPipelineInput = {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': GeminiGenerateContentPayload;
  readonly 'request.wantsStream': boolean;
};

export type GeminiGenerateContentCountTokensPipelineInput = {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': GeminiGenerateContentPayload;
};

type AffinityEntry = {
  readonly candidate: RouteCandidate;
  readonly payload: GeminiGenerateContentPayload;
};

const geminiFailureOutcome = (failure: ReturnType<typeof renderGeminiGenerateContentFailure>) =>
  ({
    type: 'api-error' as const,
    source: failure.source,
    http: {
      status: failure.http.status,
      headers: Object.freeze([...failure.http.headers.entries()].map(([name, value]) => Object.freeze([name, value] as const))),
    },
    body: failure.body,
  });

const geminiUnavailableOutcome = (
  error: unknown,
  env: import('@floway-dev/pipeline').StageEnv<ChatPipelineServices>,
): DownstreamHttpOutcome | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || error.httpResponse === null) return null;
  const normalized = normalizeGeminiChatFailure({
    type: 'api-error',
    source: 'upstream',
    http: {
      status: error.httpResponse.status,
      headers: inboundHeaderEntriesFromHeaders(error.httpResponse.headers),
    },
    body: new TextEncoder().encode(error.httpResponse.body),
  });
  if (normalized.type !== 'api-error') throw new Error('Provider model failure must normalize to api-error');
  return chatApiErrorToDownstreamOutcome(normalized, env);
};

const resolveGenerateCandidates = defineStage<
  GeminiGenerateContentPipelineInput,
  { readonly 'route.candidates': readonly AffinityEntry[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'gateway.gemini-generate-content.generate.resolveCandidates',
  provides: ['route.candidates'],
  execute: async (facts, next, env) => {
    const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(facts['request.model'], 'chat');
    const affinity = await analyzeGeminiGenerateContentAffinity(facts['request.payload'], env.affinity.codec);
    const selection = selectRouteAffinityCandidates(
      candidates.filter(candidate => geminiGenerateContentGenerateTarget.canServe(candidate.endpoints)),
      affinity,
    );
    if ('kind' in selection) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(geminiFailureOutcome(renderGeminiGenerateContentFailure(selection, 'generate')), env);
    }
    if (selection.entries.length === 0) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(
        geminiFailureOutcome(renderGeminiGenerateContentFailure(
          noViableCandidateFailure(sawModel, facts['request.model'], failedUpstreams),
          'generate',
        )),
        env,
      );
    }
    return await next({ 'route.candidates': selection.entries });
  },
});

const generateFailover = defineStage<
  GeminiGenerateContentPipelineInput & { readonly 'route.candidates': readonly AffinityEntry[] },
  { readonly 'route.candidate': RouteCandidate; readonly 'request.payload': GeminiGenerateContentPayload },
  ChatAttemptOutcome<GeminiGenerateContentStreamEvent>,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'gateway.gemini-generate-content.generate.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates({
      entries: facts['route.candidates'],
      invocationLabel: 'geminiGenerateContentServe.generate',
      env,
      selectAffinityOnEvents: true,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    env.affinity.select(selected.candidate);
    return await respondGeminiGenerateContentOutcome(selected.outcome, facts['request.wantsStream'], env);
  },
});

const onGenerateThrow = (error: unknown, env: import('@floway-dev/pipeline').StageEnv<ChatPipelineServices>): DownstreamHttpOutcome => {
  const unavailable = geminiUnavailableOutcome(error, env);
  if (unavailable !== null) return unavailable;
  recordFailedRequest(env.ctx, env.attempt.telemetry);
  env.attribution.recordFailure(error);
  return gatewayJsonOutcome(500, geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error)));
};

interface GenerateDispatchFacts extends GeminiGenerateContentPipelineInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': GeminiGenerateContentPayload;
}

export const geminiGenerateContentPipeline: Pipeline<
  GeminiGenerateContentPipelineInput,
  DownstreamHttpOutcome,
  ChatPipelineServices
> = pipeline<GeminiGenerateContentPipelineInput>('gateway.gemini-generate-content')
  .use(createChatEdgeHttpStage<GeminiGenerateContentPipelineInput>({
    name: 'gateway.gemini-generate-content.edge',
    onThrow: onGenerateThrow,
  }))
  .use(resolveGenerateCandidates)
  .use(generateFailover)
  .end(dispatch<GenerateDispatchFacts, ChatAttemptOutcome<GeminiGenerateContentStreamEvent>, ChatPipelineServices>({
    name: 'gateway.gemini-generate-content.dispatch',
    select: facts => handoff(geminiGenerateContentAttemptPipeline, {
      'route.candidate': facts['route.candidate'],
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': facts['request.payload'],
    }),
  }));

const resolveCountCandidates = defineStage<
  GeminiGenerateContentCountTokensPipelineInput,
  { readonly 'route.candidates': readonly AffinityEntry[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'gateway.gemini-generate-content.count.resolveCandidates',
  provides: ['route.candidates'],
  execute: async (facts, next, env) => {
    const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(facts['request.model'], 'chat');
    const affinity = await analyzeGeminiGenerateContentAffinity(facts['request.payload'], env.affinity.codec);
    const selection = selectRouteAffinityCandidates(
      candidates.filter(candidate => geminiGenerateContentCountTokensTarget.canServe(candidate.endpoints)),
      affinity,
    );
    if ('kind' in selection) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(geminiFailureOutcome(renderGeminiGenerateContentFailure(selection, 'countTokens')), env);
    }
    if (selection.entries.length === 0) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(
        geminiFailureOutcome(renderGeminiGenerateContentFailure(
          noViableCandidateFailure(sawModel, facts['request.model'], failedUpstreams),
          'countTokens',
        )),
        env,
      );
    }
    return await next({ 'route.candidates': selection.entries });
  },
});

const countFailover = defineStage<
  GeminiGenerateContentCountTokensPipelineInput & { readonly 'route.candidates': readonly AffinityEntry[] },
  { readonly 'route.candidate': RouteCandidate; readonly 'request.payload': GeminiGenerateContentPayload },
  GeminiCountTokensAttemptOutcome,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'gateway.gemini-generate-content.count.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates({
      entries: facts['route.candidates'],
      invocationLabel: 'geminiGenerateContentServe.countTokens',
      env,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    const outcome = selected.outcome;
    if (outcome.type === 'api-error') {
      return chatApiErrorToDownstreamOutcome(outcome, env);
    }
    return geminiGenerateContentCountOutcome(outcome as ChatPlainOutcome, env);
  },
});

interface CountDispatchFacts extends GeminiGenerateContentCountTokensPipelineInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': GeminiGenerateContentPayload;
}

export const geminiGenerateContentCountTokensPipeline: Pipeline<
  GeminiGenerateContentCountTokensPipelineInput,
  DownstreamHttpOutcome,
  ChatPipelineServices
> = pipeline<GeminiGenerateContentCountTokensPipelineInput>('gateway.gemini-generate-content.count-tokens')
  .use(createChatEdgeHttpStage<GeminiGenerateContentCountTokensPipelineInput>({
    name: 'gateway.gemini-generate-content.count-tokens.edge',
    onThrow: (error, env) => {
      const unavailable = geminiUnavailableOutcome(error, env);
      if (unavailable !== null) return unavailable;
      recordFailedRequest(env.ctx, env.attempt.telemetry);
      env.attribution.recordFailure(error);
      return gatewayJsonOutcome(500, geminiGenerateContentInternalErrorPayload(500, toInternalDebugError(error)));
    },
  }))
  .use(resolveCountCandidates)
  .use(countFailover)
  .end(dispatch<CountDispatchFacts, GeminiCountTokensAttemptOutcome, ChatPipelineServices>({
    name: 'gateway.gemini-generate-content.count-tokens.dispatch',
    select: facts => handoff(geminiGenerateContentCountTokensAttemptPipeline, {
      'route.candidate': facts['route.candidate'],
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': facts['request.payload'],
    }),
  }));
