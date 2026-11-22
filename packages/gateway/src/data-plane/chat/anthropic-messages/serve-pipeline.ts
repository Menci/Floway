import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';
import {
  anthropicMessagesAttemptPipeline,
  anthropicMessagesCountTokensAttemptPipeline,
  anthropicMessagesCountTokensTarget,
  anthropicMessagesGenerateTarget,
} from './attempt-pipeline.ts';
import { anthropicMessagesFailureOutcome } from './errors.ts';
import { internalAnthropicMessagesErrorPayload, renderAnthropicMessagesPipelineResponse } from './respond.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { buildDownstreamWireUrl, forwardedResponseHeaderEntries, gatewayJsonOutcome, type DownstreamHttpOutcome } from '../../pipeline/index.ts';
import { recordFailedRequest } from '../../shared/telemetry/performance.ts';
import {
  chatApiErrorToDownstreamOutcome,
  chatPlainToDownstreamOutcome,
  createChatEdgeHttpStage,
  failoverChatCandidates,
  providerModelsUnavailableOutcome,
  selectRouteAffinityCandidates,
  type ChatAttemptOutcome,
  type ChatPipelineServices,
  type ChatPlainOutcome,
} from '../pipeline/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import { serializeAnthropicMessagesStream, shouldSerializeStreamItems } from '../shared/stream-compatibility/index.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { toInternalDebugError } from '@floway-dev/provider';

export interface AnthropicMessagesServeFacts {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': WireRequestSnapshot['headers'];
  readonly 'request.payload': AnthropicMessagesPayload;
  readonly 'request.anthropicBeta': readonly string[];
}

interface AnthropicMessagesRouteCandidate {
  readonly candidate: import('@floway-dev/provider').RouteCandidate;
  readonly payload: AnthropicMessagesPayload;
}

interface AnthropicMessagesPreparedFacts extends AnthropicMessagesServeFacts {
  readonly 'route.candidates': readonly AnthropicMessagesRouteCandidate[];
}

interface AnthropicMessagesAttemptFacts extends AnthropicMessagesServeFacts {
  readonly 'route.candidate': import('@floway-dev/provider').RouteCandidate;
  readonly 'request.payload': AnthropicMessagesPayload;
}

const internalErrorOutcome = (error: unknown, env: import('@floway-dev/pipeline').StageEnv<ChatPipelineServices>): DownstreamHttpOutcome => {
  const verbatim = providerModelsUnavailableOutcome(error, env);
  if (verbatim !== null) return verbatim;
  recordFailedRequest(env.ctx, env.attempt.telemetry);
  env.attribution.recordFailure(error);
  return gatewayJsonOutcome(502, internalAnthropicMessagesErrorPayload(toInternalDebugError(error)));
};

const resolveGenerateCandidates = defineStage<
  AnthropicMessagesServeFacts,
  { readonly 'route.candidates': readonly AnthropicMessagesRouteCandidate[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'anthropic-messages.resolve.generate',
  provides: ['route.candidates'],
  execute: async (facts, _next, env) => {
    const payload = facts['request.payload'];
    const enumerated = await env.directory.enumerateCandidates(payload.model, 'chat');
    const affinity = await analyzeAnthropicMessagesAffinity(payload, env.affinity.codec);
    const viable = enumerated.candidates.filter(candidate => anthropicMessagesGenerateTarget.canServe(candidate.endpoints));
    const selection = selectRouteAffinityCandidates(viable, affinity);
    if ('kind' in selection) return chatApiErrorToDownstreamOutcome(anthropicMessagesFailureOutcome(selection, 'generate'), env);
    if (selection.entries.length === 0) {
      return chatApiErrorToDownstreamOutcome(
        anthropicMessagesFailureOutcome(noViableCandidateFailure(enumerated.sawModel, payload.model, enumerated.failedUpstreams), 'generate'),
        env,
      );
    }

    return await _next({ 'route.candidates': selection.entries });
  },
});

const failoverGenerateCandidates = defineStage<
  AnthropicMessagesPreparedFacts,
  Pick<AnthropicMessagesAttemptFacts, 'route.candidate' | 'request.payload'>,
  ChatAttemptOutcome<AnthropicMessagesStreamEventEx>,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'anthropic-messages.failover.generate',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates<ChatAttemptOutcome<AnthropicMessagesStreamEventEx>>({
      entries: facts['route.candidates'],
      invocationLabel: 'anthropicMessagesServe.generate',
      env,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });

    const outcome = selected.outcome;
    if (outcome.type === 'api-error') return chatApiErrorToDownstreamOutcome(outcome, env);
    if (outcome.type === 'internal-error') {
      recordFailedRequest(env.ctx, outcome.performance);
      env.attribution.recordFailure(outcome.error.message);
      return gatewayJsonOutcome(
        outcome.http.status,
        internalAnthropicMessagesErrorPayload(outcome.error),
        forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
      );
    }
    if (outcome.type === 'plain') return chatPlainToDownstreamOutcome(outcome, env);

    const userAgent = facts['request.inboundHeaders'].find(([name]) => name.toLowerCase() === 'user-agent')?.[1];
    const serialize = shouldSerializeStreamItems(
      new Set(selected.candidate.providerModel.enabledFlags),
      'anthropicMessages',
      typeof userAgent === 'string' ? userAgent : null,
    );
    const events = env.wrapStream(outcome.events, {
      label: 'anthropic-messages.serialized.events',
      transform: source => serializeAnthropicMessagesStream(source, serialize),
    });
    return await renderAnthropicMessagesPipelineResponse({ ...outcome, events }, env);
  },
});

export const anthropicMessagesGeneratePipeline: Pipeline<AnthropicMessagesServeFacts, DownstreamHttpOutcome, ChatPipelineServices> =
  pipeline<AnthropicMessagesServeFacts>('gateway.anthropic-messages.generate')
    .use(createChatEdgeHttpStage({
      name: 'anthropic-messages.edge.generate',
      onThrow: internalErrorOutcome,
    }))
    .use(resolveGenerateCandidates)
    .use(failoverGenerateCandidates)
    .end(dispatch<AnthropicMessagesAttemptFacts, ChatAttemptOutcome<AnthropicMessagesStreamEventEx>, ChatPipelineServices>({
      name: 'anthropic-messages.generate.dispatch',
      select: facts => handoff(anthropicMessagesAttemptPipeline, {
        'route.candidate': facts['route.candidate'],
        'request.inboundHeaders': facts['request.inboundHeaders'],
        'request.payload': facts['request.payload'],
        'request.anthropicBeta': facts['request.anthropicBeta'],
      }),
    }));

const resolveCountTokensCandidates = defineStage<
  AnthropicMessagesServeFacts,
  { readonly 'route.candidates': readonly AnthropicMessagesRouteCandidate[] },
  DownstreamHttpOutcome,
  DownstreamHttpOutcome,
  never,
  ChatPipelineServices
>({
  name: 'anthropic-messages.resolve.count-tokens',
  provides: ['route.candidates'],
  execute: async (facts, _next, env) => {
    const payload = facts['request.payload'];
    const enumerated = await env.directory.enumerateCandidates(payload.model, 'chat');
    const affinity = await analyzeAnthropicMessagesAffinity(payload, env.affinity.codec);
    const viable = enumerated.candidates.filter(candidate => anthropicMessagesCountTokensTarget.canServe(candidate.endpoints));
    const selection = selectRouteAffinityCandidates(viable, affinity);
    if ('kind' in selection) return chatApiErrorToDownstreamOutcome(anthropicMessagesFailureOutcome(selection, 'countTokens'), env);
    if (selection.entries.length === 0) {
      return chatApiErrorToDownstreamOutcome(
        anthropicMessagesFailureOutcome(noViableCandidateFailure(enumerated.sawModel, payload.model, enumerated.failedUpstreams), 'countTokens'),
        env,
      );
    }
    return await _next({ 'route.candidates': selection.entries });
  },
});

const failoverCountTokensCandidates = defineStage<
  AnthropicMessagesPreparedFacts,
  Pick<AnthropicMessagesAttemptFacts, 'route.candidate' | 'request.payload'>,
  ChatPlainOutcome,
  DownstreamHttpOutcome,
  'route.candidates',
  ChatPipelineServices
>({
  name: 'anthropic-messages.failover.count-tokens',
  consumes: ['route.candidates'],
  provides: ['route.candidate', 'request.payload'],
  execute: async (facts, next, env) => {
    const selected = await failoverChatCandidates<ChatPlainOutcome>({
      entries: facts['route.candidates'],
      invocationLabel: 'anthropicMessagesServe.countTokens',
      selectAffinityOnEvents: false,
      env,
      run: entry => next({ 'route.candidate': entry.candidate, 'request.payload': entry.payload }),
    });
    return chatPlainToDownstreamOutcome(selected.outcome, env);
  },
});

export const anthropicMessagesCountTokensPipeline: Pipeline<AnthropicMessagesServeFacts, DownstreamHttpOutcome, ChatPipelineServices> =
  pipeline<AnthropicMessagesServeFacts>('gateway.anthropic-messages.count-tokens')
    .use(createChatEdgeHttpStage({
      name: 'anthropic-messages.edge.count-tokens',
      onThrow: internalErrorOutcome,
    }))
    .use(resolveCountTokensCandidates)
    .use(failoverCountTokensCandidates)
    .end(dispatch<AnthropicMessagesAttemptFacts, ChatPlainOutcome, ChatPipelineServices>({
      name: 'anthropic-messages.count-tokens.dispatch',
      select: facts => handoff(anthropicMessagesCountTokensAttemptPipeline, {
        'route.candidate': facts['route.candidate'],
        'request.inboundHeaders': facts['request.inboundHeaders'],
        'request.payload': facts['request.payload'],
        'request.anthropicBeta': facts['request.anthropicBeta'],
      }),
    }));

export const anthropicMessagesServeFacts = (
  c: AuthedContext,
  payload: AnthropicMessagesPayload,
  headers: readonly import('@floway-dev/pipeline').HeaderEntry[],
  anthropicBeta: readonly string[],
): AnthropicMessagesServeFacts => {
  return {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers,
      body: payload,
      protocol: 'anthropic-messages',
    },
    'request.inboundHeaders': headers,
    'request.payload': payload,
    'request.anthropicBeta': anthropicBeta,
  };
};
