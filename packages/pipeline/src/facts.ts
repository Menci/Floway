export type Facts = Readonly<Record<string, unknown>>;

const moved = new WeakSet<object>();

const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

export const registerHandle = <T extends object>(handle: T): T => {
  moved.add(Object.freeze(handle));
  return handle;
};

export const move = <T>(value: T): T => {
  if (!isObject(value) || moved.has(value)) return value;
  const visited = new WeakSet<object>();
  const freeze = (object: object): void => {
    if (visited.has(object) || moved.has(object)) return;
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
  };
  freeze(value);
  moved.add(value);
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
