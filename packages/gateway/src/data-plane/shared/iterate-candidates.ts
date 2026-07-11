import { upstreamPerformanceContext } from './telemetry/attempt-helpers.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import type { ModelCandidate, PerformanceOperation } from '@floway-dev/provider';

// A serve-layer attempt result counts as success when:
//   - The SSE event stream actually opened (`type: 'events'`). Mid-stream
//     failure is the upstream's responsibility from there on; a fresh
//     attempt on a different upstream does not start once the client has
//     begun consuming events.
//   - The non-streaming envelope landed: `PlainResult` with a 2xx status,
//     or the Responses-compact `{type:'result'}` envelope.
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
  | { readonly type: 'plain'; readonly status: number }
  | { readonly type: 'api-error' }
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

// Tries each narrowed candidate in order and returns the first success. A
// per-candidate failure falls through so a transient 5xx/429/network on
// one upstream rolls over to the next; when the list is exhausted the
// most recent failure is returned so callers can forward it verbatim and
// clients still see real upstream telemetry rather than a synthetic
// gateway envelope. Callers are contractually required to hand in a
// non-empty candidate list — the empty-candidate branch renders each
// caller's own protocol-shaped "no viable candidate" envelope at the
// serve site.
//
// Owns per-attempt AttemptState: clears the two timing slots and stamps
// `ctx.attempt.telemetry` with the current candidate's
// `PerformanceTelemetryContext` synchronously BEFORE handing control to
// `run`. That way a mid-attempt throw (interceptor bug, translation
// error, provider-layer JS exception bypassing tryCatchChatServeFailure)
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
  for (const candidate of candidates) {
    ctx.attempt.upstreamCallStartedAt = null;
    ctx.attempt.firstOutputTokenAt = null;
    ctx.attempt.telemetry = upstreamPerformanceContext(ctx, candidate, operation);
    const result = await run(candidate);
    if (isAttemptSuccess(result)) return result;
    lastFailure = result;
  }
  if (lastFailure === undefined) {
    throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
  }
  return lastFailure;
};
