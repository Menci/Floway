import type { InternalDebugError } from './error.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from './telemetry.ts';
import type { BillableUsage } from '@floway-dev/protocols/common';

export type HttpHead = Pick<Response, 'status' | 'headers'>;

export interface BufferedHttpResult {
  http: HttpHead;
  body: Uint8Array | null;
}

export const readResponseBody = async (response: Response): Promise<Uint8Array<ArrayBuffer> | null> =>
  response.body === null ? null : new Uint8Array(await response.arrayBuffer());

export const bufferedResultToResponse = (result: BufferedHttpResult): Response =>
  new Response(result.body === null ? null : result.body.slice().buffer, result.http);

export const decodeResponseBody = (body: BufferedHttpResult['body']): string =>
  body === null ? '' : new TextDecoder().decode(body);

export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  http?: HttpHead;
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
export interface ApiErrorResult extends BufferedHttpResult {
  type: 'api-error';
  source: 'upstream' | 'gateway';
  performance?: PerformanceTelemetryContext;
  upstreamId?: string;
}

// Gateway-side bug surface (parser crash, interceptor throw, etc.). The
// protocol's respond layer renders a debug envelope around `error`
// (stack, cause, target_api) rather than passing through a wire body —
// the shape differs from `ApiErrorResult` for that reason.
export interface InternalErrorResult {
  type: 'internal-error';
  http: HttpHead;
  error: InternalDebugError;
  performance?: PerformanceTelemetryContext;
}

// A buffered HTTP body for a measurement endpoint. The responder emits the
// bytes directly. `upstreamId` identifies responses produced by an upstream.
export interface PlainResult extends BufferedHttpResult {
  type: 'plain';
  upstreamId?: string;
}

export type ExecuteResult<T> = EventResult<T> | ApiErrorResult | InternalErrorResult;

export interface EventResultOptions {
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  http?: HttpHead;
}

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  options: EventResultOptions = {},
): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (options.performance !== undefined) result.performance = options.performance;
  if (options.finalMetadata !== undefined) result.finalMetadata = options.finalMetadata;
  if (options.http !== undefined) result.http = options.http;
  return result;
};

export const internalErrorResult = (status: number, error: InternalDebugError, performance?: PerformanceTelemetryContext): InternalErrorResult => ({
  type: 'internal-error',
  http: { status, headers: new Headers({ 'content-type': 'application/json' }) },
  error,
  ...(performance ? { performance } : {}),
});

export const plainResult = (http: HttpHead, body: BufferedHttpResult['body'], upstreamId?: string): PlainResult => ({
  type: 'plain',
  http,
  body,
  ...(upstreamId !== undefined ? { upstreamId } : {}),
});

export const readUpstreamApiError = async (response: Response, upstreamId?: string): Promise<ApiErrorResult> => ({
  type: 'api-error',
  source: 'upstream',
  http: { status: response.status, headers: new Headers(response.headers) },
  body: await readResponseBody(response),
  ...(upstreamId !== undefined ? { upstreamId } : {}),
});

// A response whose body is neither read nor cancelled keeps its transport
// alive: on the direct-connect egress the dialed socket is closed only from the
// body's own read-to-end or cancel path, so an abandoned response strands one
// socket for the life of the process. Every path that walks away from an
// upstream response goes through here.
export const discardUpstreamResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel();
};
