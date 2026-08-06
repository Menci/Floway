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
  errors?: unknown[];
  target_api?: string;
}

const MAX_SERIALIZED_CAUSE_DEPTH = 32;

const serializedErrorIdentity = (error: Error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
});

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
  errors?: unknown[];
}

const serializeValue = (value: unknown, ancestors: ReadonlySet<Error>, depth: number): unknown => {
  if (value instanceof Error) {
    const identity = serializedErrorIdentity(value);
    if (ancestors.has(value)) return { type: 'circular_reference', ...identity };
    if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
      return { type: 'depth_limit', limit: MAX_SERIALIZED_CAUSE_DEPTH, ...identity };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    return {
      ...identity,
      cause: serializeValue(value.cause, nextAncestors, depth + 1),
      ...(value instanceof AggregateError
        ? { errors: value.errors.map(error => serializeValue(error, nextAncestors, depth + 1)) }
        : {}),
    };
  }

  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return JSON.parse(serialized) as unknown;
  } catch {
    // Fall through to the stable marker below.
  }
  return { type: 'unserializable_cause', valueType: typeof value };
};

export const toInternalDebugError = (error: unknown, targetApi?: string): InternalDebugError => {
  const known = error instanceof Error ? error : new Error(String(error));
  const serialized = serializeValue(known, new Set(), -1) as SerializedError;

  return {
    type: 'internal_error',
    ...serialized,
    ...(targetApi ? { target_api: targetApi } : {}),
  };
};
