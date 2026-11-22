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
import { parseDecimalString, type RerankSourceProtocol } from '@floway-dev/protocols/common';
import {
  parseRerankResponse,
  parseRerankUsage,
  renderRerankResponse,
  rerankRequestIncompatibility,
  type CanonicalRerankRequest,
  type CanonicalRerankResponse,
} from '@floway-dev/protocols/rerank';
import { readManagedBytes } from '@floway-dev/provider';
import type {
  ProviderPipelineRerankOutcome,
  RouteCandidate,
  TelemetryModelIdentity,
} from '@floway-dev/provider';

export interface RerankPipelineInput {
  readonly 'request.http': WireRequestSnapshot;
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.model': string;
  readonly 'request.payload': CanonicalRerankRequest;
}

interface RerankAttempt {
  readonly candidate: RouteCandidate;
  readonly outcome: ProviderPipelineRerankOutcome;
}

const settleRerank = (
  services: GatewayPipelineServices,
  performanceContext: PerformanceTelemetryContext,
  identity: TelemetryModelIdentity,
  usage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined,
  failed: boolean,
): void => {
  const quantities: UsageQuantities = {};
  if (usage?.searchUnits !== undefined) quantities.rerank_searches = parseDecimalString(String(usage.searchUnits));
  if (usage?.totalTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.totalTokens));
  const pricingFacts = usage?.totalTokens === undefined ? {} : { inputTokens: usage.totalTokens };
  services.ctx.backgroundScheduler(recordUsage(services.apiKeyId, identity, quantities, pricingFacts).catch(error => {
    console.error('Failed to record rerank usage:', error);
  }));
  recordPerformance(services.ctx, performanceContext, failed, 0, performance.now());
};

const unsupportedMessage = (model: string): string => `Model ${model} does not support rerank.`;

export const rerankPipeline = (
  sourceProtocol: RerankSourceProtocol,
): Pipeline<RerankPipelineInput, DownstreamHttpOutcome, GatewayPipelineServices> =>
  pipeline<RerankPipelineInput>('rerank')
    .use(edgeHttpStage<RerankPipelineInput>('gateway.rerank.edge'))
    .use(defineStage<
      RerankPipelineInput,
      { readonly 'route.candidates': readonly RouteCandidate[] },
      DownstreamHttpOutcome,
      DownstreamHttpOutcome,
      never,
      GatewayPipelineServices
    >({
      name: 'gateway.rerank.resolveCandidates',
      provides: ['route.candidates'],
      execute: async (facts, next, env) => {
        const model = facts['request.model'];
        const request = facts['request.payload'];
        const { candidates, sawModel, failedUpstreams } = await env.directory.enumerateCandidates(model, 'rerank');
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

        const routable = candidates.flatMap(candidate =>
          candidate.endpoints.rerank === undefined || candidate.providerModel.rerankTarget === undefined
            ? []
            : [{ candidate, target: candidate.providerModel.rerankTarget }]);
        if (routable.length === 0) {
          env.attribution.recordError('gateway');
          return gatewayApiErrorOutcome(appendFailedUpstreams(unsupportedMessage(model), failedUpstreams), 400);
        }

        const viable = routable.flatMap(({ candidate, target }) =>
          rerankRequestIncompatibility(target.protocol, request) === null ? [candidate] : []);
        if (viable.length === 0) {
          const reasons = [...new Set(routable.flatMap(({ target }) => {
            const reason = rerankRequestIncompatibility(target.protocol, request);
            return reason === null ? [] : [reason];
          }))];
          env.attribution.recordError('gateway');
          return gatewayApiErrorOutcome(
            `Model ${model} does not support this rerank request: ${reasons.join('; ')}.`,
            400,
          );
        }
        return await next({ 'route.candidates': Object.freeze(viable) });
      },
    }))
    .use(defineStage<
      RerankPipelineInput & { readonly 'route.candidates': readonly RouteCandidate[] },
      { readonly 'route.candidate': RouteCandidate },
      ProviderPipelineRerankOutcome,
      DownstreamHttpOutcome,
      'route.candidates',
      GatewayPipelineServices
    >({
      name: 'gateway.rerank.failover',
      consumes: ['route.candidates'],
      provides: ['route.candidate'],
      execute: async (facts, next, env) => {
        const winner = await failoverRouteCandidates<RerankAttempt>({
          candidates: facts['route.candidates'],
          invocationLabel: 'rerank',
          operation: 'rerank',
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
        const performance = routeCandidatePerformanceContext(env, candidate, 'rerank');
        const bytes = await readManagedBytes(outcome.http.body);

        if (outcome.http.status < 200 || outcome.http.status >= 300) {
          env.attribution.recordError('upstream', identity.upstream);
          settleRerank(env, performance, identity, undefined, true);
          return {
            status: outcome.http.status,
            statusText: outcome.http.statusText,
            headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
            body: bytes,
          };
        }

        const sameProtocol = sourceProtocol === outcome.target.protocol;
        let measuredUsage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined;
        try {
          let upstreamBody: unknown;
          try {
            upstreamBody = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          } catch (error) {
            if (!sameProtocol) throw error;
            console.warn(
              `rerank: failed to parse same-protocol 2xx upstream body for ${sourceProtocol}; usage row will be request-only`,
              error instanceof Error ? error.message : String(error),
            );
            env.attribution.recordSuccess(identity, null);
            settleRerank(env, performance, identity, undefined, false);
            return {
              status: outcome.http.status,
              statusText: outcome.http.statusText,
              headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
              body: bytes,
            };
          }
          try {
            measuredUsage = parseRerankUsage(outcome.target.protocol, upstreamBody);
          } catch (error) {
            if (!sameProtocol) throw error;
            console.warn(
              `rerank: failed to parse same-protocol usage for ${sourceProtocol}; usage row will be request-only`,
              error instanceof Error ? error.message : String(error),
            );
            env.attribution.recordSuccess(identity, null);
            settleRerank(env, performance, identity, undefined, false);
            return {
              status: outcome.http.status,
              statusText: outcome.http.statusText,
              headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
              body: bytes,
            };
          }
          if (sameProtocol) {
            env.attribution.recordSuccess(identity, null);
            settleRerank(env, performance, identity, measuredUsage, false);
            return {
              status: outcome.http.status,
              statusText: outcome.http.statusText,
              headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
              body: bytes,
            };
          }
          const canonical = parseRerankResponse(outcome.target.protocol, upstreamBody);
          const rendered = renderRerankResponse(sourceProtocol, outcome.target.protocol, canonical, facts['request.payload']);
          env.attribution.recordSuccess(identity, null);
          settleRerank(env, performance, identity, measuredUsage, false);
          return {
            status: outcome.http.status,
            statusText: outcome.http.statusText,
            headers: forwardedResponseHeaderEntries(outcome.http.headers, 'application/json'),
            body: new TextEncoder().encode(JSON.stringify(rendered)),
          };
        } catch (error) {
          env.attempt.telemetry = undefined;
          settleRerank(env, performance, identity, measuredUsage, true);
          throw error;
        }
      },
    }))
    .end(dispatch<
      RerankPipelineInput & { readonly 'route.candidate': RouteCandidate },
      ProviderPipelineRerankOutcome,
      GatewayPipelineServices
    >({
      name: 'gateway.rerank.dispatch',
      select: (facts, env) => {
        const candidate = facts['route.candidate'];
        const provider = env.providerFor(candidate.upstreamId);
        const target = provider.pipelines?.rerank;
        if (target === undefined) {
          throw new Error(`Provider ${candidate.upstreamId} has no rerank pipeline`);
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
