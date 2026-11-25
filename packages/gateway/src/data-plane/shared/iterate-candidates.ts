import parseHttpDate from 'http-dates';

import type { GatewayCtx } from './gateway-ctx.ts';
import type { RawAttemptResult } from './raw-attempt-result.ts';
import { upstreamPerformanceContext } from './telemetry/attribution.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import { discardUpstreamResponse, isAbortError, type HttpHead, type ModelCandidate, type PerformanceOperation } from '@floway-dev/provider';

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

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
export const retryTime = (retryAfter: string | null | undefined): number | null => {
  const value = retryAfter?.trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    // http-dates signals malformed input by throwing.
    return null;
  }
};

const discardFailure = (ctx: GatewayCtx, result: IterableAttemptResult | undefined): void => {
  if (result?.type !== 'response' || result.http.body === null) return;
  ctx.backgroundScheduler(discardUpstreamResponse(result.http).catch(error => {
    console.warn('Floway: failed to cancel a discarded upstream response', error);
  }));
};

// Return the first success. HTTP failures and transport failures before a
// response opens advance the loop. Cancellation and other throws propagate.
// On exhaustion retain the earliest retry response, or the terminal failure
// when no response carried a valid hint.
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
  let selected: T | undefined;
  let earliestRetryTime: number | null = null;
  let lastTransportError: Error | undefined;
  try {
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
      lastTransportError = undefined;
      const time = retryTime(result.http?.headers.get('retry-after'));
      if (earliestRetryTime !== null && (time === null || time >= earliestRetryTime)) {
        discardFailure(ctx, result);
        continue;
      }

      discardFailure(ctx, selected);
      selected = result;
      earliestRetryTime = time;
    }

    if (earliestRetryTime === null && lastTransportError !== undefined) throw lastTransportError;
    if (selected === undefined) {
      throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
    }
    const terminal = selected;
    selected = undefined;
    return terminal;
  } finally {
    discardFailure(ctx, selected);
  }
};
