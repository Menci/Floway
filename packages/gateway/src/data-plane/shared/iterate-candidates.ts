import type { GatewayCtx } from './gateway-ctx.ts';
import type { RawAttemptResult } from './raw-attempt-result.ts';
import { upstreamPerformanceContext } from './telemetry/attribution.ts';
import { discardUpstreamResponse, type HttpHead, type ModelCandidate, type PerformanceOperation } from '@floway-dev/provider';

// HTTP in-flight streams are represented by a 2xx response head. Later
// protocol errors in their body do not reopen candidate selection.
type IterableAttemptResult =
  | { readonly type: 'events' | 'result'; readonly http?: HttpHead }
  | { readonly type: 'plain' | 'api-error' | 'internal-error'; readonly http: HttpHead }
  | Pick<RawAttemptResult, 'type' | 'http'>;

const isAttemptSuccess = (result: IterableAttemptResult): boolean => {
  if (result.type === 'api-error' || result.type === 'internal-error') return false;
  const status = result.http?.status;
  return status === undefined || (status >= 200 && status < 300);
};

const discardFailure = (ctx: GatewayCtx, result: IterableAttemptResult | undefined): void => {
  if (result?.type !== 'response' || result.http.body === null) return;
  ctx.backgroundScheduler(discardUpstreamResponse(result.http).catch(error => {
    console.warn('Floway: failed to cancel a discarded upstream response', error);
  }));
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
  try {
    for (const candidate of candidates) {
      ctx.attempt.timing.upstreamCallStartedAt = null;
      ctx.attempt.timing.firstOutputTokenAt = null;
      ctx.attempt.telemetry = upstreamPerformanceContext(ctx, candidate, operation);
      const result = await run(candidate);
      if (isAttemptSuccess(result)) return result;
      discardFailure(ctx, lastFailure);
      lastFailure = result;
    }
    if (lastFailure === undefined) {
      throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
    }
    const selected = lastFailure;
    lastFailure = undefined;
    return selected;
  } finally {
    discardFailure(ctx, lastFailure);
  }
};
