// Shared serve scaffold for passthrough data-plane endpoints. These
// bypass the chat source/target executor because they have no protocol
// translation — the request body is forwarded to the chosen provider's
// matching endpoint and the upstream response is passed through back to
// the client. The JSON path extracts one usage block; endpoint-owned
// response strategies handle streaming and specialized media types.
// Usage and request-performance writes are scheduled through the
// runtime's background scheduler so transient repo failures cannot turn a
// successful 200 from upstream into a 502.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { PassthroughServeApiName } from './api-names.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { iterateCandidates } from './iterate-candidates.ts';
import { passthroughAttempt } from './passthrough-attempt.ts';
import { recordFailedRequest } from './telemetry/performance.ts';
import { settle } from './telemetry/settle.ts';
import { forwardUpstreamResponse } from './upstream-response.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { TokenUsage } from '../../repo/types.ts';
import { enumerateModelCandidates } from '../providers/resolution.ts';
import type { ModelKind } from '@floway-dev/protocols/common';
import { toInternalDebugError } from '@floway-dev/provider';
import type { PerformanceOperation, PerformanceTelemetryContext, Provider, ProviderCallResult, ProviderModel, TelemetryModelIdentity, UpstreamCallOptions } from '@floway-dev/provider';

type PassthroughResponseHandling =
  | {
    readonly format: 'json';
    readonly extractBilling: (body: unknown) => TokenUsage | null;
  }
  | {
    readonly format: 'strategy';
    readonly respond: (context: PassthroughResponseStrategyContext) => Response | Promise<Response>;
  };

export interface PassthroughResponseStrategyContext {
  readonly c: AuthedContext;
  readonly ctx: GatewayCtx;
  readonly sourceApi: PassthroughServeApiName;
  readonly response: Response;
  readonly performance: PerformanceTelemetryContext;
  readonly identity: TelemetryModelIdentity;
}

interface PassthroughServeContext {
  readonly c: AuthedContext;
  readonly ctx: GatewayCtx;
  readonly sourceApi: PassthroughServeApiName;
  readonly operation: PerformanceOperation;
  // Already-validated public model id the client requested. The helper
  // resolves it against the provider registry; if no upstream serves the
  // id with the requested kind, the client sees a 404 with the standard
  // wording.
  readonly model: string;
  // The model kind this endpoint serves. The resolver filters candidates
  // to `model.kind === kind`; `sawModel=true && candidates=[]` becomes
  // the "model exists but doesn't support this endpoint" 400.
  readonly kind: ModelKind;
  readonly modelServesEndpoint: (model: ProviderModel) => boolean;
  // Any throw here is preserved and becomes a 502 with the internal-debug
  // envelope. `model` is the emitting upstream's `ProviderModel`.
  readonly call: (provider: Provider, model: ProviderModel, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
  readonly response: PassthroughResponseHandling;
}

// Uniform error envelope for this endpoint family.
export const passthroughApiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);

export const passthroughServe = async (input: PassthroughServeContext): Promise<Response> => {
  const { c, ctx, sourceApi, operation, model, kind, modelServesEndpoint, call, response: responseHandling } = input;

  try {
    // The shared resolver returns every candidate of the requested kind:
    // unprefixed + prefixed addressable surfaces fan out across upstreams,
    // and the kind filter rejects models of the wrong family before they
    // reach the endpoint check below. Iteration order follows configured
    // sort_order across upstreams, with the unprefixed branch pushed before
    // the prefixed one within a single upstream. The first candidate whose
    // endpoint-key check passes wins.
    //
    // Alias resolution is a top-of-chain step inside the resolver: an alias
    // id walks every target in `selection` order, tags each returned
    // candidate with that target's rule overlay, and dedups across the
    // flattened list. Passthrough endpoints never consult that overlay, so
    // whatever rules a target carries are inert here — the alias flow only
    // changes which id the gateway addresses upstream.
    const { candidates, sawModel } = await enumerateModelCandidates({
      subject: ctx.user,
      upstreamIds: ctx.upstreamIds,
      randomizeUpstreams: ctx.randomizeUpstreams,
      model,
      kind,
      runtimeLocation: ctx.runtimeLocation,
    });
    if (candidates.length === 0) {
      ctx.dump?.error('gateway');
      return sawModel
        ? passthroughApiError(c, `Model ${model} does not support the ${sourceApi} endpoint.`, 400)
        : passthroughApiError(c, `Model ${model} is not available on any configured upstream.`, 404);
    }

    const viable = candidates.filter(c => modelServesEndpoint(c.model));
    if (viable.length === 0) {
      ctx.dump?.error('gateway');
      return passthroughApiError(c, `Model ${model} does not support the ${sourceApi} endpoint.`, 400);
    }

    // Iterate the viable list. Each candidate's attempt runs the upstream
    // HTTP call and records performance telemetry; the shared
    // iterator returns the first 2xx or, on exhaustion, the selected failure
    // with the earliest retry hint preferred. Request-perf and dump attribution
    // wait until this point so they land against the selected candidate.
    const result = await iterateCandidates(
      viable,
      'passthroughServe',
      ctx,
      operation,
      candidate => passthroughAttempt({
        c, ctx, candidate, operation,
        call,
      }),
    );
    const { http: response, performance: performanceContext, identity } = result;

    if (responseHandling.format === 'strategy') {
      return await responseHandling.respond({ c, ctx, sourceApi, response, performance: performanceContext, identity });
    }

    if (!response.ok) {
      // Exhausted — forward the selected upstream response verbatim so clients
      // still see real upstream telemetry (status, retry-after, request-id,
      // ...) rather than a synthetic gateway envelope.
      recordFailedRequest(ctx, performanceContext);
      ctx.dump?.error('upstream', identity.upstream);
      return forwardUpstreamResponse(response);
    }

    // A metering failure does not invalidate the upstream HTTP response.
    let parsed: unknown;
    try {
      parsed = await response.clone().json();
    } catch (e) {
      console.warn(`passthrough-serve: failed to parse 2xx upstream body for ${sourceApi}; usage row will be skipped`, e instanceof Error ? e.message : String(e));
      parsed = undefined;
    }
    const usage = parsed !== undefined ? responseHandling.extractBilling(parsed) : null;
    ctx.dump?.success(identity, usage);
    settle(ctx, performanceContext, identity, usage, false);
    return forwardUpstreamResponse(response);
  } catch (e) {
    // Attributes to whichever candidate iterateCandidates was on (or short-circuits if none started).
    recordFailedRequest(ctx, ctx.attempt.telemetry);
    ctx.dump?.failed(e);
    return c.json({ error: toInternalDebugError(e) }, 502);
  }
};
