// Shared serve scaffold for passthrough data-plane endpoints. These
// bypass the LLM source/target executor because they have no protocol
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
import { inboundHeadersForUpstream } from './inbound-headers.ts';
import type { PerformanceTelemetryContext } from './telemetry/performance.ts';
import { createUpstreamLatencyRecorder, recordPerformanceError, recordPerformanceLatency, recordRequestPerformance } from './telemetry/performance.ts';
import { recordTokenUsage } from './telemetry/usage.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { TokenUsage } from '../../repo/types.ts';
import type { GatewayCtx } from '../llm/shared/gateway-ctx.ts';
import { type StreamCompletion, writeSSEFrames } from '../llm/shared/stream/sse.ts';
import { resolveModelForRequest } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { doneFrame, eventFrame, parseSSEStream, parseTargetStreamFrames, type ProtocolFrame, type SseFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { httpResponseToResponse, ProviderModelsUnavailableError, toInternalDebugError } from '@floway-dev/provider';
import type { ProviderCallResult, ProviderModelRecord, UpstreamCallOptions } from '@floway-dev/provider';

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

// Uniform error envelope for this endpoint family.
export const passthroughApiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);

const recordUpstreamPerformance = (
  scheduler: BackgroundScheduler,
  context: PerformanceTelemetryContext,
  failed: boolean,
  durationMs: number,
): void => {
  scheduler(failed ? recordPerformanceError(context, 'upstream_success') : recordPerformanceLatency(context, 'upstream_success', durationMs));
};

// Fire-and-forget the usage record. A transient D1/KV failure here must not
// surface as a 502 to a client whose upstream call already succeeded with a
// 200 response body in hand. We log so the failure is still observable.
const scheduleUsageRecord = (scheduler: BackgroundScheduler, promise: Promise<void>): void => {
  scheduler(promise.catch(error => {
    console.error('Failed to record token usage:', error);
  }));
};

// Convert an upstream SSE byte stream into transformed SseFrames ready for
// re-serialization. `transformFrame` decides per-frame whether to pass
// through, mutate, or drop (return null). Every upstream-emitted frame is
// also pushed into the dump accumulator before the transform so post-hoc
// forensics see the upstream's truth, including frames the caller drops
// from the client-facing stream.
//
// `onTerminalFrame` fires the moment we see the upstream's terminal
// (`done`) frame. The outer telemetry classifier uses it to distinguish a
// client cancel that lands after the stream's natural end (graceful —
// upstream already finished its work) from a mid-stream cancel (genuine
// failure). Mirrors `SourceStreamState.failedAfter` on the LLM endpoints.
const transformUpstreamSseStream = async function* (
  upstreamBody: ReadableStream<Uint8Array>,
  sourceApi: PassthroughServeApiName,
  transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null,
  dump: GatewayCtx['dump'],
  signal: AbortSignal | undefined,
  onTerminalFrame: () => void,
): AsyncGenerator<SseFrame> {
  const sseFrames = parseSSEStream(upstreamBody, { signal });
  for await (const parsed of parseTargetStreamFrames<unknown>(sseFrames, { protocol: sourceApi })) {
    const inputFrame: ProtocolFrame<unknown> = parsed.type === 'done' ? doneFrame() : eventFrame(parsed.data);
    dump?.frame(inputFrame);
    if (inputFrame.type === 'done') onTerminalFrame();
    const outputFrame = transformFrame(inputFrame);
    if (outputFrame === null) continue;
    yield outputFrame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(outputFrame.event));
  }
};

// `json` (embeddings, images): single-shot body, `extractBilling` reads
// usage / metadata off the parsed root. `sse` (/v1/completions): frame
// stream, `transformFrame` mutates or drops frames (return null), then
// `settleUsage` reports billing once the stream ends. The OpenAI
// usage-only chunk (`choices: []` plus `usage`) is what the caller's
// transformFrame keys off when it needs to strip-or-keep based on the
// client's `stream_options.include_usage`.
export type PassthroughResponseHandling =
  | {
    readonly format: 'json';
    readonly extractBilling: (body: unknown) => TokenUsage | null;
  }
  | {
    readonly format: 'sse';
    readonly transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null;
    readonly settleUsage: () => TokenUsage | null;
  };

export interface PassthroughServeContext {
  readonly c: AuthedContext;
  readonly ctx: GatewayCtx;
  readonly sourceApi: PassthroughServeApiName;
  // Already-validated public model id the client requested. The helper
  // resolves it against the provider registry; if no upstream serves the
  // id, the client sees a 404 with the standard wording.
  readonly model: string;
  readonly bindingServesEndpoint: (binding: ProviderModelRecord) => boolean;
  // Performs the upstream HTTP call for the chosen binding. Any throw here
  // is preserved and becomes a 502 with the internal-debug envelope —
  // exceptions thrown from the actual fetch must not be silently swallowed.
  // `opts` carries the per-call hooks the gateway threads in (the
  // recordUpstreamLatency wrapper for the upstream_success metric); the
  // callback forwards it verbatim to the chosen provider call method.
  readonly call: (binding: ProviderModelRecord, opts: UpstreamCallOptions) => Promise<ProviderCallResult>;
  readonly response: PassthroughResponseHandling;
  // Returned as the 400 body when no provider binding matched. Phrased
  // per-endpoint so the error tells the client which capability is missing.
  readonly noBindingMessage: (modelId: string) => string;
}

export const passthroughServe = async (input: PassthroughServeContext): Promise<Response> => {
  const { c, ctx, sourceApi, model, bindingServesEndpoint, call, response: responseHandling, noBindingMessage } = input;
  const requestStartedAt = performance.now();
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const fetcherForUpstream = await createPerRequestFetcher(ctx.currentColo);
    const { id: modelId, model: resolved, failedUpstreams } = await resolveModelForRequest(model, ctx.upstreamIds, fetcherForUpstream, ctx.backgroundScheduler);
    if (!resolved) {
      ctx.dump?.error('gateway');
      return passthroughApiError(c, appendFailedUpstreams(`Model ${modelId} is not available on any configured upstream.`, failedUpstreams), 404);
    }

    for (const binding of resolved.providers) {
      if (!bindingServesEndpoint(binding)) continue;

      const recorder = createUpstreamLatencyRecorder();
      const { response, modelKey } = await call(binding, {
        fetcher: fetcherForUpstream(binding.upstream),
        recordUpstreamLatency: recorder.record,
        waitUntil: ctx.backgroundScheduler,
        headers: inboundHeadersForUpstream(c),
      });
      const upstreamDurationMs = recorder.durationMs();
      const performanceContext: PerformanceTelemetryContext = {
        keyId: ctx.apiKeyId,
        model: modelId,
        upstream: binding.upstream,
        modelKey,
        stream: responseHandling.format === 'sse',
        runtimeLocation: ctx.runtimeLocation,
      };
      lastPerformance = performanceContext;
      const modelIdentity = { model: modelId, upstream: binding.upstream, modelKey, cost: binding.provider.getPricingForModelKey(modelKey) };

      if (!response.ok) {
        recordUpstreamPerformance(ctx.backgroundScheduler, performanceContext, true, upstreamDurationMs);
        recordRequestPerformance(ctx.backgroundScheduler, performanceContext, true, performance.now() - requestStartedAt);
        ctx.dump?.error('upstream', binding.upstream);
        return forwardUpstreamResponse(response);
      }

      recordUpstreamPerformance(ctx.backgroundScheduler, performanceContext, false, upstreamDurationMs);

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
        ctx.dump?.success(modelIdentity, usage);
        if (usage) {
          scheduleUsageRecord(ctx.backgroundScheduler, recordTokenUsage(ctx.apiKeyId, modelIdentity, usage));
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
      // Capture the SSE-narrowed handler outside the streamSSE callback so
      // TypeScript keeps the narrowing across the async closure boundary.
      const sseResponseHandling = responseHandling;
      return streamSSE(c, async stream => {
        let completion: StreamCompletion = 'error';
        let streamError: unknown;
        let terminalFrameSeen = false;
        try {
          const frames = transformUpstreamSseStream(upstreamBody, sourceApi, sseResponseHandling.transformFrame, ctx.dump, ctx.abortSignal, () => {
            terminalFrameSeen = true;
          });
          completion = await writeSSEFrames(stream, frames, {
            keepAlive: { frame: sseCommentFrame('keepalive') },
            ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
          });
        } catch (e) {
          streamError = e;
        } finally {
          const usage = sseResponseHandling.settleUsage();
          // Treat a client cancel that lands after the upstream's terminal
          // frame as graceful — upstream already finished its work and
          // billing should record what was accumulated. Mid-stream cancel,
          // upstream cut-off without a terminal frame, and writer / parser
          // errors are all real failures. Mirrors the LLM endpoints'
          // SourceStreamState.failedAfter semantics.
          const failed = streamError !== undefined || completion === 'error' || !terminalFrameSeen;
          if (failed) {
            ctx.dump?.failed(streamError ?? `${sourceApi} stream ended with completion=${completion}`);
          } else {
            ctx.dump?.success(modelIdentity, usage);
          }
          // Record any accumulated usage regardless of the failed flag —
          // tokens already metered upstream should bill even when the
          // downstream half of the round-trip turned out badly. The LLM
          // streaming endpoints follow the same rule.
          if (usage) {
            scheduleUsageRecord(ctx.backgroundScheduler, recordTokenUsage(ctx.apiKeyId, modelIdentity, usage));
          }
          recordRequestPerformance(ctx.backgroundScheduler, performanceContext, failed, performance.now() - requestStartedAt);
        }
      });
    }

    ctx.dump?.error('gateway');
    return passthroughApiError(c, appendFailedUpstreams(noBindingMessage(modelId), failedUpstreams), 400);
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
