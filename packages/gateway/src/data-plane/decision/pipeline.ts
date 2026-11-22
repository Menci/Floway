import type { UsageQuantities } from '../../repo/types.ts';
import { edgeHttpStage, gatewayApiErrorOutcome, type DownstreamHttpOutcome } from '../pipeline/edge.ts';
import { failoverRouteCandidates, routeCandidateModelIdentity, routeCandidatePerformanceContext } from '../pipeline/failover.ts';
import { filterInboundHeaderEntries, forwardedResponseHeaderEntries } from '../pipeline/headers.ts';
import type { GatewayPipelineServices } from '../pipeline/services.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { recordPerformance, type PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { defineStage, dispatch, handoff, pipeline } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, WireRequestSnapshot } from '@floway-dev/pipeline';
import { parseDecimalString, parseJSONWithRawNumbers, type DecisionProtocol } from '@floway-dev/protocols/common';
import {
  parseDecisionResponse,
  parseDecisionUsage,
  renderDecisionResponse,
  type CanonicalDecisionRequest,
} from '@floway-dev/protocols/decision';
import { readManagedBytes } from '@floway-dev/provider';
import type {
  ProviderPipelineDecisionOutcome,
  RouteCandidate,
  TelemetryModelIdentity,
} from '@floway-dev/provider';

export interface DecisionPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': CanonicalDecisionRequest;
}

interface DecisionAttempt {
  readonly candidate: RouteCandidate;
  readonly outcome: ProviderPipelineDecisionOutcome;
}

const settleDecision = (
  services: GatewayPipelineServices,
  performanceContext: PerformanceTelemetryContext,
  identity: TelemetryModelIdentity,
  usage: { inputTokens?: number } | undefined,
  failed: boolean,
): void => {
  const quantities: UsageQuantities = {};
  if (usage?.inputTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.inputTokens));
  const pricingFacts = usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens };
  services.ctx.backgroundScheduler(recordUsage(services.apiKeyId, identity, quantities, pricingFacts).catch(error => {
    console.error('Failed to record decision usage:', error);
  }));
  recordPerformance(services.ctx, performanceContext, failed, 0, performance.now());
};

const unsupportedMessage = (model: string): string => `Model ${model} does not support decision.`;

export const decisionPipeline = (
  sourceProtocol: DecisionProtocol,
): Pipeline<DecisionPipelineInput, DownstreamHttpOutcome, GatewayPipelineServices> =>
  pipeline<DecisionPipelineInput>('decision')
    .use(edgeHttpStage<DecisionPipelineInput>('gateway.decision.edge'))
    .use(defineStage<
      DecisionPipelineInput,
      { readonly 'route.candidates': readonly RouteCandidate[] },
      DownstreamHttpOutcome,
      DownstreamHttpOutcome,
      never,
      GatewayPipelineServices
    >({
      name: 'gateway.decision.resolveCandidates',
      provides: ['route.candidates'],
      execute: async (facts, next, env) => {
        const model = facts['request.model'];
        const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(model, 'decision');
        if (candidates.length === 0) {
          env.attribution.recordError('gateway');
          return gatewayApiErrorOutcome(
            appendFailedUpstreams(
              sawModel
                ? unsupportedMessage(model)
                : `Model ${model} is not available on any configured upstream.`,
              failedUpstreams,
            ),
            sawModel ? 400 : 404,
          );
        }

        const viable = candidates.filter(candidate =>
          candidate.endpoints.decision !== undefined && candidate.providerModel.decisionTarget !== undefined);
        if (viable.length === 0) {
          env.attribution.recordError('gateway');
          return gatewayApiErrorOutcome(appendFailedUpstreams(unsupportedMessage(model), failedUpstreams), 400);
        }
        return await next({ 'route.candidates': Object.freeze(viable) });
      },
    }))
    .use(defineStage<
      DecisionPipelineInput & { readonly 'route.candidates': readonly RouteCandidate[] },
      { readonly 'route.candidate': RouteCandidate },
      ProviderPipelineDecisionOutcome,
      DownstreamHttpOutcome,
      'route.candidates',
      GatewayPipelineServices
    >({
      name: 'gateway.decision.failover',
      consumes: ['route.candidates'],
      provides: ['route.candidate'],
      execute: async (facts, next, env) => {
        const winner = await failoverRouteCandidates<DecisionAttempt>({
          candidates: facts['route.candidates'],
          invocationLabel: 'decision',
          operation: 'decision',
          env,
          run: async candidate => ({
            candidate,
            outcome: await next({ 'route.candidate': candidate }),
          }),
          inspect: result => ({
            success: result.outcome.http.status >= 200 && result.outcome.http.status < 300,
            headers: result.outcome.http.headers,
            discardStream: result.outcome.http.body,
          }),
        });
        const { candidate, outcome } = winner;
        const identity = routeCandidateModelIdentity(candidate, outcome.modelKey);
        const performance = routeCandidatePerformanceContext(env, candidate, 'decision');
        const bytes = await readManagedBytes(outcome.http.body);

        if (outcome.http.status < 200 || outcome.http.status >= 300) {
          env.attribution.recordError('upstream', identity.upstream);
          settleDecision(env, performance, identity, undefined, true);
          return {
            status: outcome.http.status,
            statusText: outcome.http.statusText,
            headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
            body: bytes,
          };
        }

        const sameProtocol = sourceProtocol === outcome.target.protocol;
        let measuredUsage: { inputTokens?: number } | undefined;
        try {
          let upstreamBody: Record<string, unknown>;
          try {
            upstreamBody = parseJSONWithRawNumbers(new TextDecoder().decode(bytes)) as Record<string, unknown>;
          } catch (error) {
            if (!sameProtocol) throw error;
            console.warn(
              `decision: failed to parse 2xx upstream body for ${facts['request.model']}; usage row will be request-only`,
              error instanceof Error ? error.message : String(error),
            );
            env.attribution.recordSuccess(identity, null);
            settleDecision(env, performance, identity, undefined, false);
            return {
              status: outcome.http.status,
              statusText: outcome.http.statusText,
              headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
              body: bytes,
            };
          }
          measuredUsage = parseDecisionUsage(upstreamBody);
          if (sameProtocol) {
            env.attribution.recordSuccess(identity, null);
            settleDecision(env, performance, identity, measuredUsage, false);
            return {
              status: outcome.http.status,
              statusText: outcome.http.statusText,
              headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
              body: bytes,
            };
          }
          const canonical = parseDecisionResponse(outcome.target.protocol, upstreamBody);
          const rendered = renderDecisionResponse(sourceProtocol, canonical);
          env.attribution.recordSuccess(identity, null);
          settleDecision(env, performance, identity, measuredUsage, false);
          return {
            status: outcome.http.status,
            statusText: outcome.http.statusText,
            headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
            body: new TextEncoder().encode(JSON.stringify(rendered)),
          };
        } catch (error) {
          env.attempt.telemetry = undefined;
          settleDecision(env, performance, identity, measuredUsage, true);
          throw error;
        }
      },
    }))
    .end(dispatch<
      DecisionPipelineInput & { readonly 'route.candidate': RouteCandidate },
      ProviderPipelineDecisionOutcome,
      GatewayPipelineServices
    >({
      name: 'gateway.decision.dispatch',
      select: (facts, env) => {
        const candidate = facts['route.candidate'];
        const provider = env.providerFor(candidate.upstreamId);
        const target = provider.pipelines?.decision;
        if (target === undefined) {
          throw new Error(`Provider ${candidate.upstreamId} has no decision pipeline`);
        }
        const filteredHeaders = filterInboundHeaderEntries(
          facts['request.inboundHeaders'],
          provider.inboundHeaderAllowlist,
        );
        return handoff(target, {
          'route.candidate': candidate,
          'provider.model': candidate.providerModel,
          'request.inboundHeaders': filteredHeaders,
          'request.payload': facts['request.payload'],
        });
      },
    }));
