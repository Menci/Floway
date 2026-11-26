import { secretValue } from './secret.ts';
import type { Facts } from './values.ts';

const frozen = new WeakSet<object>();

export const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

export const objectChildren = function* (object: object): Generator<object> {
  const marked = secretValue(object);
  if (isObject(marked)) yield marked;
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && 'value' in descriptor && isObject(descriptor.value)) yield descriptor.value;
  }
  if (object instanceof Map) {
    for (const [key, value] of object as Map<unknown, unknown>) {
      if (isObject(key)) yield key;
      if (isObject(value)) yield value;
    }
  } else if (object instanceof Set) {
    for (const value of object as Set<unknown>) {
      if (isObject(value)) yield value;
    }
  }
};

export const isNonemptyTypedArray = (object: object): boolean =>
  ArrayBuffer.isView(object) && !(object instanceof DataView) && object.byteLength > 0;

export const freeze = <T>(value: T): T => {
  if (!isObject(value) || frozen.has(value)) return value;

  const seen = new Set<object>();
  const pending: object[] = [value];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current) || frozen.has(current)) continue;
    seen.add(current);
    if (isNonemptyTypedArray(current)) continue;
    for (const child of objectChildren(current)) pending.push(child);
    Object.freeze(current);
  }
  for (const current of seen) frozen.add(current);
  return value;
};

export const freezeFacts = (facts: Facts, where: string): Facts => {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
    throw new TypeError(`${where} requires a fact dictionary`);
  }
  return freeze(facts);
};
