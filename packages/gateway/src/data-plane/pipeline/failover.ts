import parseHttpDate from 'http-dates';

import { headerEntryValue } from './headers.ts';
import type { GatewayPipelineServices } from './services.ts';
import { isUpstreamTransportError } from '../../dial/transport-error.ts';
import type { HeaderEntry, ManagedStream, StageEnv } from '@floway-dev/pipeline';
import { isAbortError, type PerformanceOperation, type PerformanceTelemetryContext, type RouteCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';

export const routeCandidatePerformanceContext = (
  services: Pick<GatewayPipelineServices, 'apiKeyId' | 'runtimeLocation'>,
  candidate: RouteCandidate,
  operation: PerformanceOperation,
): PerformanceTelemetryContext => ({
  keyId: services.apiKeyId,
  model: candidate.modelId,
  upstream: candidate.upstreamId,
  operation,
  runtimeLocation: services.runtimeLocation,
});

export const routeCandidateModelIdentity = (
  candidate: RouteCandidate,
  modelKey: string,
): TelemetryModelIdentity => ({
  model: candidate.modelId,
  upstream: candidate.upstreamId,
  modelKey,
  pricing: candidate.providerModel.pricing ?? null,
});

// https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3
export const retryTimeFromHeaderEntries = (headers: readonly HeaderEntry[] | undefined): number | null => {
  const value = headerEntryValue(headers ?? [], 'retry-after')?.trim();
  if (!value) return null;
  const now = Date.now();
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const time = now + Number(value) * 1_000;
    return Number.isFinite(time) ? time : null;
  }
  try {
    return Math.max(now, parseHttpDate(value).getTime());
  } catch {
    return null;
  }
};

export interface FailoverInspection {
  readonly success: boolean;
  readonly headers?: readonly HeaderEntry[];
  readonly discardStream?: ManagedStream<unknown> | null;
}

export interface FailoverOptions<T> {
  readonly candidates: readonly RouteCandidate[];
  readonly invocationLabel: string;
  readonly operation: PerformanceOperation;
  readonly env: StageEnv<GatewayPipelineServices>;
  readonly run: (candidate: RouteCandidate) => Promise<T>;
  readonly inspect: (result: T) => FailoverInspection;
}

const isLiveStream = (stream: ManagedStream<unknown> | null | undefined): stream is ManagedStream<unknown> =>
  stream !== null
  && stream !== undefined
  && stream.owned
  && (stream.state === 'open' || stream.state === 'iterating');

const discardFailure = async (
  env: StageEnv<GatewayPipelineServices>,
  result: { readonly discardStream?: ManagedStream<unknown> | null } | undefined,
): Promise<void> => {
  if (isLiveStream(result?.discardStream)) await env.discard(result.discardStream, 'superseded upstream response');
};

export const failoverRouteCandidates = async <T>(options: FailoverOptions<T>): Promise<T> => {
  const { candidates, invocationLabel, operation, env, run, inspect } = options;
  let selected: T | undefined;
  let selectedDiscard: FailoverInspection | undefined;
  let earliestRetryTime: number | null = null;
  let lastTransportError: Error | undefined;

  try {
    for (const candidate of candidates) {
      env.signal.throwIfAborted();
      env.attempt.timing.upstreamCallStartedAt = null;
      env.attempt.timing.firstOutputTokenAt = null;
      env.attempt.telemetry = routeCandidatePerformanceContext(env, candidate, operation);

      let result: T;
      try {
        result = await run(candidate);
      } catch (error) {
        if (env.signal.aborted || isAbortError(error) || !isUpstreamTransportError(error)) throw error;
        lastTransportError = error;
        continue;
      }

      const inspection = inspect(result);
      if (inspection.success) return result;

      lastTransportError = undefined;
      const retryTime = retryTimeFromHeaderEntries(inspection.headers);
      if (earliestRetryTime !== null && (retryTime === null || retryTime >= earliestRetryTime)) {
        await discardFailure(env, inspection);
        continue;
      }

      await discardFailure(env, selectedDiscard);
      selected = result;
      selectedDiscard = inspection;
      earliestRetryTime = retryTime;
    }

    if (earliestRetryTime === null && lastTransportError !== undefined) throw lastTransportError;
    if (selected === undefined) {
      throw new Error(`invariant broken: ${invocationLabel} exhausted candidates with neither success nor failure`);
    }
    const terminal = selected;
    selected = undefined;
    selectedDiscard = undefined;
    return terminal;
  } finally {
    await discardFailure(env, selectedDiscard);
  }
};
