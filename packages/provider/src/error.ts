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
const MAX_SERIALIZED_AGGREGATE_ERRORS = 32;

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

type AggregateErrorEntrySnapshot =
  | { type: 'value'; value: unknown }
  | { type: 'unreadable'; index: number };

type AggregateErrorsSnapshot =
  | { type: 'values'; entries: AggregateErrorEntrySnapshot[]; total: number }
  | { type: 'invalid'; valueType: string }
  | { type: 'unreadable' };

const snapshotAggregateErrors = (error: AggregateError): AggregateErrorsSnapshot => {
  let errors: unknown;
  try {
    errors = Reflect.get(error, 'errors');
  } catch {
    return { type: 'unreadable' };
  }

  try {
    if (!Array.isArray(errors)) return { type: 'invalid', valueType: typeof errors };
  } catch {
    return { type: 'unreadable' };
  }

  let total: number;
  try {
    total = errors.length;
  } catch {
    return { type: 'unreadable' };
  }

  const entries: AggregateErrorEntrySnapshot[] = [];
  for (let index = 0; index < Math.min(total, MAX_SERIALIZED_AGGREGATE_ERRORS); index++) {
    try {
      entries.push({ type: 'value', value: Reflect.get(errors, String(index)) });
    } catch {
      entries.push({ type: 'unreadable', index });
    }
  }
  return { type: 'values', entries, total };
};

const serializeValue = (value: unknown, ancestors: ReadonlySet<Error>, depth: number): unknown => {
  if (value instanceof Error) {
    const identity = serializedErrorIdentity(value);
    if (ancestors.has(value)) return { type: 'circular_reference', ...identity };
    if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
      return { type: 'depth_limit', limit: MAX_SERIALIZED_CAUSE_DEPTH, ...identity };
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    let errors: unknown[] | undefined;
    if (value instanceof AggregateError) {
      const snapshot = snapshotAggregateErrors(value);
      if (snapshot.type === 'unreadable') {
        errors = [{ type: 'unreadable_aggregate_errors' }];
      } else if (snapshot.type === 'invalid') {
        errors = [{ type: 'invalid_aggregate_errors', valueType: snapshot.valueType }];
      } else {
        errors = snapshot.entries.map(entry => entry.type === 'value'
          ? serializeValue(entry.value, nextAncestors, depth + 1)
          : { type: 'unreadable_aggregate_error', index: entry.index });
        if (snapshot.total > MAX_SERIALIZED_AGGREGATE_ERRORS) {
          errors.push({
            type: 'aggregate_errors_truncated',
            limit: MAX_SERIALIZED_AGGREGATE_ERRORS,
            total: snapshot.total,
            omitted: snapshot.total - MAX_SERIALIZED_AGGREGATE_ERRORS,
          });
        }
      }
    }
    return {
      ...identity,
      cause: serializeValue(value.cause, nextAncestors, depth + 1),
      ...(errors === undefined ? {} : { errors }),
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
