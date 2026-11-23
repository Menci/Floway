export const UPSTREAM_TRANSPORT_ERROR = Symbol('floway.http.upstream-transport-error');

export class UpstreamTransportError extends Error {
  override readonly name = 'UpstreamTransportError';

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export const isUpstreamTransportError = (error: unknown): error is Error =>
  error instanceof UpstreamTransportError
  || (error instanceof Error && (error as { readonly [UPSTREAM_TRANSPORT_ERROR]?: boolean })[UPSTREAM_TRANSPORT_ERROR] === true)
  || (error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isUpstreamTransportError));
