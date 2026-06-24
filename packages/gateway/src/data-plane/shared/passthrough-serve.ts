// Shared serve scaffold for non-LLM passthrough data-plane endpoints. These
// bypass the LLM source/target executor because they have no protocol
// translation — the request body is forwarded to the chosen provider's
// matching endpoint and the upstream response is passed through back to the
// client.
//
// Response handling discriminates on the wire format the upstream produces.
// `json` is single-shot (embeddings, images): the body is parsed once, usage
// is read from the parsed JSON, and the response is forwarded verbatim.
// `sse` is streaming (text-completions /v1/completions): bytes flow through a
// parsed frame pipeline that the caller transforms before reserialization.
// The scaffold never inspects frame contents — caller-owned closures detect
// usage frames, accumulate totals, and may drop frames as needed. Usage and
// request-performance writes are scheduled through the runtime's background
// scheduler so transient repo failures cannot turn a successful 200 from
// upstream into a 502.

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { NonLlmServeApiName } from './api-names.ts';
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

const forwardedResponseHeaders = (resp: Response): Headers => {
  const headers = new Headers({ 'content-type': resp.headers.get('content-type') ?? 'application/json' });
  for (const [name, value] of resp.headers.entries()) {
    if (name.toLowerCase() === 'content-type') continue;
    if (isForwardedResponseHeader(name)) headers.set(name, value);
  }
  return headers;
};

const forwardUpstreamResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: forwardedResponseHeaders(resp),
  });

// Stage forwardable upstream headers onto the Hono context so the streaming
// SSE response Hono builds emits them. `streamSSE`'s internal `c.newResponse`
// honors anything set via `c.header()` before it runs.
const stageForwardedResponseHeaders = (c: Context, resp: Response): void => {
  for (const [name, value] of resp.headers.entries()) {
    if (isForwardedResponseHeader(name)) c.header(name, value);
  }
};

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

// A 2xx body that fails to parse must not 502 a client whose upstream call
// already succeeded; we skip usage extraction and log so missing rows stay
// traceable.
const safeJsonClone = async (resp: Response, sourceApi: NonLlmServeApiName): Promise<unknown> => {
  try {
    return await resp.clone().json();
  } catch (e) {
    console.warn(`passthrough-serve: failed to parse 2xx upstream body for ${sourceApi}; usage row will be skipped`, e instanceof Error ? e.message : String(e));
    return undefined;
  }
};

// Convert an upstream SSE byte stream into transformed SseFrames ready for
// re-serialization. The frame pipeline is generic over event payload —
// `transformFrame` receives `ProtocolFrame<unknown>` and decides per-frame
// whether to pass through, mutate, or drop (return null). The scaffold never
// peeks at event contents; usage detection / accumulation is the caller's
// closure. Every upstream-emitted frame is also pushed into the dump
// accumulator before the transform so post-hoc forensics see the upstream's
// truth — including frames the caller drops from the client-facing stream
// (e.g. the usage-only chunk when the client did not opt into include_usage).
//
// `onTerminalFrame` is fired the moment we see the upstream's terminal
// (`done`) frame. The outer telemetry classifier uses this to distinguish
// a client cancel that lands after the stream's natural end (graceful —
// upstream already finished its work) from a mid-stream cancel
// (genuine failure). The LLM streaming endpoints make the same
// distinction via `SourceStreamState.failedAfter`.
const transformUpstreamSseStream = async function* (
  upstreamBody: ReadableStream<Uint8Array>,
  sourceApi: NonLlmServeApiName,
  transformFrame: (frame: ProtocolFrame<unknown>) => ProtocolFrame<unknown> | null,
  dump: GatewayCtx['dump'],
  signal: AbortSignal | undefined,
  onTerminalFrame: () => void,
): AsyncGenerator<SseFrame> {
  const sseFrames = parseSSEStream(upstreamBody, signal ? { signal } : {});
  for await (const parsed of parseTargetStreamFrames<unknown>(sseFrames, { protocol: sourceApi })) {
    const inputFrame: ProtocolFrame<unknown> = parsed.type === 'done' ? doneFrame() : eventFrame(parsed.data);
    dump?.frame(inputFrame);
    if (inputFrame.type === 'done') onTerminalFrame();
    const outputFrame = transformFrame(inputFrame);
    if (outputFrame === null) continue;
    yield outputFrame.type === 'done' ? sseFrame('[DONE]') : sseFrame(JSON.stringify(outputFrame.event));
  }
};

// Discriminator on the wire format the upstream produces.
//
// `json`: single-shot response. The scaffold drains the body once and hands
// the parsed body to `extractBilling`, which decides how to read usage and
// any per-response metadata (service tier, modality split, etc.). The
// response is forwarded verbatim. Embeddings and images use this path.
//
// `sse`: streaming response. The scaffold parses SSE bytes into frames,
// runs each through `transformFrame` (return null to drop), reserializes
// the survivors, and writes them through Hono's streamSSE helper. After
// the stream ends, `settleUsage` is called to surface the caller's
// accumulated usage for billing. Used by /v1/completions
// passthrough; the caller's transformFrame closes over a usage
// accumulator and a strip-or-keep decision for the OpenAI usage-only
// chunk.
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
  readonly sourceApi: NonLlmServeApiName;
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
  // Format-discriminated response handler. See PassthroughResponseHandling.
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
        const parsed = await safeJsonClone(response, sourceApi);
        const usage = parsed !== undefined ? responseHandling.extractBilling(parsed) : null;
        ctx.dump?.success(modelIdentity, usage);
        if (usage) {
          scheduleUsageRecord(ctx.backgroundScheduler, recordTokenUsage(ctx.apiKeyId, modelIdentity, usage));
        }
        recordRequestPerformance(ctx.backgroundScheduler, performanceContext, false, performance.now() - requestStartedAt);
        return forwardUpstreamResponse(response);
      }

      // `sse` branch. Hono's streamSSE owns the response — headers must be
      // staged on `c` before the call. Telemetry and billing run after the
      // stream completes (in the finally), so they remain symmetric with
      // the `json` branch.
      if (!response.body) {
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
          const frames = transformUpstreamSseStream(response.body!, sourceApi, sseResponseHandling.transformFrame, ctx.dump, ctx.abortSignal, () => {
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

// Uniform error envelope for this endpoint family.
export const passthroughApiError = (c: Context, message: string, status: ContentfulStatusCode): Response =>
  c.json({ error: { message, type: 'api_error' } }, status);
