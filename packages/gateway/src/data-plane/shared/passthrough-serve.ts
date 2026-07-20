// Shared serve scaffold for passthrough data-plane endpoints. These
// bypass the chat source/target executor because they have no protocol
// translation — the request body is forwarded to the chosen provider's
// matching endpoint and the upstream response is passed through back to
// the client. Embeddings and images run the `json` branch (single-shot
// body, OpenAI-shape `usage` block); /v1/completions runs the `sse` branch
// (frame-level transformFrame closure + settleUsage). Usage and
// request-performance writes are scheduled through the runtime's
// background scheduler so transient repo failures cannot turn a
// successful 200 from upstream into a 502.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { PassthroughServeApiName } from './api-names.ts';
import { appendFailedUpstreams } from './failed-upstreams.ts';
import { iterateCandidates } from './iterate-candidates.ts';
import { passthroughAttempt } from './passthrough-attempt.ts';
import { recordFailedRequest } from './telemetry/performance.ts';
import { settle } from './telemetry/settle.ts';
import { forwardUpstreamHeaders, forwardUpstreamResponse } from './upstream-response.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../chat/shared/stream/sse.ts';
import { enumerateModelCandidates } from '../providers/registry.ts';
import { doneFrame, eventFrame, type ModelKind, parseSSEStream, parseTargetStreamFrames, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { httpResponseToResponse, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import type { PerformanceOperation, InternalModel, Provider, ProviderCallResult, ProviderModel, UpstreamCallOptions } from '@floway-dev/provider';

// `json` (embeddings, images): single-shot body, `extractBilling` reads
// usage / metadata off the parsed root. `sse` (/v1/completions): frame
// stream, `transformFrame` mutates or drops frames (return null), then
// `settleUsage` reports billing once the stream ends.
type PassthroughResponseHandling =
  | {
    readonly format: 'json';
    readonly extractBilling: (body: unknown) => TokenUsage | null;
  }
  | {
    readonly format: 'sse';
    readonly transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null;
    readonly settleUsage: () => TokenUsage | null;
  };

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
  // Endpoint-availability gate against a resolved candidate's `InternalModel`.
  // Reads `.endpoints` on the candidate — the row narrows to exactly one
  // contributing upstream, so those endpoints come verbatim from the emitting
  // upstream's `ProviderModel`.
  readonly modelServesEndpoint: (model: InternalModel) => boolean;
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
    // a dated-suffix retry catches `-YYYYMMDD` ids the catalog only lists
    // in base form, and the kind filter rejects models of the wrong
    // family before they reach the endpoint check below. Iteration order
    // follows configured sort_order across upstreams, with the unprefixed
    // branch pushed before the prefixed one within a single upstream.
    // The first candidate whose endpoint-key check passes wins.
    //
    // Alias resolution is a top-of-chain step inside the resolver: an alias
    // id walks every target in `selection` order, tags each returned
    // candidate with that target's rule overlay, and dedups across the
    // flattened list. Passthrough aliases carry empty rules, so the tag
    // is a no-op in practice — the alias flow only changes which id the
    // gateway addresses upstream.
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind,
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    if (candidates.length === 0) {
      ctx.dump?.error('gateway');
      // `sawModel === false` means no upstream catalog knew the inbound id
      // at all (404); `sawModel === true` with zero candidates means the
      // id is known but every match was the wrong kind for this endpoint
      // (400), which mirrors the empty-viable case below.
      return sawModel
        ? passthroughApiError(c, appendFailedUpstreams(`Model ${model} does not support the ${sourceApi} endpoint.`, failedUpstreams), 400)
        : passthroughApiError(c, appendFailedUpstreams(`Model ${model} is not available on any configured upstream.`, failedUpstreams), 404);
    }

    // Endpoint-level pre-filter: drop candidates whose upstream model
    // exists for the requested kind but doesn't expose this endpoint's
    // specific capability (e.g. an embeddings-kind model on an upstream
    // that only exposes chat). An empty viable set is the same "model
    // exists but no upstream serves this endpoint" 400 the empty-candidate
    // branch above surfaces.
    const viable = candidates.filter(c => modelServesEndpoint(c.model));
    if (viable.length === 0) {
      ctx.dump?.error('gateway');
      return passthroughApiError(c, appendFailedUpstreams(`Model ${model} does not support the ${sourceApi} endpoint.`, failedUpstreams), 400);
    }

    // Iterate the viable list. Each candidate's attempt runs the upstream
    // HTTP call and records performance telemetry; the shared
    // iterator returns the first 2xx or, on exhaustion, the last non-2xx
    // result. Request-perf and dump attribution wait until this point so
    // they land against the terminal candidate.
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
    const { response, performance: performanceContext, identity } = result;

    if (!response.ok) {
      // Exhausted — forward the last upstream response verbatim so clients
      // still see real upstream telemetry (status, retry-after, request-id,
      // ...) rather than a synthetic gateway envelope.
      recordFailedRequest(ctx, performanceContext);
      ctx.dump?.error('upstream', identity.upstream);
      return forwardUpstreamResponse(response);
    }

    if (responseHandling.format === 'json') {
      // A 2xx body that fails to parse must not 502 a client whose
      // upstream call already succeeded; we skip usage extraction and
      // log so missing rows stay traceable.
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
    }

    // Hono's streamSSE owns the response — forwardable upstream
    // headers must be staged on `c` *before* the streamSSE call so
    // they survive its internal newResponse.
    const upstreamBody = response.body;
    if (!upstreamBody) {
      ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
      recordFailedRequest(ctx, performanceContext);
      // Preserve upstream correlation headers (x-request-id, cf-ray, ...)
      // on the synthesized 502 so this rare edge case is still traceable.
      forwardUpstreamHeaders(c, response.headers);
      return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
    }
    forwardUpstreamHeaders(c, response.headers);
    return streamSSE(c, async stream => {
      let completion: StreamCompletion = 'error';
      let streamError: unknown;
      // Tracks whether the upstream's terminal (`done`) frame arrived
      // before the writer settled. A client cancel after the terminal
      // frame is graceful (upstream already finished its work); a
      // mid-stream cancel or EOF without terminal is a real failure.
      // Mirrors SourceStreamState.failedAfter on the chat endpoints.
      let terminalFrameSeen = false;
      try {
        const frames = (async function* () {
          const sseFramesIn = parseSSEStream(upstreamBody, { signal: ctx.abortSignal });
          for await (const parsed of parseTargetStreamFrames<unknown>(sseFramesIn, { protocol: sourceApi })) {
            const inputFrame: ProtocolFrame<unknown> = parsed.type === 'done' ? doneFrame() : eventFrame(parsed.data);
            // Dump pre-transform, so forensics see upstream truth even
            // when the caller drops a frame from the client-facing stream.
            ctx.dump?.frame(inputFrame);
            if (inputFrame.type === 'done') terminalFrameSeen = true;
            const outputFrame = responseHandling.transformFrame(inputFrame);
            if (outputFrame === null) continue;
            yield outputFrame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(outputFrame.event));
          }
        })();
        completion = await writeSSEFrames(stream, frames, {
          keepAlive: { frame: sseCommentFrame('keepalive') },
          downstreamAbortController: ctx.downstreamAbortController,
        });
      } catch (e) {
        streamError = e;
      } finally {
        const usage = responseHandling.settleUsage();
        const failed = streamError !== undefined || completion === 'error' || !terminalFrameSeen;
        if (failed) {
          ctx.dump?.failed(streamError ?? `${sourceApi} stream ended with completion=${completion}`);
        } else {
          ctx.dump?.success(identity, usage);
        }
        // Record any accumulated usage regardless of the failed flag —
        // tokens already metered upstream should bill even when the
        // downstream half of the round-trip turned out badly. The chat
        // streaming endpoints follow the same rule.
        settle(ctx, performanceContext, identity, usage, failed);
      }
    });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      const forwarded = httpResponseToResponse(e.httpResponse);
      if (forwarded) {
        ctx.dump?.error('upstream');
        return forwarded;
      }
    }
    // Attributes to whichever candidate iterateCandidates was on (or short-circuits if none started).
    recordFailedRequest(ctx, ctx.attempt.telemetry);
    ctx.dump?.failed(e);
    return c.json({ error: toInternalDebugError(e) }, 502);
  }
};
