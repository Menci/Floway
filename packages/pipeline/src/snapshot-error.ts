import { DeferredOwnershipError, InvalidFactValueError, StreamOwnershipError } from './errors.ts';
import { copyFactValue, freezeValue } from './facts.ts';
import type { FactValue } from './facts.ts';

export interface ErrorSnapshot {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: ErrorSnapshot | FactValue;
  readonly errors?: readonly ErrorSnapshot[];
  readonly fields?: Readonly<Record<string, FactValue>>;
}

const render = (value: unknown): string => {
  try {
    return String(value);
  } catch (_renderingError: unknown) {
    return '[unprintable value]';
  }
};

export const snapshotErrorIn = (error: unknown, membership?: object): ErrorSnapshot => {
  const ancestors = new WeakSet<Error>();
  const seen = new WeakMap<Error, ErrorSnapshot>();
  const copies = new WeakMap<object, object>();
  const factOrString = (value: unknown): FactValue => {
    try {
      return freezeValue(copyFactValue(value, copies), 'error', membership) as FactValue;
    } catch (error) {
      if (error instanceof InvalidFactValueError || error instanceof StreamOwnershipError || error instanceof DeferredOwnershipError) return render(value);
      throw error;
    }
  };
  const snapshot = (value: unknown): ErrorSnapshot => {
    if (!(value instanceof Error)) return freezeValue({ name: 'Error', message: render(value) });
    if (ancestors.has(value)) return freezeValue({ name: 'Error', message: '[Circular error]' });
    const earlier = seen.get(value);
    if (earlier !== undefined) return earlier;

    ancestors.add(value);
    const fields: Record<string, FactValue> = Object.create(null);
    for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (property.enumerable && 'value' in property) fields[key] = factOrString(property.value);
    }
    const result = freezeValue<ErrorSnapshot>({
      name: render(value.name),
      message: render(value.message),
      ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
      ...('cause' in value ? { cause: value.cause instanceof Error ? snapshot(value.cause) : factOrString(value.cause) } : {}),
      ...(value instanceof AggregateError ? { errors: value.errors.map(snapshot) } : {}),
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
    });
    ancestors.delete(value);
    seen.set(value, result);
    return result;
  };
  try {
    return snapshot(error);
  } catch (_snapshotError: unknown) {
    return freezeValue({ name: 'Error', message: render(error) });
  }
};

export const snapshotError = (error: unknown): ErrorSnapshot => snapshotErrorIn(error);
