import { Bytes } from './bytes.ts';
import { InvalidFactValueError } from './errors.ts';
import { isDeferred, isManagedStream } from './handles.ts';
import type { Deferred, ManagedStream } from './handles.ts';
import { isSecret } from './secret.ts';
import type { Secret } from './secret.ts';
import type { ErrorSnapshot } from './snapshot-error.ts';

export type RawJson = { readonly rawJSON: string };
const rawJsonApi = JSON as JSON & { isRawJSON?: (value: unknown) => boolean };
export const isRawJson = (value: unknown): value is RawJson => rawJsonApi.isRawJSON?.(value) === true;
export type Facts = { readonly [key: string]: FactValue };
export type FactValue = null | undefined | boolean | number | string | bigint
  | Facts | readonly FactValue[] | RawJson | Bytes | Secret<unknown> | ErrorSnapshot
  | ManagedStream<unknown> | Deferred<unknown>;

export type Handed<T> = T & Record<string, FactValue>;

const validated = new WeakSet<object>();

const isPlain = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const isOpaque = (value: object): boolean =>
  value instanceof Bytes || isRawJson(value) || isSecret(value) || isDeferred(value);

export const freezeValue = <T>(value: T, path = 'facts'): T => {
  if (typeof value === 'object' && value !== null && validated.has(value)) return value;
  const visited = new Set<object>();

  const visit = (entry: unknown, at: string): void => {
    if (entry === null) return;
    switch (typeof entry) {
    case 'undefined':
    case 'boolean':
    case 'number':
    case 'string':
    case 'bigint':
      return;
    case 'object':
      break;
    default:
      throw new InvalidFactValueError(at, `${typeof entry} is not a fact value`);
    }
    if (validated.has(entry) || visited.has(entry) || isOpaque(entry) || isManagedStream(entry)) return;

    const array = Array.isArray(entry);
    if (array ? Object.getPrototypeOf(entry) !== Array.prototype : !isPlain(entry)) {
      throw new InvalidFactValueError(at, 'expected a plain object or array');
    }
    visited.add(entry);
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key === 'symbol') throw new InvalidFactValueError(at, `symbol key ${String(key)} is not allowed`);
      const property = Object.getOwnPropertyDescriptor(entry, key)!;
      const childPath = array ? `${at}[${key}]` : `${at}.${key}`;
      if (!('value' in property)) throw new InvalidFactValueError(childPath, 'accessors are not fact values');
      visit(property.value, childPath);
    }
  };

  visit(value, path);
  for (const object of visited) Object.freeze(object);
  for (const object of visited) validated.add(object);
  return value;
};

export const freezeFacts = (value: unknown, path: string): Facts => {
  if (typeof value !== 'object' || value === null || !isPlain(value) || isOpaque(value) || isManagedStream(value)) {
    throw new InvalidFactValueError(path, 'expected a fact dictionary');
  }
  return freezeValue(value, path) as Facts;
};

export const collectStreams = (facts: Facts): Set<ManagedStream<unknown>> => {
  const streams = new Set<ManagedStream<unknown>>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    if (isManagedStream(value)) {
      streams.add(value);
      return;
    }
    if (isOpaque(value)) return;
    visited.add(value);
    for (const key of Object.getOwnPropertyNames(value)) visit(Object.getOwnPropertyDescriptor(value, key)!.value);
  };
  visit(facts);
  return streams;
};
