import type { Deferred } from './values.ts';

export type Facts = Readonly<Record<string, unknown>>;

type HandleKind = 'stream' | 'deferred';
const moved = new WeakMap<object, 'fact' | HandleKind>();
const frozen = new WeakSet<object>();

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

export const registerHandle = <T extends object>(handle: T, kind: HandleKind): T => {
  moved.set(Object.freeze(handle), kind);
  return handle;
};

export const isFrozenFact = (value: object): boolean => frozen.has(value);
export const isRuntimeHandle = (value: object): boolean => {
  const kind = moved.get(value);
  return kind === 'stream' || kind === 'deferred';
};
export const isDeferred = (value: unknown): value is Deferred<unknown> =>
  isObject(value) && moved.get(value) === 'deferred';

export const move = <T>(value: T): T => {
  if (!isObject(value) || moved.has(value)) return value;
  const visited = new WeakSet<object>();
  const freeze = (object: object): void => {
    if (visited.has(object) || moved.has(object) || frozen.has(object)) return;
    if (object instanceof AbortSignal) throw new TypeError('Abort signals belong to the stage scope');
    visited.add(object);
    if (ArrayBuffer.isView(object) && !(object instanceof DataView) && object.byteLength > 0) return;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(object))) {
      if ('value' in descriptor && isObject(descriptor.value)) freeze(descriptor.value);
    }
    for (const key of Object.getOwnPropertySymbols(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if ('value' in descriptor && isObject(descriptor.value)) freeze(descriptor.value);
    }
    Object.freeze(object);
    frozen.add(object);
  };
  freeze(value);
  moved.set(value, 'fact');
  return value;
};

export const checkFacts = (facts: Facts, where: string): void => {
  if (typeof facts !== 'object' || facts === null || Array.isArray(facts)) {
    throw new TypeError(`${where} requires a fact dictionary`);
  }
  for (const [key, value] of Object.entries(facts)) {
    if (isObject(value) && !moved.has(value)) {
      throw new TypeError(`${where} received "${key}" without move()`);
    }
  }
};
