import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { decisionAttempt, type DecisionAttemptResult } from './attempt.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse, type GatewayCtx } from '../shared/gateway-ctx.ts';
import { iterateCandidates } from '../shared/iterate-candidates.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { recordFailedRequest, recordPerformance, type PerformanceTelemetryContext } from '../shared/telemetry/performance.ts';
import { recordUsage } from '../shared/telemetry/usage.ts';
import { forwardUpstreamResponse } from '../shared/upstream-response.ts';
import { parseDecimalString } from '@floway-dev/protocols/common';
import type { DecisionSourceProtocol } from '@floway-dev/protocols/common';
import { parseDecisionRequest, parseDecisionResponse, parseDecisionUsage, renderDecisionResponse, type ParsedDecisionRequest } from '@floway-dev/protocols/decision';
import { httpResponseToResponse, ProviderModelsUnavailableError, providerModelOf, toInternalDebugError } from '@floway-dev/provider';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

const apiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);

const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error('Decision request body must be valid JSON');
  }
};

// Floway bills decision models on input tokens only. A provider that reports no
// usage still records the request through recordPerformance.
const settleDecision = (
  ctx: GatewayCtx,
  performanceContext: PerformanceTelemetryContext,
  identity: TelemetryModelIdentity,
  usage: { inputTokens?: number } | undefined,
  failed: boolean,
): void => {
  const quantities: UsageQuantities = {};
  if (usage?.inputTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.inputTokens));
  const pricingFacts = usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens };
  ctx.backgroundScheduler(recordUsage(ctx.apiKeyId, identity, quantities, pricingFacts).catch(error => {
    console.error('Failed to record decision usage:', error);
  }));
  recordPerformance(ctx, performanceContext, failed, 0, performance.now());
};

const unsupportedMessage = (model: string): string => `Model ${model} does not support decision.`;

export const decision = (sourceProtocol: DecisionSourceProtocol) => async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  let parsedRequest: ParsedDecisionRequest;
  try {
    parsedRequest = parseDecisionRequest(sourceProtocol, parseJson(requestBody.bytes));
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

  let terminal: DecisionAttemptResult | undefined;
  let measuredUsage: { inputTokens?: number } | undefined;
  let usageSettled = false;
  try {
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      subject: ctx.user,
      upstreamIds: ctx.upstreamIds,
      randomizeUpstreams: ctx.randomizeUpstreams,
      model,
      kind: 'decision',
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
      return candidate.model.endpoints.decision === undefined || providerModel.decisionTarget === undefined
        ? []
        : [{ candidate, target: providerModel.decisionTarget }];
    });
    if (routable.length === 0) {
      ctx.dump?.error('gateway');
      return finalizeGatewayResponse(ctx, apiError(c, appendFailedUpstreams(unsupportedMessage(model), failedUpstreams), 400));
    }
    terminal = await iterateCandidates(
      routable.map(({ candidate }) => candidate),
      'decision',
      ctx,
      'decision',
      candidate => decisionAttempt(c, ctx, candidate, request),
    );

    if (!terminal.response.ok) {
      ctx.dump?.error('upstream', terminal.identity.upstream);
      settleDecision(ctx, terminal.performance, terminal.identity, undefined, true);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }

    const sameProtocol = sourceProtocol === terminal.target.protocol;
    let upstreamBody: Record<string, unknown>;
    try {
      upstreamBody = await terminal.response.clone().json() as Record<string, unknown>;
    } catch (error) {
      // A cross-dialect client cannot read the upstream's own body, so a
      // translation failure must surface instead of being forwarded as success.
      if (!sameProtocol) throw error;
      console.warn(
        `decision: failed to parse 2xx upstream body for ${model}; usage row will be request-only`,
        error instanceof Error ? error.message : String(error),
      );
      ctx.dump?.success(terminal.identity, null);
      settleDecision(ctx, terminal.performance, terminal.identity, undefined, false);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }
    measuredUsage = parseDecisionUsage(upstreamBody);
    if (sameProtocol) {
      ctx.dump?.success(terminal.identity, null);
      settleDecision(ctx, terminal.performance, terminal.identity, measuredUsage, false);
      usageSettled = true;
      return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response));
    }
    const canonical = parseDecisionResponse(terminal.target.protocol, upstreamBody);
    const rendered = renderDecisionResponse(sourceProtocol, canonical);
    ctx.dump?.success(terminal.identity, null);
    settleDecision(ctx, terminal.performance, terminal.identity, measuredUsage, false);
    usageSettled = true;
    return finalizeGatewayResponse(ctx, forwardUpstreamResponse(terminal.response, { body: JSON.stringify(rendered) }));
  } catch (error) {
    if (terminal !== undefined && !usageSettled) {
      settleDecision(ctx, terminal.performance, terminal.identity, measuredUsage, true);
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
