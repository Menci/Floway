import type { GatewayCtx } from './gateway-ctx.ts';
import { upstreamPerformanceContext } from './telemetry/attribution.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import { isAbortError } from '@floway-dev/provider';
import type { ModelCandidate, PerformanceOperation } from '@floway-dev/provider';

// A serve-layer attempt result counts as success when:
//   - The SSE event stream actually opened (`type: 'events'`). Mid-stream
//     failure is the upstream's responsibility from there on; a fresh
//     attempt on a different upstream does not start once the client has
//     begun consuming events.
//   - The non-streaming envelope landed: `PlainResult` with a 2xx status,
//     or the OpenAI-Responses-compact `{type:'result'}` envelope.
// `api-error` and `internal-error` are failures: the serve loop falls
// through to the next candidate. 4xx is on the failure side — 429
// (rate-limit) is the responsibility of the upstream that issued it, and
// the gateway's candidate ordering exists to absorb that kind of
// transient. Passthrough serves feed in an enlarged `plain` shape that
// carries the raw upstream Response plus per-attempt telemetry alongside
// the status; the success discriminant is unchanged.
type IterableAttemptResult =
  | { readonly type: 'events' }
  | { readonly type: 'result' }
  | { readonly type: 'plain'; readonly status: number; readonly headers?: Headers; readonly response?: Response }
  | { readonly type: 'api-error'; readonly headers?: Headers }
  | { readonly type: 'internal-error' };

const isAttemptSuccess = (result: IterableAttemptResult): boolean => {
  switch (result.type) {
  case 'events':
  case 'result':
    return true;
  case 'plain':
    return result.status >= 200 && result.status < 300;
  case 'api-error':
  case 'internal-error':
    return false;
  }
};

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
const retryTime = (result: IterableAttemptResult): number | null => {
  const headers = result.type === 'plain' ? result.headers ?? result.response?.headers : result.type === 'api-error' ? result.headers : undefined;
  const value = headers?.get('retry-after')?.trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  // Date.parse also accepts malformed numeric delays as calendar dates.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(now, time) : null;
};

// Tries each narrowed candidate in order and returns the first success. A
// per-candidate *failure result* falls through so a transient 5xx/429 on
// one upstream rolls over to the next, as does a transport failure before a
// response opens. Cancellation and internal errors propagate immediately.
// When exhausted, prefer the original response with the earliest retry time;
// otherwise surface the last failure. Callers are contractually required to
// hand in a non-empty candidate list — the empty-candidate branch renders
// each caller's own protocol-shaped "no viable candidate" envelope at the
// serve site.
//
// Owns per-attempt AttemptState: clears the two timing slots and stamps
// `ctx.attempt.telemetry` with the current candidate's
// `PerformanceTelemetryContext` synchronously BEFORE handing control to
// `run`. That way a mid-attempt throw (interceptor bug, translation
// error, provider-layer JS exception not represented as a ChatServeFailure)
// still attributes the perf error row to the throwing candidate: the
// outer catch reads `ctx.attempt.telemetry` and feeds it into
// `recordFailedRequest`. Callsites don't need to duplicate this stamp.
export const iterateCandidates = async <T extends IterableAttemptResult>(
  candidates: readonly ModelCandidate[],
  invocationLabel: string,
  ctx: GatewayCtx,
  operation: PerformanceOperation,
  run: (candidate: ModelCandidate) => Promise<T>,
): Promise<T> => {
  let lastFailure: T | undefined;
  let lastTransportError: Error | undefined;
  let retryFailure: { result: T; time: number } | undefined;
  for (const candidate of candidates) {
    ctx.abortSignal?.throwIfAborted();
    ctx.attempt.timing.upstreamCallStartedAt = null;
    ctx.attempt.timing.firstOutputTokenAt = null;
    ctx.attempt.telemetry = upstreamPerformanceContext(ctx, candidate, operation);
    let result: T;
    try {
      result = await run(candidate);
    } catch (error) {
      if (ctx.abortSignal?.aborted || isAbortError(error) || !isUpstreamTransportError(error)) throw error;
      lastTransportError = error;
      continue;
    }
    if (isAttemptSuccess(result)) return result;
    lastFailure = result;
    lastTransportError = undefined;
    const time = retryTime(result);
    if (time !== null && (retryFailure === undefined || time < retryFailure.time)) retryFailure = { result, time };
  }
  if (retryFailure !== undefined) return retryFailure.result;
  if (lastTransportError !== undefined) throw lastTransportError;
  if (lastFailure === undefined) {
    throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
  }
  return lastFailure;
};
