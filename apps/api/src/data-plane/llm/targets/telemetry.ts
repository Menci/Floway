import type { PerformanceApiName, TelemetryModelIdentity } from '../../../repo/types.ts';
import { type PerformanceTelemetryContext, recordPerformanceError, recordPerformanceLatency } from '../../shared/telemetry/performance.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { SseFrame } from '@floway-dev/protocols/common';

type TerminalKind = 'success' | 'failure';

export function withUpstreamTelemetry<T>(
  events: AsyncIterable<T>,
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: PerformanceApiName,
  startedAt: number,
  modelIdentity: TelemetryModelIdentity,
): AsyncIterable<T> {
  return (async function* () {
    let recorded = false;
    const recordOnce = (kind: TerminalKind, durationMs: number) => {
      if (recorded || !request.apiKeyId) return;
      recorded = true;
      const context = upstreamContext(invocation, request, targetApi, modelIdentity);
      const promise = kind === 'success' ? recordPerformanceLatency(context, 'upstream_success', durationMs) : recordPerformanceError(context, 'upstream_success');
      request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
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
        for await (const event of events) {
          const terminal = classifyTerminalFrame(event, targetApi);
          const terminalDurationMs = terminal ? performance.now() - startedAt : 0;
          try {
            yield event;
          } finally {
            // Source protocol collectors stop at terminal events and may never
            // pull the upstream iterator to EOF, so record once a target-owned
            // terminal marker has been delivered downstream.
            if (terminal) recordOnce(terminal, terminalDurationMs);
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
      // cancel may now also reach the upstream reader via AbortSignal; that can
      // make the wrapped iterator end as EOF, so keep it out of upstream health.
      if (!recorded && upstreamEnded && request.downstreamAbortSignal?.aborted !== true) {
        recordOnce('failure', performance.now() - startedAt);
      }
    }
  })();
}

export function recordUpstreamHttpFailure(invocation: Invocation<unknown>, request: RequestContext, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): void {
  if (!request.apiKeyId) return;
  const promise = recordPerformanceError(upstreamContext(invocation, request, targetApi, modelIdentity), 'upstream_success');
  request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
}

export function targetPerformanceContext(
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: PerformanceApiName,
  modelIdentity: TelemetryModelIdentity,
): PerformanceTelemetryContext {
  return upstreamContext(invocation, request, targetApi, modelIdentity);
}

function classifyTerminalFrame(value: unknown, targetApi: PerformanceApiName): TerminalKind | null {
  if (!isSseFrame(value)) return null;
  return classifySseTerminal(value, targetApi);
}

function isSseFrame(value: unknown): value is SseFrame {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'sse' && typeof (value as { data?: unknown }).data === 'string';
}

function classifySseTerminal(frame: SseFrame, targetApi: PerformanceApiName): TerminalKind | null {
  const data = frame.data.trim();
  if (data === '[DONE]') {
    return targetApi === 'chat-completions' ? 'success' : null;
  }

  let parsed: { type?: unknown; status?: unknown } | null = null;
  try {
    parsed = JSON.parse(data) as { type?: unknown; status?: unknown };
  } catch {
    return null;
  }

  let eventType = frame.event;
  if (typeof parsed.type === 'string') eventType = parsed.type;

  if (targetApi === 'messages') {
    if (eventType === 'message_stop') return 'success';
    if (eventType === 'error') return 'failure';
    return null;
  }
  if (targetApi === 'responses') {
    if (eventType === 'response.completed' || eventType === 'response.incomplete') return 'success';
    if (eventType === 'response.failed') return 'failure';
    if (parsed.status === 'failed') return 'failure';
    return null;
  }
  if (chatCompletionsErrorPayloadMessage(parsed)) return 'failure';
  return null;
}

function upstreamContext(invocation: Invocation<unknown>, request: RequestContext, targetApi: PerformanceApiName, modelIdentity: TelemetryModelIdentity): PerformanceTelemetryContext {
  return {
    keyId: request.apiKeyId ?? 'unknown',
    model: modelIdentity.model,
    upstream: modelIdentity.upstream,
    modelKey: modelIdentity.modelKey,
    sourceApi: invocation.sourceApi,
    targetApi,
    stream: request.clientStream,
    runtimeLocation: request.runtimeLocation,
  };
}
