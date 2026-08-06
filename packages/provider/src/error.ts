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
  unreadable?: ErrorPropertyMarker[];
  target_api?: string;
}

type ErrorProperty = 'cause' | 'errors' | 'message' | 'name' | 'stack';

interface ErrorPropertyMarker {
  type: 'unreadable_error_property';
  property: ErrorProperty;
  valueType?: string;
}

interface SerializedErrorIdentity {
  name: string;
  message: string;
  stack?: string;
  unreadable?: ErrorPropertyMarker[];
}

interface SerializedError extends SerializedErrorIdentity {
  cause?: unknown;
  errors?: unknown[];
}

interface ErrorMemoEntry {
  reference: string;
  identity: SerializedErrorIdentity;
}

interface SerializationState {
  activeErrors: WeakSet<object>;
  errorMemo: WeakMap<object, ErrorMemoEntry>;
  nodes: number;
  remainingBytes: number;
  remainingStackBytes: number;
  remainingStringBytes: number;
}

type PropertyRead = { ok: true; value: unknown } | { ok: false };
type InstanceCheck = 'yes' | 'no' | 'unreadable';

type AggregateErrorEntrySnapshot =
  | { type: 'value'; value: unknown }
  | { type: 'unreadable'; index: number };

type AggregateErrorsSnapshot =
  | { type: 'values'; entries: AggregateErrorEntrySnapshot[]; total: number }
  | { type: 'invalid'; valueType: string }
  | { type: 'invalid-length'; valueType: string }
  | { type: 'unreadable' };

const MAX_SERIALIZED_CAUSE_DEPTH = 32;
const MAX_SERIALIZED_AGGREGATE_ERRORS = 32;
const MAX_SERIALIZED_NODES = 256;
const MAX_SERIALIZED_STRING_BYTES = 16 * 1024;
const MAX_SERIALIZED_STACK_BYTES = 24 * 1024;
const MAX_SERIALIZED_SINGLE_STRING_BYTES = 8 * 1024;
const MAX_SERIALIZED_VALUE_BYTES = 48 * 1024;
const MAX_INTERNAL_DEBUG_ERROR_BYTES = 64 * 1024;

const STRING_TRUNCATION_SUFFIX = '...[truncated]';
const STRING_BUDGET_MARKER = '[string budget exhausted]';

const nodeBudgetMarker = () => ({
  type: 'serialization_node_budget_exhausted',
  limit: MAX_SERIALIZED_NODES,
});

const valueByteBudgetMarker = () => ({
  type: 'serialization_byte_budget_exhausted',
  limit: MAX_SERIALIZED_VALUE_BYTES,
});

const readProperty = (value: object, property: PropertyKey): PropertyRead => {
  try {
    return { ok: true, value: Reflect.get(value, property) };
  } catch {
    return { ok: false };
  }
};

const checkInstance = (value: unknown, constructor: typeof Error | typeof AggregateError): InstanceCheck => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return 'no';
  try {
    return value instanceof constructor ? 'yes' : 'no';
  } catch {
    return 'unreadable';
  }
};

const utf8Width = (codePoint: number): number => {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
};

const utf8Prefix = (value: string, maxBytes: number): { bytes: number; complete: boolean; end: number } => {
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const codePoint = value.codePointAt(end)!;
    const width = utf8Width(codePoint);
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return { bytes, complete: end === value.length, end };
};

const consumeString = (state: SerializationState, value: string, stack = false): string => {
  const remaining = stack ? state.remainingStackBytes : state.remainingStringBytes;
  const available = Math.min(
    MAX_SERIALIZED_SINGLE_STRING_BYTES,
    remaining,
    state.remainingBytes,
  );
  if (available <= 0) return STRING_BUDGET_MARKER;

  const complete = utf8Prefix(value, available);
  if (complete.complete) {
    if (stack) state.remainingStackBytes -= complete.bytes;
    else state.remainingStringBytes -= complete.bytes;
    state.remainingBytes -= complete.bytes;
    return value;
  }

  const suffixBytes = utf8Prefix(STRING_TRUNCATION_SUFFIX, Number.POSITIVE_INFINITY).bytes;
  const prefix = utf8Prefix(value, Math.max(0, available - suffixBytes));
  const truncated = `${value.slice(0, prefix.end)}${STRING_TRUNCATION_SUFFIX}`;
  const used = prefix.bytes + suffixBytes;
  if (stack) state.remainingStackBytes = Math.max(0, state.remainingStackBytes - used);
  else state.remainingStringBytes = Math.max(0, state.remainingStringBytes - used);
  state.remainingBytes = Math.max(0, state.remainingBytes - used);
  return truncated;
};

const takeNode = (state: SerializationState): boolean => {
  if (state.nodes >= MAX_SERIALIZED_NODES) return false;
  state.nodes++;
  return true;
};

const unreadableProperty = (property: ErrorProperty, valueType?: string): ErrorPropertyMarker => ({
  type: 'unreadable_error_property',
  property,
  ...(valueType === undefined ? {} : { valueType }),
});

const readIdentityString = (
  state: SerializationState,
  error: object,
  property: 'message' | 'name' | 'stack',
): { marker?: ErrorPropertyMarker; value?: string } => {
  const result = readProperty(error, property);
  if (!result.ok) {
    return {
      marker: unreadableProperty(property),
      value: `[unreadable Error.${property}]`,
    };
  }
  if (property === 'stack' && result.value === undefined) return {};
  if (typeof result.value !== 'string') {
    return {
      marker: unreadableProperty(property, typeof result.value),
      value: `[unreadable Error.${property}]`,
    };
  }
  return { value: consumeString(state, result.value, property === 'stack') };
};

const snapshotErrorIdentity = (state: SerializationState, error: object): SerializedErrorIdentity => {
  const name = readIdentityString(state, error, 'name');
  const message = readIdentityString(state, error, 'message');
  const stack = readIdentityString(state, error, 'stack');
  const unreadable = [name.marker, message.marker, stack.marker].filter(marker => marker !== undefined);
  return {
    name: name.value!,
    message: message.value!,
    ...(stack.value === undefined ? {} : { stack: stack.value }),
    ...(unreadable.length === 0 ? {} : { unreadable }),
  };
};

const snapshotAggregateErrors = (error: object): AggregateErrorsSnapshot => {
  const errorsResult = readProperty(error, 'errors');
  if (!errorsResult.ok) return { type: 'unreadable' };
  const errors = errorsResult.value;

  try {
    if (!Array.isArray(errors)) return { type: 'invalid', valueType: typeof errors };
  } catch {
    return { type: 'unreadable' };
  }

  const lengthResult = readProperty(errors, 'length');
  if (!lengthResult.ok) return { type: 'unreadable' };
  if (typeof lengthResult.value !== 'number'
    || !Number.isSafeInteger(lengthResult.value)
    || lengthResult.value < 0) {
    return { type: 'invalid-length', valueType: typeof lengthResult.value };
  }

  const total = lengthResult.value;
  const entries: AggregateErrorEntrySnapshot[] = [];
  for (let index = 0; index < Math.min(total, MAX_SERIALIZED_AGGREGATE_ERRORS); index++) {
    const entry = readProperty(errors, String(index));
    entries.push(entry.ok ? { type: 'value', value: entry.value } : { type: 'unreadable', index });
  }
  return { type: 'values', entries, total };
};

const serializeNonErrorValue = (value: unknown, state: SerializationState): unknown => {
  const nodeMarker = nodeBudgetMarker();
  const referenceMarker = { type: 'non_error_reference' };
  const markerObjects = new Set<object>([nodeMarker, referenceMarker]);
  const seen = new WeakSet<object>();
  let rootObjectSeen = false;

  try {
    const serialized = JSON.stringify(value, (_key, current: unknown): unknown => {
      if (typeof current === 'string') {
        if (current === nodeMarker.type || current === referenceMarker.type) return current;
        return consumeString(state, current);
      }
      if ((typeof current !== 'object' || current === null) && typeof current !== 'function') return current;
      if (markerObjects.has(current)) return current;
      if (seen.has(current)) return referenceMarker;
      seen.add(current);
      if (!rootObjectSeen) {
        rootObjectSeen = true;
        return current;
      }
      return takeNode(state) ? current : nodeMarker;
    });
    if (serialized === undefined) return { type: 'unserializable_cause', valueType: typeof value };
    const size = utf8Prefix(serialized, state.remainingBytes);
    if (!size.complete) {
      state.remainingBytes = 0;
      return valueByteBudgetMarker();
    }
    state.remainingBytes -= size.bytes;
    return JSON.parse(serialized) as unknown;
  } catch {
    return { type: 'unserializable_cause', valueType: typeof value };
  }
};

const serializeValue = (
  value: unknown,
  state: SerializationState,
  depth: number,
  reference: string,
): unknown => {
  if (value === undefined || value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return consumeString(state, value);

  const errorCheck = checkInstance(value, Error);
  if (errorCheck === 'unreadable') return { type: 'unreadable_error_value' };
  if (errorCheck === 'no') {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      if (!takeNode(state)) return nodeBudgetMarker();
    }
    return serializeNonErrorValue(value, state);
  }

  const error = value as Error;
  if (!takeNode(state)) return nodeBudgetMarker();
  const existing = state.errorMemo.get(error);
  if (existing !== undefined) {
    if (state.activeErrors.has(error)) {
      return {
        type: 'circular_reference',
        reference: existing.reference,
        name: existing.identity.name,
        message: existing.identity.message,
      };
    }
    return { type: 'error_reference', reference: existing.reference };
  }

  const identity = snapshotErrorIdentity(state, error);
  if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) {
    return { type: 'depth_limit', limit: MAX_SERIALIZED_CAUSE_DEPTH, ...identity };
  }

  const memo: ErrorMemoEntry = { reference, identity };
  state.errorMemo.set(error, memo);
  state.activeErrors.add(error);
  try {
    const causeSnapshot = readProperty(error, 'cause');
    const aggregateCheck = checkInstance(error, AggregateError);
    const errorsSnapshot = aggregateCheck === 'yes' ? snapshotAggregateErrors(error) : undefined;
    const cause = causeSnapshot.ok
      ? serializeValue(causeSnapshot.value, state, depth + 1, `${reference}.cause`)
      : unreadableProperty('cause');

    let errors: unknown[] | undefined;
    if (aggregateCheck === 'unreadable') {
      errors = [{ type: 'unreadable_aggregate_errors' }];
    } else if (errorsSnapshot?.type === 'unreadable') {
      errors = [{ type: 'unreadable_aggregate_errors' }];
    } else if (errorsSnapshot?.type === 'invalid') {
      errors = [{ type: 'invalid_aggregate_errors', valueType: errorsSnapshot.valueType }];
    } else if (errorsSnapshot?.type === 'invalid-length') {
      errors = [{ type: 'invalid_aggregate_errors_length', valueType: errorsSnapshot.valueType }];
    } else if (errorsSnapshot?.type === 'values') {
      errors = [];
      for (let index = 0; index < errorsSnapshot.entries.length; index++) {
        if (state.nodes >= MAX_SERIALIZED_NODES) {
          errors.push(nodeBudgetMarker());
          break;
        }
        const entry = errorsSnapshot.entries[index];
        errors.push(entry.type === 'value'
          ? serializeValue(entry.value, state, depth + 1, `${reference}.errors[${index}]`)
          : { type: 'unreadable_aggregate_error', index: entry.index });
      }
      if (errorsSnapshot.total > MAX_SERIALIZED_AGGREGATE_ERRORS) {
        errors.push({
          type: 'aggregate_errors_truncated',
          limit: MAX_SERIALIZED_AGGREGATE_ERRORS,
          total: errorsSnapshot.total,
          omitted: errorsSnapshot.total - MAX_SERIALIZED_AGGREGATE_ERRORS,
        });
      }
    }

    return {
      ...identity,
      cause,
      ...(errors === undefined ? {} : { errors }),
    };
  } finally {
    state.activeErrors.delete(error);
  }
};

const normalizedThrownError = (error: unknown): Error => {
  const check = checkInstance(error, Error);
  if (check === 'yes') return error as Error;
  if (check === 'unreadable') {
    return new Error('[unreadable thrown value]', { cause: { type: 'unreadable_error_value' } });
  }
  try {
    return new Error(String(error));
  } catch {
    return new Error('[unreadable thrown value]', { cause: { type: 'unreadable_error_value' } });
  }
};

const withinOutputBudget = (error: InternalDebugError): boolean => {
  try {
    const serialized = JSON.stringify(error);
    return utf8Prefix(serialized, MAX_INTERNAL_DEBUG_ERROR_BYTES).complete;
  } catch {
    return false;
  }
};

const outputBudgetFallback = (error: InternalDebugError): InternalDebugError => ({
  type: 'internal_error',
  name: error.name,
  message: error.message,
  ...(error.stack === undefined ? {} : { stack: error.stack }),
  cause: {
    type: 'internal_debug_error_output_truncated',
    limit: MAX_INTERNAL_DEBUG_ERROR_BYTES,
  },
  ...(error.unreadable === undefined ? {} : { unreadable: error.unreadable }),
  ...(error.target_api === undefined ? {} : { target_api: error.target_api }),
});

const serializedRootError = (value: unknown): SerializedError => {
  if (typeof value === 'object'
    && value !== null
    && 'name' in value
    && typeof value.name === 'string'
    && 'message' in value
    && typeof value.message === 'string') {
    return value as SerializedError;
  }
  return {
    name: 'Error',
    message: '[unreadable thrown value]',
    cause: value,
  };
};

export const toInternalDebugError = (error: unknown, targetApi?: string): InternalDebugError => {
  const state: SerializationState = {
    activeErrors: new WeakSet(),
    errorMemo: new WeakMap(),
    nodes: 0,
    remainingBytes: MAX_SERIALIZED_VALUE_BYTES,
    remainingStackBytes: MAX_SERIALIZED_STACK_BYTES,
    remainingStringBytes: MAX_SERIALIZED_STRING_BYTES,
  };
  const serialized = serializedRootError(serializeValue(normalizedThrownError(error), state, -1, '$'));
  const debug: InternalDebugError = {
    ...serialized,
    type: 'internal_error',
    ...(targetApi ? { target_api: consumeString(state, targetApi) } : {}),
  };
  return withinOutputBudget(debug) ? debug : outputBudgetFallback(debug);
};
