export interface InternalDebugError {
  type: 'internal_error';
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  target_api?: string;
}

export const internalDebugErrorFields = ({ name, stack, cause, target_api }: InternalDebugError): Pick<InternalDebugError, 'name' | 'stack' | 'cause' | 'target_api'> => ({
  name,
  ...(stack === undefined ? {} : { stack }),
  cause,
  ...(target_api === undefined ? {} : { target_api }),
});

export const protocolErrorDebugFields = (diagnostic?: InternalDebugError) =>
  diagnostic === undefined ? {} : { provider_specific_fields: internalDebugErrorFields(diagnostic) };

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
    ...(known.stack === undefined ? {} : { stack: known.stack }),
    cause: serializeCause(known.cause),
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
