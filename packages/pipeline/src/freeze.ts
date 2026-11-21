import { InvalidFactValueError } from './errors.ts';
import { isSecret } from './secret.ts';
import { STREAM_BRAND } from './types.ts';
import type { ManagedStream } from './types.ts';

type RawJson = { readonly rawJSON: string };

const jsonWithRawCheck = JSON as typeof JSON & {
  isRawJSON?: (value: unknown) => boolean;
};

export const isRawJson = (value: unknown): value is RawJson =>
  jsonWithRawCheck.isRawJSON?.(value) === true;

export const isManagedStream = (value: unknown): value is ManagedStream<unknown> =>
  typeof value === 'object' && value !== null && STREAM_BRAND in value;

const isPlainObject = (value: object): boolean => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const invalid = (path: string, value: object): never => {
  throw new InvalidFactValueError(path, `unsupported ${Object.prototype.toString.call(value)} value`);
};

const freezeObjectProperties = (
  value: Record<string, unknown>,
  path: string,
  seen: WeakSet<object>,
): void => {
  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    freezeValue(value[key], childPath, seen);
  }
};

const walkContainer = (
  value: object,
  visit: (value: unknown) => void,
  seen: WeakSet<object>,
): void => {
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    if ('cause' in value) visit(value.cause);
    if (Array.isArray((value as AggregateError).errors)) {
      for (const error of (value as AggregateError).errors) visit(error);
    }
    for (const key of Object.keys(value)) visit((value as unknown as Record<string, unknown>)[key]);
    return;
  }

  const entries = Array.isArray(value) ? value : Object.values(value);
  for (const entry of entries) visit(entry);
};

export const freezeValue = <T>(value: T, path = 'value', seen = new WeakSet<object>()): T => {
  if (value === null || value === undefined) return value;

  const kind = typeof value;
  if (kind === 'boolean' || kind === 'number' || kind === 'string' || kind === 'bigint') return value;
  if (kind === 'function' || kind === 'symbol') {
    throw new InvalidFactValueError(path, `${kind} values are not supported`);
  }
  if (kind !== 'object') {
    throw new InvalidFactValueError(path, `unsupported ${kind} value`);
  }

  const object = value as object;
  if (seen.has(object)) return value;

  if (isSecret(object) || isManagedStream(object) || isRawJson(object)) {
    seen.add(object);
    return value;
  }

  if (object instanceof Uint8Array) {
    seen.add(object);
    return value;
  }

  if (ArrayBuffer.isView(object)) {
    throw new InvalidFactValueError(path, `unsupported ${Object.prototype.toString.call(object)} value; only Uint8Array is allowed`);
  }
  if (
    object instanceof ArrayBuffer
    || (typeof SharedArrayBuffer !== 'undefined' && object instanceof SharedArrayBuffer)
  ) {
    throw new InvalidFactValueError(path, `unsupported ${Object.prototype.toString.call(object)} value`);
  }

  if (object instanceof Error) {
    seen.add(object);
    if ('cause' in object) freezeValue(object.cause, `${path}.cause`, seen);
    if (Array.isArray((object as AggregateError).errors)) {
      for (let index = 0; index < (object as AggregateError).errors.length; index++) {
        freezeValue((object as AggregateError).errors[index], `${path}.errors[${index}]`, seen);
      }
    }
    freezeObjectProperties(object as unknown as Record<string, unknown>, path, seen);
    Object.freeze(object);
    return value;
  }

  if (Array.isArray(object)) {
    seen.add(object);
    for (let index = 0; index < object.length; index++) {
      freezeValue(object[index], `${path}[${index}]`, seen);
    }
    Object.freeze(object);
    return value;
  }

  if (isPlainObject(object)) {
    const symbols = Object.getOwnPropertySymbols(object);
    if (symbols.length > 0) {
      throw new InvalidFactValueError(path, `plain objects cannot contain symbol keys (${String(symbols[0])})`);
    }
    seen.add(object);
    freezeObjectProperties(object as Record<string, unknown>, path, seen);
    Object.freeze(object);
    return value;
  }

  return invalid(path, object);
};

export const collectManagedStreams = (value: unknown): ManagedStream<unknown>[] => {
  const streams = new Set<ManagedStream<unknown>>();
  const seen = new WeakSet<object>();

  const visit = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null) return;
    if (isManagedStream(entry)) {
      streams.add(entry);
      return;
    }
    if (isSecret(entry) || seen.has(entry)) return;

    if (entry instanceof Error || Array.isArray(entry) || isPlainObject(entry)) {
      walkContainer(entry, visit, seen);
    }
  };

  visit(value);
  return [...streams];
};

const containsBytes = (value: unknown, cache: WeakMap<object, boolean>, visiting: WeakSet<object>): boolean => {
  if (!(value instanceof Uint8Array)) {
    if (typeof value !== 'object' || value === null) return false;
    const cached = cache.get(value);
    if (cached !== undefined) return cached;
    if (visiting.has(value)) return false;
    visiting.add(value);
    const children = value instanceof Error
      ? [
          ...('cause' in value ? [value.cause] : []),
          ...(Array.isArray((value as AggregateError).errors) ? (value as AggregateError).errors : []),
          ...Object.values(value as unknown as Record<string, unknown>),
        ]
      : Array.isArray(value) || isPlainObject(value)
        ? Array.isArray(value) ? value : Object.values(value)
        : [];
    const result = children.some(child => containsBytes(child, cache, visiting));
    visiting.delete(value);
    cache.set(value, result);
    return result;
  }
  return true;
};

interface TraceSnapshotCache {
  readonly copies: WeakMap<object, object>;
  readonly bytePresence: WeakMap<object, boolean>;
}

const snapshotCaches = new WeakMap<WeakMap<object, object>, TraceSnapshotCache>();

const cachesFor = (copies: WeakMap<object, object>): TraceSnapshotCache => {
  const existing = snapshotCaches.get(copies);
  if (existing) return existing;
  const created = { copies, bytePresence: new WeakMap<object, boolean>() };
  snapshotCaches.set(copies, created);
  return created;
};

export const snapshotTraceValue = <T>(
  value: T,
  cache = new WeakMap<object, object>(),
): T => {
  const caches = cachesFor(cache);
  if (value instanceof Uint8Array) {
    const memoized = caches.copies.get(value);
    if (memoized !== undefined) return memoized as T;
    const copy = value.slice();
    caches.copies.set(value, copy);
    return copy as T;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (isSecret(value) || isManagedStream(value) || isRawJson(value)) return value;
  if (!containsBytes(value, caches.bytePresence, new WeakSet())) return value;

  const memoized = caches.copies.get(value);
  if (memoized !== undefined) return memoized as T;

  if (value instanceof Error) {
    const copy = new Error(value.message, {
      ...('cause' in value ? { cause: snapshotTraceValue(value.cause, caches.copies) } : {}),
    });
    copy.name = value.name;
    if ('stack' in value) copy.stack = value.stack;
    if (value instanceof AggregateError) {
      Object.defineProperty(copy, 'errors', {
        configurable: true,
        enumerable: false,
        value: Object.freeze(value.errors.map(error => snapshotTraceValue(error, caches.copies))),
        writable: true,
      });
    }
    caches.copies.set(value, copy);
    for (const key of Object.keys(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: snapshotTraceValue((value as unknown as Record<string, unknown>)[key], caches.copies),
        writable: true,
      });
    }
    return Object.freeze(copy) as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    caches.copies.set(value, copy);
    for (const child of value) copy.push(snapshotTraceValue(child, caches.copies));
    return Object.freeze(copy) as T;
  }

  if (isPlainObject(value)) {
    const copy: Record<string, unknown> = {};
    caches.copies.set(value, copy);
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: snapshotTraceValue(child, caches.copies),
        writable: true,
      });
    }
    return Object.freeze(copy) as T;
  }

  return value;
};
