import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { UsageQuantities } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../chat/shared/request-body.ts';
import { enumerateModelCandidates } from '../providers/registry.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { inboundHeadersForUpstream } from '../shared/inbound-headers.ts';
import { iterateCandidates } from '../shared/iterate-candidates.ts';
import { buildUpstreamCallOptions, telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attempt-helpers.ts';
import { recordFailedRequest, recordPerformance, type PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { canonicalDecimalString, type RerankSourceProtocol, type RerankTarget } from '@floway-dev/protocols/common';
import { parseRerankRequest, parseRerankResponse, parseRerankUsage, renderRerankResponse, rerankRequestIncompatibility, type CanonicalRerankRequest, type CanonicalRerankResponse, type ParsedRerankRequest } from '@floway-dev/protocols/rerank';
import { httpResponseToResponse, ProviderModelsUnavailableError, providerModelOf, toInternalDebugError } from '@floway-dev/provider';
import type { ModelCandidate, ProviderRerankCallResult, TelemetryModelIdentity } from '@floway-dev/provider';

interface RerankAttemptResult {
  readonly type: 'plain';
  readonly status: number;
  readonly response: Response;
  readonly target: RerankTarget;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
}

const apiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Rerank request body must be valid JSON');
  }
};

const attemptRerank = async (
  c: Context,
  ctx: GatewayCtx,
  candidate: ModelCandidate,
  request: CanonicalRerankRequest,
): Promise<RerankAttemptResult> => {
  const model = providerModelOf(candidate);
  const result: ProviderRerankCallResult = await candidate.provider.instance.callRerank(
    model,
    request,
    ctx.abortSignal,
    buildUpstreamCallOptions(candidate, ctx, inboundHeadersForUpstream(c)),
  );
  return {
    type: 'plain',
    status: result.response.status,
    response: result.response,
    target: result.target,
    performance: upstreamPerformanceContext(ctx, candidate, 'rerank'),
    identity: telemetryModelIdentity(candidate, result.modelKey),
  };
};

const settleRerank = (
  ctx: GatewayCtx,
  performanceContext: PerformanceTelemetryContext,
  identity: TelemetryModelIdentity,
  usage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined,
  failed: boolean,
): void => {
  const quantities: UsageQuantities = {};
  if (usage?.searchUnits !== undefined) quantities.rerank_searches = canonicalDecimalString(String(usage.searchUnits));
  if (usage?.totalTokens !== undefined) quantities.input_tokens = canonicalDecimalString(String(usage.totalTokens));
  const pricingFacts = usage?.totalTokens === undefined ? {} : { inputTokens: usage.totalTokens };
  ctx.backgroundScheduler(recordUsage(ctx.apiKeyId, identity, quantities, pricingFacts).catch(error => {
    console.error('Failed to record rerank usage:', error);
  }));
  recordPerformance(ctx, performanceContext, failed, 0, performance.now());
};

const unsupportedMessage = (model: string): string => `Model ${model} does not support rerank.`;

export const rerank = (sourceProtocol: RerankSourceProtocol) => async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  let parsedRequest: ParsedRerankRequest;
  try {
    parsedRequest = parseRerankRequest(sourceProtocol, parseJson(requestBody.bytes));
  } catch (error) {
    const ctx = createGatewayCtxFromHono(c, {
      wantsStream: false,
      requestBody: takeRequestBody(requestBody),
      backgroundScheduler: backgroundSchedulerFromContext(c),
    });
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, apiError(c, error instanceof Error ? error.message : String(error), 400));
  }

  const { model, request } = parsedRequest;
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    model,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });

  let terminal: RerankAttemptResult | undefined;
  let measuredUsage: Pick<CanonicalRerankResponse, 'searchUnits' | 'totalTokens'> | undefined;
  let usageSettled = false;
  try {
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'rerank',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    if (candidates.length === 0) {
      ctx.dump?.error('gateway');
      const message = sawModel
        ? unsupportedMessage(model)
        : `Model ${model} is not available on any configured upstream.`;
      return finalizeGatewayResponse(ctx, apiError(c, appendFailedUpstreams(message, failedUpstreams), sawModel ? 400 : 404));
    }

    const routable = candidates.flatMap(candidate => {
      const providerModel = providerModelOf(candidate);
      return candidate.model.endpoints.rerank === undefined || providerModel.rerankTarget === undefined
        ? []
        : [{ candidate, target: providerModel.rerankTarget }];
    });
    if (routable.length === 0) {
      ctx.dump?.error('gateway');
      return finalizeGatewayResponse(ctx, apiError(c, appendFailedUpstreams(unsupportedMessage(model), failedUpstreams), 400));
    }
    const viable = routable.filter(({ target }) => rerankRequestIncompatibility(target.protocol, request) === null);
    if (viable.length === 0) {
      const reasons = [...new Set(routable.flatMap(({ target }) => {
        const reason = rerankRequestIncompatibility(target.protocol, request);
        return reason === null ? [] : [reason];
      }))];
      ctx.dump?.error('gateway');
      return finalizeGatewayResponse(ctx, apiError(c, `Model ${model} does not support this rerank request: ${reasons.join('; ')}.`, 400));
    }

    terminal = await iterateCandidates(
      viable.map(({ candidate }) => candidate),
      'rerank',
      ctx,
      'rerank',
      candidate => attemptRerank(c, ctx, candidate, request),
    );

    if (!terminal.response.ok) {
      ctx.dump?.error('upstream', terminal.identity.upstream);
      settleRerank(ctx, terminal.performance, terminal.identity, undefined, true);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }

    const sameProtocol = sourceProtocol === terminal.target.protocol;
    let upstreamBody: unknown;
    try {
      upstreamBody = await terminal.response.clone().json() as unknown;
    } catch (error) {
      if (!sameProtocol) throw error;
      console.warn(
        `rerank: failed to parse same-protocol 2xx upstream body for ${sourceProtocol}; usage row will be request-only`,
        error instanceof Error ? error.message : String(error),
      );
      ctx.dump?.success(terminal.identity, null);
      settleRerank(ctx, terminal.performance, terminal.identity, undefined, false);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }
    try {
      measuredUsage = parseRerankUsage(terminal.target.protocol, upstreamBody);
    } catch (error) {
      if (!sameProtocol) throw error;
      console.warn(
        `rerank: failed to parse same-protocol usage for ${sourceProtocol}; usage row will be request-only`,
        error instanceof Error ? error.message : String(error),
      );
      ctx.dump?.success(terminal.identity, null);
      settleRerank(ctx, terminal.performance, terminal.identity, undefined, false);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }
    if (sameProtocol) {
      ctx.dump?.success(terminal.identity, null);
      settleRerank(ctx, terminal.performance, terminal.identity, measuredUsage, false);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }
    const canonical = parseRerankResponse(terminal.target.protocol, upstreamBody);
    const rendered = renderRerankResponse(sourceProtocol, terminal.target.protocol, canonical, request);
    ctx.dump?.success(terminal.identity, null);
    settleRerank(ctx, terminal.performance, terminal.identity, measuredUsage, false);
    usageSettled = true;
    return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response, { body: JSON.stringify(rendered) }));
  } catch (error) {
    if (terminal !== undefined && !usageSettled) {
      settleRerank(ctx, terminal.performance, terminal.identity, measuredUsage, true);
    } else if (terminal === undefined) {
      recordFailedRequest(ctx, ctx.attempt.telemetry);
    }
    if (error instanceof ProviderModelsUnavailableError) {
      const forwarded = httpResponseToResponse(error.httpResponse);
      if (forwarded) {
        ctx.dump?.error('upstream');
        return finalizeGatewayResponse(ctx, forwarded);
      }
    }
    ctx.dump?.failed(error);
    return finalizeGatewayResponse(ctx, c.json({ error: toInternalDebugError(error) }, 502));
  }
};
