import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { openaiChatCompletionsAttemptPipeline, openaiChatCompletionsTarget } from './attempt-pipeline.ts';
import { renderOpenAIChatCompletionsFailure } from './errors.ts';
import { respondOpenAIChatCompletionsOutcome } from './respond.ts';
import { gatewayJsonOutcome, type DownstreamHttpOutcome } from '../../pipeline/index.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-errors.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import {
  chatApiErrorToDownstreamOutcome,
  createChatEdgeHttpStage,
  failoverChatCandidates,
  providerModelsUnavailableOutcome,
  selectRouteAffinityCandidates,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
} from '../pipeline/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError, type RouteCandidate } from '@floway-dev/provider';

export type OpenAIChatCompletionsPipelineInput = {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': OpenAIChatCompletionsPayloadEx;
  readonly 'request.wantsStream': boolean;
  readonly 'request.includeUsageChunk': boolean;
  readonly 'request.expectedChoices': number;
};

const resolveCandidates = defineStage<
  OpenAIChatCompletionsPipelineInput,
  { readonly 'route.candidates': readonly { readonly candidate: RouteCandidate; readonly payload: OpenAIChatCompletionsPayloadEx }[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'gateway.openai-chat-completions.resolveCandidates',
  provides: ['route.candidates'],
  execute: async (facts, next, env) => {
    const payload = facts['request.payload'];
    const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(payload.model, 'chat');
    const affinity = await analyzeOpenAIChatCompletionsAffinity(payload, env.affinity.codec);
    const viable = candidates.filter(candidate => openaiChatCompletionsTarget.canServe(candidate.endpoints));
    const selection = selectRouteAffinityCandidates(viable, affinity);
    if ('kind' in selection) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(renderOpenAIChatCompletionsFailure(selection), env);
    }
    if (selection.entries.length === 0) {
      env.attribution.recordError('gateway');
      return chatApiErrorToDownstreamOutcome(
        renderOpenAIChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams)),
        env,
      );
    }
    return await next({ 'route.candidates': selection.entries });
  },
});

const failover = defineStage<
  OpenAIChatCompletionsPipelineInput & {
    readonly 'route.candidates': readonly { readonly candidate: RouteCandidate; readonly payload: OpenAIChatCompletionsPayloadEx }[];
  },
  { readonly 'route.candidate': RouteCandidate; readonly 'request.payload': OpenAIChatCompletionsPayloadEx },
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'gateway.openai-chat-completions.failover',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates({
      entries: facts['route.candidates'],
      invocationLabel: 'openaiChatCompletionsServe.generate',
      env,
      selectAffinityOnEvents: true,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    return await respondOpenAIChatCompletionsOutcome(selected.outcome, facts['request.wantsStream'], {
      includeUsageChunk: facts['request.includeUsageChunk'],
      expectedChoices: facts['request.expectedChoices'],
    }, env);
  },
});

interface DispatchFacts extends OpenAIChatCompletionsPipelineInput {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': OpenAIChatCompletionsPayloadEx;
}

export const openaiChatCompletionsPipeline: Pipeline<
  OpenAIChatCompletionsPipelineInput,
  DownstreamHttpOutcome,
  ChatPipelineServices
> = pipeline<OpenAIChatCompletionsPipelineInput>('gateway.openai-chat-completions')
  .use(createChatEdgeHttpStage<OpenAIChatCompletionsPipelineInput>({
    name: 'gateway.openai-chat-completions.edge',
    onThrow: (error, env) => {
      const relayed = providerModelsUnavailableOutcome(error, env);
      if (relayed !== null) return relayed;
      recordFailedRequest(env.ctx, env.attempt.telemetry);
      env.attribution.recordFailure(error);
      return gatewayJsonOutcome(502, openaiInternalErrorPayload(toInternalDebugError(error)));
    },
  }))
  .use(resolveCandidates)
  .use(failover)
  .end(dispatch<DispatchFacts, ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>, ChatPipelineServices>({
    name: 'gateway.openai-chat-completions.dispatch',
    select: (facts, _env) => handoff(openaiChatCompletionsAttemptPipeline, {
      'route.candidate': facts['route.candidate'],
      'request.inboundHeaders': facts['request.inboundHeaders'],
      'request.payload': facts['request.payload'],
    }),
  }));
