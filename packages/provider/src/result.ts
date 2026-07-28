import type { InternalDebugError } from './error.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from './telemetry.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';

export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  // Raw upstream response headers for the source-side `respond` layer to
  // forward (blocklist in gateway `shared/respond.ts`). Absent on
  // lifted/synthesized streams that have no upstream Response behind them.
  headers?: Headers;
}

export interface EventResultMetadata {
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  // What the upstream turn cost, read from the upstream's own usage. Absent
  // until the stream that reports it has been consumed.
  billableUsage?: BillableUsage;
}

// HTTP-shaped error envelope the respond layer forwards to the client
// verbatim (status + headers + body). `source` distinguishes a real upstream
// non-2xx from a gateway-synthesized envelope (model not routable, missing
// stored item, server-tool input rejected, etc.) so observers like the
// request dump can record the failure category truthfully rather than
// labelling every 4xx as `upstream error N`. `upstreamId` is set on real
// upstream 4xx/5xx (`source === 'upstream'`) so the dump row can attribute the
// failure to its source; it is absent on gateway-synthesized envelopes that
// never reached an upstream.
export interface ApiErrorResult {
  type: 'api-error';
  source: 'upstream' | 'gateway';
  status: number;
  headers: Headers;
  body: Uint8Array;
  performance?: PerformanceTelemetryContext;
  upstreamId?: string;
}

// Gateway-side bug surface (parser crash, interceptor throw, etc.). The
// protocol's respond layer renders a debug envelope around `error`
// (stack, cause, target_api) rather than passing through a wire body —
// the shape differs from `ApiErrorResult` for that reason.
export interface InternalErrorResult {
  type: 'internal-error';
  status: number;
  error: InternalDebugError;
  performance?: PerformanceTelemetryContext;
}

// A fully-shaped non-streaming success body — the output of a source endpoint
// that measures rather than generates (count_tokens). It is NOT an
// `ExecuteResult`: the target emit/interceptor layer never produces one. The
// orchestrator passes it straight to `respond` without persistence, and
// `respond` emits it verbatim. `upstreamId` is present when the body came from
// a real upstream call and absent for gateway-synthesized envelopes (rewrite
// failures, internal-debug bodies).
export interface PlainResult {
  type: 'plain';
  status: number;
  headers: Headers;
  body: Uint8Array;
  upstreamId?: string;
}

export type ExecuteResult<T> = EventResult<T> | ApiErrorResult | InternalErrorResult;

export interface EventResultOptions {
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  headers?: Headers;
}

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  options: EventResultOptions = {},
): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (options.performance !== undefined) result.performance = options.performance;
  if (options.finalMetadata !== undefined) result.finalMetadata = options.finalMetadata;
  if (options.headers !== undefined) result.headers = options.headers;
  return result;
};

export const internalErrorResult = (status: number, error: InternalDebugError, performance?: PerformanceTelemetryContext): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  ...(performance ? { performance } : {}),
});

export const plainResult = (status: number, headers: Headers, body: Uint8Array, upstreamId?: string): PlainResult => ({
  type: 'plain',
  status,
  headers,
  body,
  ...(upstreamId !== undefined ? { upstreamId } : {}),
});

export const readUpstreamApiError = async (response: Response, upstreamId?: string): Promise<ApiErrorResult> => ({
  type: 'api-error',
  source: 'upstream',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
  ...(upstreamId !== undefined ? { upstreamId } : {}),
});

export const apiErrorToResponse = (error: ApiErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  });

export const decodeApiErrorBody = (error: ApiErrorResult): string => new TextDecoder().decode(error.body);
