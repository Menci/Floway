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
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { recordRequestPerformance } from './telemetry/performance.ts';
import { recordTokenUsage } from './telemetry/usage.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../chat/shared/stream/sse.ts';
import { enumerateModelCandidates } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { doneFrame, eventFrame, type ModelKind, parseSSEStream, parseTargetStreamFrames, type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { httpResponseToResponse, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import type { InternalModel, Provider, ProviderCallResult, ProviderModel, UpstreamCallOptions } from '@floway-dev/provider';

// Headers we forward verbatim from a successful upstream response, plus
// content-type with an application/json fallback when the upstream omitted
// it. The set is intentionally narrow and matches the passthrough contract
// OpenAI clients (and the OpenAI Node SDK retry policy) expect to see —
// correlation, organisation/model metadata, quota signals, retry-after.
const FORWARDED_RESPONSE_HEADER_PREFIXES = ['openai-', 'x-ratelimit-'] as const;
const FORWARDED_RESPONSE_HEADERS = new Set(['x-request-id', 'retry-after', 'cf-ray']);

const isForwardedResponseHeader = (name: string): boolean => {
  const lower = name.toLowerCase();
  return FORWARDED_RESPONSE_HEADERS.has(lower) || FORWARDED_RESPONSE_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix));
};

const forwardUpstreamResponse = (resp: Response): Response => {
  const headers = new Headers({ 'content-type': resp.headers.get('content-type') ?? 'application/json' });
  for (const [name, value] of resp.headers.entries()) {
    if (name.toLowerCase() === 'content-type') continue;
    if (isForwardedResponseHeader(name)) headers.set(name, value);
  }
  return new Response(resp.body, { status: resp.status, headers });
};

// Stage forwardable upstream headers onto the Hono context so the streaming
// SSE response Hono builds emits them. `streamSSE`'s internal `c.newResponse`
// honors anything set via `c.header()` before it runs.
const stageForwardedResponseHeaders = (c: Context, resp: Response): void => {
  for (const [name, value] of resp.headers.entries()) {
    if (isForwardedResponseHeader(name)) c.header(name, value);
  }
};

// Fire-and-forget the usage record. A transient D1/KV failure here must not
// surface as a 502 to a client whose upstream call already succeeded with a
// 200 response body in hand. We log so the failure is still observable.
const scheduleUsageRecord = (scheduler: BackgroundScheduler, promise: Promise<void>): void => {
  scheduler(promise.catch(error => {
    console.error('Failed to record token usage:', error);
  }));
};

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
  // Performs the upstream HTTP call for the chosen (provider, model) pair.
  // Any throw here is preserved and becomes a 502 with the internal-debug
  // envelope — exceptions thrown from the actual fetch must not be silently
  // swallowed. `opts` carries the per-call hooks the gateway threads in
  // (the recordUpstreamLatency wrapper for the upstream_success metric);
  // the callback forwards it verbatim to the chosen provider call method.
  // `model` is the emitting upstream's `ProviderModel`.
  readonly call: (provider: Provider, model: ProviderModel, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
  readonly response: PassthroughResponseHandling;
}

// Uniform error envelope for this endpoint family.
export const passthroughApiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);

export const passthroughServe = async (input: PassthroughServeContext): Promise<Response> => {
  const { c, ctx, sourceApi, model, kind, modelServesEndpoint, call, response: responseHandling } = input;
  const requestStartedAt = performance.now();
  // Populated as attempts land so a throw from `passthroughAttempt` (or
  // the response handling below) can still attribute request-perf to the
  // most recent candidate the loop touched. A throw before any candidate
  // fired leaves this undefined; the outer catch below is happy with that.
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    // The shared resolver returns every candidate of the requested kind:
    // unprefixed + prefixed addressable surfaces fan out across upstreams,
    // a dated-suffix retry catches `-YYYYMMDD` ids the catalog only lists
    // in base form, and the kind filter rejects models of the wrong
    // family before they reach `modelServesEndpoint`. Iteration order
    // follows configured sort_order across upstreams, with the unprefixed
    // branch pushed before the prefixed one within a single upstream.
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
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
    // HTTP call and records `upstream_success` telemetry; the shared
    // iterator returns the first 2xx or, on exhaustion, the last non-2xx
    // result. Request-perf and dump attribution wait until this point so
    // they land against the terminal candidate.
    const result = await iterateCandidates(
      viable,
      'passthroughServe',
      async candidate => {
        const attempted = await passthroughAttempt({
          c, ctx, candidate,
          stream: responseHandling.format === 'sse',
          call,
        });
        lastPerformance = attempted.performance;
        return attempted;
      },
    );
    const { response, performance: performanceContext, identity } = result;

    if (!response.ok) {
      // Exhausted — forward the last upstream response verbatim so clients
      // still see real upstream telemetry (status, retry-after, request-id,
      // ...) rather than a synthetic gateway envelope.
      recordRequestPerformance(ctx.backgroundScheduler, performanceContext, true, performance.now() - requestStartedAt);
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
      if (usage) {
        scheduleUsageRecord(ctx.backgroundScheduler, recordTokenUsage(ctx.apiKeyId, identity, usage));
      }
      recordRequestPerformance(ctx.backgroundScheduler, performanceContext, false, performance.now() - requestStartedAt);
      return forwardUpstreamResponse(response);
    }

    // Hono's streamSSE owns the response — forwardable upstream
    // headers must be staged on `c` *before* the streamSSE call so
    // they survive its internal newResponse.
    const upstreamBody = response.body;
    if (!upstreamBody) {
      ctx.dump?.failed(`${sourceApi} streaming upstream returned no body`);
      recordRequestPerformance(ctx.backgroundScheduler, performanceContext, true, performance.now() - requestStartedAt);
      // Preserve upstream correlation headers (x-request-id, cf-ray, ...)
      // on the synthesized 502 so this rare edge case is still traceable.
      stageForwardedResponseHeaders(c, response);
      return passthroughApiError(c, 'Upstream returned a streaming response with no body.', 502);
    }
    stageForwardedResponseHeaders(c, response);
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
        if (usage) {
          scheduleUsageRecord(ctx.backgroundScheduler, recordTokenUsage(ctx.apiKeyId, identity, usage));
        }
        recordRequestPerformance(ctx.backgroundScheduler, performanceContext, failed, performance.now() - requestStartedAt);
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
    recordRequestPerformance(ctx.backgroundScheduler, lastPerformance, true, performance.now() - requestStartedAt);
    ctx.dump?.failed(e);
    return c.json({ error: toInternalDebugError(e) }, 502);
  }
};
