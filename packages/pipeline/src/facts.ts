import { Bytes } from './bytes.ts';
import { DeferredOwnershipError, InvalidFactValueError, StreamOwnershipError } from './errors.ts';
import { deferreds, isDeferred, isManagedStream, managedStreams } from './handles.ts';
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

const validated = new WeakSet<object>();
const validatedData = new WeakSet<object>();
const validatedByRun = new WeakMap<object, WeakSet<object>>();

const isPlain = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const isOpaque = (value: object): boolean => value instanceof Bytes || isRawJson(value) || isSecret(value);

export const copyFactValue = (value: unknown, copies: WeakMap<object, object>): unknown => {
  if (typeof value !== 'object' || value === null || isOpaque(value) || isManagedStream(value) || isDeferred(value)) return value;
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlain(value)) return value;
  const previous = copies.get(value);
  if (previous !== undefined) return previous;
  const copy: object = array ? [] : Object.create(Object.getPrototypeOf(value));
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ('value' in descriptor) descriptor.value = copyFactValue(descriptor.value, copies);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
};

const cacheFor = (policy: object | 'data' | undefined): WeakSet<object> => {
  if (policy === undefined) return validated;
  if (policy === 'data') return validatedData;
  let cache = validatedByRun.get(policy);
  if (!cache) validatedByRun.set(policy, cache = new WeakSet());
  return cache;
};

export const freezeValue = <T>(value: T, path = 'facts', policy?: object | 'data'): T => {
  const cache = cacheFor(policy);
  if (typeof value === 'object' && value !== null && (validatedData.has(value) || cache.has(value))) return value;
  const visited = new Set<object>();
  let dataOnly = true;

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
    if (isManagedStream(entry)) {
      if (policy === 'data') throw new InvalidFactValueError(at, 'stream and deferred handles are not data');
      if (policy !== undefined && managedStreams.get(entry) !== policy) throw new StreamOwnershipError(entry.label, at);
      dataOnly = false;
      return;
    }
    if (isDeferred(entry)) {
      if (policy === 'data') throw new InvalidFactValueError(at, 'stream and deferred handles are not data');
      if (policy !== undefined && deferreds.get(entry) !== policy) throw new DeferredOwnershipError(entry.name, at);
      dataOnly = false;
      return;
    }
    if (validatedData.has(entry) || visited.has(entry) || isOpaque(entry)) return;
    if (cache.has(entry)) {
      dataOnly = false;
      return;
    }

    const array = Array.isArray(entry);
    if (array ? Object.getPrototypeOf(entry) !== Array.prototype : !isPlain(entry)) {
      throw new InvalidFactValueError(at, 'expected a plain object or array');
    }
    visited.add(entry);
    for (const key of Reflect.ownKeys(entry)) {
      if (typeof key === 'symbol') throw new InvalidFactValueError(at, `symbol key ${String(key)} is not allowed`);
      if (array && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(entry, key)!;
      const childPath = array ? `${at}[${key}]` : `${at}.${key}`;
      if (!('value' in property)) throw new InvalidFactValueError(childPath, 'accessors are not fact values');
      if (!property.enumerable) throw new InvalidFactValueError(childPath, 'non-enumerable properties are not fact values');
      visit(property.value, childPath);
    }
  };

  visit(value, path);
  for (const object of visited) Object.freeze(object);
  for (const object of visited) {
    cache.add(object);
    if (dataOnly) validatedData.add(object);
  }
  return value;
};

export const freezeData = <T>(value: T, path: string): T => freezeValue(value, path, 'data');

export const freezeFacts = (value: unknown, path: string, membership: object): Facts => {
  if (typeof value !== 'object' || value === null || !isPlain(value) || isOpaque(value) || isManagedStream(value) || isDeferred(value)) {
    throw new InvalidFactValueError(path, 'expected a fact dictionary');
  }
  return freezeValue(value, path, membership) as Facts;
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
    if (isOpaque(value) || isDeferred(value)) return;
    visited.add(value);
    for (const key of Object.getOwnPropertyNames(value)) visit(Object.getOwnPropertyDescriptor(value, key)!.value);
  };
  visit(facts);
  return streams;
};
