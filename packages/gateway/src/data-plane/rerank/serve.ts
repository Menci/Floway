import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../chat/shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../chat/shared/request-body.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { inboundHeadersForUpstream } from '../shared/inbound-headers.ts';
import { iterateCandidates } from '../shared/iterate-candidates.ts';
import { forwardUpstreamResponse } from '../shared/passthrough-serve.ts';
import { buildUpstreamCallOptions, telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attempt-helpers.ts';
import { recordFailedRequest, recordPerformance } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { enumerateModelCandidates } from '../providers/registry.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import type { PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import type { RerankTarget } from '@floway-dev/protocols/common';
import { parseRerankRequest, parseRerankResponse, renderRerankResponse, type CanonicalRerankRequest, type ParsedRerankRequest } from '@floway-dev/protocols/rerank';
import { httpResponseToResponse, ProviderModelsUnavailableError, providerModelOf, toInternalDebugError } from '@floway-dev/provider';
import type { ModelCandidate, ProviderRerankCallResult, TelemetryModelIdentity } from '@floway-dev/provider';

export type InboundRerankProtocol = 'cohere-v1' | 'cohere-v2' | 'jina-v1' | 'voyage-v1';

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
  searchUnits: number | undefined,
  failed: boolean,
): void => {
  const quantities = searchUnits === undefined ? {} : { input: searchUnits };
  const units = searchUnits === undefined ? {} : { input: 'searches_1k' as const };
  ctx.backgroundScheduler(recordUsage(ctx.apiKeyId, identity, quantities, units, {}).catch(error => {
    console.error('Failed to record rerank usage:', error);
  }));
  recordPerformance(ctx, performanceContext, failed, 0, performance.now());
};

const unsupportedMessage = (model: string): string => `Model ${model} does not support rerank.`;

export const rerank = (sourceProtocol: InboundRerankProtocol) => async (c: Context): Promise<Response> => {
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

    const viable = candidates.filter(candidate => {
      const providerModel = providerModelOf(candidate);
      return candidate.model.endpoints.rerank !== undefined && providerModel.rerankTarget !== undefined;
    });
    if (viable.length === 0) {
      ctx.dump?.error('gateway');
      return finalizeGatewayResponse(ctx, apiError(c, appendFailedUpstreams(unsupportedMessage(model), failedUpstreams), 400));
    }

    terminal = await iterateCandidates(
      viable,
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

    const upstreamBody = await terminal.response.clone().json() as unknown;
    const canonical = parseRerankResponse(terminal.target.protocol, upstreamBody);
    const rendered = renderRerankResponse(sourceProtocol, terminal.target.protocol, canonical, request);
    ctx.dump?.success(terminal.identity, null);
    settleRerank(ctx, terminal.performance, terminal.identity, canonical.searchUnits, false);
    usageSettled = true;
    const response = sourceProtocol === terminal.target.protocol
      ? forwardUpstreamResponse(terminal.response)
      : forwardUpstreamResponse(terminal.response, JSON.stringify(rendered));
    return finalizeGatewayResponse(ctx, response);
  } catch (error) {
    if (terminal !== undefined && !usageSettled) {
      settleRerank(ctx, terminal.performance, terminal.identity, undefined, true);
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
