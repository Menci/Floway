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

const MAX_SERIALIZED_CAUSE_DEPTH = 32;

const serializedErrorIdentity = (error: Error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
});

const serializeCause = (cause: unknown, ancestors: ReadonlySet<Error>, depth = 0): unknown => {
  if (cause instanceof Error) {
    const identity = serializedErrorIdentity(cause);
    if (ancestors.has(cause)) return { type: 'circular_reference', ...identity };
    if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
      return { type: 'depth_limit', limit: MAX_SERIALIZED_CAUSE_DEPTH, ...identity };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(cause);
    return { ...identity, cause: serializeCause(cause.cause, nextAncestors, depth + 1) };
  }

  if (cause === undefined || cause === null || typeof cause === 'string' || typeof cause === 'number' || typeof cause === 'boolean') return cause;
  try {
    const serialized = JSON.stringify(cause);
    if (serialized !== undefined) return JSON.parse(serialized) as unknown;
  } catch {
    // Fall through to the stable marker below.
  }
  return { type: 'unserializable_cause', valueType: typeof cause };
};

export const toInternalDebugError = (error: unknown, targetApi?: string): InternalDebugError => {
  const known = error instanceof Error ? error : new Error(String(error));

  return {
    type: 'internal_error',
    ...serializedErrorIdentity(known),
    cause: serializeCause(known.cause, new Set([known])),
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
