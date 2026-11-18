import type { GatewayCtx } from './gateway-ctx.ts';
import type { RawAttemptResult } from './raw-attempt-result.ts';
import { upstreamPerformanceContext } from './telemetry/attribution.ts';
import type { HttpHead, ModelCandidate, PerformanceOperation } from '@floway-dev/provider';

// Once an event stream opens, later protocol errors belong to the response.
type IterableAttemptResult =
  | { readonly type: 'events' | 'result' }
  | { readonly type: 'plain' | 'api-error' | 'internal-error'; readonly http: HttpHead }
  | Pick<RawAttemptResult, 'type' | 'http'>;

const isAttemptSuccess = (result: IterableAttemptResult): boolean => {
  switch (result.type) {
  case 'events':
  case 'result':
    return true;
  case 'plain':
  case 'response':
    return result.http.status >= 200 && result.http.status < 300;
  case 'api-error':
  case 'internal-error':
    return false;
  }
};

// Tries each narrowed candidate in order and returns the first success. A
// per-candidate *failure result* falls through so a transient 5xx/429 on
// one upstream rolls over to the next; a thrown error leaves the loop and
// surfaces to the caller, so a dial failure does not advance. When the
// list is exhausted the most recent failure is returned so callers can
// forward it verbatim and clients still see real upstream telemetry rather
// than a synthetic gateway envelope. Callers are contractually required to
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
  for (const candidate of candidates) {
    ctx.attempt.timing.upstreamCallStartedAt = null;
    ctx.attempt.timing.firstOutputTokenAt = null;
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
