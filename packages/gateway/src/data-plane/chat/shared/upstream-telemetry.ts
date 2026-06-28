import type { GatewayCtx } from './gateway-ctx.ts';
import { recordPerformanceError, recordPerformanceLatency } from '../../shared/telemetry/performance.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, PerformanceTelemetryContext, ProviderCandidate } from '@floway-dev/provider';

export { createUpstreamLatencyRecorder } from '../../shared/telemetry/performance.ts';

type TerminalKind = 'success' | 'failure';

// The full telemetry context for one upstream call: request-scoped dimensions
// (keyId, stream, runtimeLocation) come off the gateway ctx, the model
// dimensions off the chosen candidate plus the upstream-reported model key.
export const upstreamPerformanceContext = (ctx: GatewayCtx, candidate: ProviderCandidate, modelKey: string): PerformanceTelemetryContext => ({
  keyId: ctx.apiKeyId,
  model: candidate.model.id,
  upstream: candidate.provider.upstream,
  modelKey,
  stream: ctx.wantsStream,
  runtimeLocation: ctx.runtimeLocation,
});

// Wraps the upstream event stream to record the `upstream_success` metric
// once, the moment the target protocol's terminal frame is delivered
// downstream — or, failing that, as a failure when the upstream iterator
// ends without one. Latency is the provider-measured fetch round-trip
// (request out → response in), captured by the recorder and held fixed for
// the lifetime of this stream — the SSE body that arrives after headers is
// downstream-bound time and not part of the upstream metric. The failure
// branch only increments the error counter; `durationMs` is unused there.
export const withUpstreamTelemetry = <T>(
  events: AsyncIterable<ProtocolFrame<T>>,
  ctx: GatewayCtx,
  context: PerformanceTelemetryContext,
  targetApi: ChatTargetApi,
  durationMs: number,
): AsyncIterable<ProtocolFrame<T>> => {
  return (async function* () {
    let recorded = false;
    const recordOnce = (kind: TerminalKind) => {
      if (recorded) return;
      recorded = true;
      const promise = kind === 'success' ? recordPerformanceLatency(context, 'upstream_success', durationMs) : recordPerformanceError(context, 'upstream_success');
      ctx.backgroundScheduler(promise);
    };

    // Track whether the upstream iterator itself reached an end state (EOF or
    // threw). The outer finally needs this so it can distinguish:
    //   * upstream ended without a terminal frame  -> record as failure
    //   * downstream consumer cancelled mid-stream -> do not record anything
    // Async generators don't expose the reason their body unwinds, so we set
    // this flag explicitly only on natural loop exit / upstream throw.
    let upstreamEnded = false;
    try {
      try {
        for await (const frame of events) {
          const terminal = classifyTerminalFrame(frame, targetApi);
          try {
            yield frame;
          } finally {
            // Source protocol collectors stop at terminal events and may never
            // pull the upstream iterator to EOF, so record once a target-owned
            // terminal marker has been delivered downstream.
            if (terminal) recordOnce(terminal);
          }
        }
        upstreamEnded = true;
      } catch (error) {
        upstreamEnded = true;
        throw error;
      }
    } finally {
      // EOF without any terminal frame, or an upstream-thrown error mid-stream,
      // means upstream failed to produce a complete response. Client-initiated
      // cancel may reach the upstream reader via AbortSignal; that can make the
      // wrapped iterator end as EOF, so keep it out of upstream health.
      if (!recorded && upstreamEnded && ctx.abortSignal?.aborted !== true) {
        recordOnce('failure');
      }
    }
  })();
};

// A non-ok upstream HTTP response never produces a frame stream, so it
// records its `upstream_success` failure directly.
export const recordUpstreamHttpFailure = (ctx: GatewayCtx, context: PerformanceTelemetryContext): void => {
  ctx.backgroundScheduler(recordPerformanceError(context, 'upstream_success'));
};

function classifyTerminalFrame<T>(frame: ProtocolFrame<T>, targetApi: ChatTargetApi): TerminalKind | null {
  if (frame.type === 'done') {
    // Chat Completions's terminal signal IS the `[DONE]` sentinel; Messages
    // and Responses have explicit terminal events (message_stop /
    // response.completed family) and never use `[DONE]` for health
    // classification.
    return targetApi === 'chat-completions' ? 'success' : null;
  }
  const event = frame.event as { type?: unknown; status?: unknown };
  const eventType = typeof event.type === 'string' ? event.type : undefined;

  if (targetApi === 'messages') {
    if (eventType === 'message_stop') return 'success';
    if (eventType === 'error') return 'failure';
    return null;
  }
  if (targetApi === 'responses') {
    if (eventType === 'response.completed' || eventType === 'response.incomplete') return 'success';
    if (eventType === 'response.failed') return 'failure';
    if (event.status === 'failed') return 'failure';
    return null;
  }
  // chat-completions's mid-stream `{error: {...}}` envelope is thrown by
  // parseChatCompletionsStream before any frame reaches downstream, so the
  // upstream-thrown path in withUpstreamTelemetry handles it. Nothing else
  // marks chat-completions as a failure terminal until [DONE] arrives.
  return null;
}
