// Errors that bubble out of source/target emit or interceptors and need a
// structured envelope for the api debug response. The target_api lane is
// typed as a free string here so the package stays decoupled from the
// api-internal serve-api unions — the api always passes the narrowed value
// it owns.
export interface InternalDebugError {
  type: 'internal_error';
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  target_api?: string;
}

export const internalDebugErrorFields = (error: InternalDebugError): Pick<InternalDebugError, 'name' | 'stack' | 'cause' | 'target_api'> => ({
  name: error.name,
  stack: error.stack,
  cause: error.cause,
  target_api: error.target_api,
});

const serializeCause = (cause: unknown): unknown => {
  if (!(cause instanceof Error)) return cause;

  return {
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
    cause: serializeCause(cause.cause),
  };
};

export const toInternalDebugError = (error: unknown, targetApi?: string): InternalDebugError => {
  const known = error instanceof Error ? error : new Error(String(error));

  return {
    type: 'internal_error',
    name: known.name,
    message: known.message,
    stack: known.stack,
    cause: serializeCause(known.cause),
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
