import type { Facts } from './values.ts';

declare const slotBrand: unique symbol;
declare const missingTypeArg: unique symbol;

type MissingTypeArg = { readonly [missingTypeArg]: 'Missing explicit type argument <T>' };

export type ExactEqual<A, B> =
  (<U>() => U extends A ? 1 : 2) extends (<U>() => U extends B ? 1 : 2) ? true : false;

export interface RequiredSlot<T> {
  readonly [slotBrand]: { readonly kind: 'required'; readonly type: (value: T) => T };
}

export interface OptionalSlot<T> {
  readonly [slotBrand]: { readonly kind: 'optional'; readonly type: (value: T) => T };
}

export type FactSlot<T = unknown> = RequiredSlot<T> | OptionalSlot<T>;

export type AnySlot =
  | { readonly [slotBrand]: { readonly kind: 'required'; readonly type: (value: never) => unknown } }
  | { readonly [slotBrand]: { readonly kind: 'optional'; readonly type: (value: never) => unknown } };

const slotKinds = new WeakMap<object, boolean>();
const requiredMarker = Object.freeze({});
const optionalMarker = Object.freeze({});
slotKinds.set(requiredMarker, true);
slotKinds.set(optionalMarker, false);

export const required = <T = MissingTypeArg>(): RequiredSlot<NoInfer<T>> =>
  requiredMarker as unknown as RequiredSlot<NoInfer<T>>;

export const optional = <T = MissingTypeArg>(): OptionalSlot<NoInfer<T>> =>
  optionalMarker as unknown as OptionalSlot<NoInfer<T>>;

export type KeyMap = Readonly<Record<string, AnySlot>>;

export type SlotValue<S> = S extends { readonly [slotBrand]: { readonly type: (value: infer T) => infer _ } } ? T : never;

export type CheckedKeyMap<Space, M> = {
  readonly [K in keyof M]: K extends keyof Space
    ? ExactEqual<SlotValue<M[K]>, Space[K]> extends true
      ? FactSlot<Space[K]>
      : ['Type argument mismatch with FactSpace', { readonly expected: Space[K]; readonly actual: SlotValue<M[K]> }]
    : never;
};

export type RequiredKeysOfMap<M> = {
  [K in keyof M]-?: M[K] extends { readonly [slotBrand]: { readonly kind: 'required' } } ? K : never;
}[keyof M] & string;

export type OptionalKeysOfMap<M> = {
  [K in keyof M]-?: M[K] extends { readonly [slotBrand]: { readonly kind: 'optional' } } ? K : never;
}[keyof M] & string;

export type FactShapeFromMap<Space, M> = {
  readonly [K in RequiredKeysOfMap<M> & keyof Space]-?: Space[K];
} & {
  readonly [K in OptionalKeysOfMap<M> & keyof Space]?: Space[K];
};

export type ValuesOfMap<Space, M> = {
  readonly [K in keyof M & keyof Space]: Space[K];
};

export type RequiredValuesOfMap<Space, M> = {
  readonly [K in RequiredKeysOfMap<M> & keyof Space]: Space[K];
};

export type OptionalValuesOfMap<Space, M> = {
  readonly [K in OptionalKeysOfMap<M> & keyof Space]: Space[K];
};

export type EdgeHandoff<FromSpace, ToSpace, N, P, C extends string> = {
  readonly [K in (RequiredKeysOfMap<P> | (OptionalKeysOfMap<P> & Exclude<RequiredKeysOfMap<N>, C>)) & keyof ToSpace]-?: ToSpace[K];
} & {
  readonly [K in Exclude<OptionalKeysOfMap<P>, Exclude<RequiredKeysOfMap<N>, C>> & keyof ToSpace]?: ToSpace[K];
} & {
  readonly [K in Exclude<RequiredKeysOfMap<N>, C | keyof P> & keyof FromSpace]-?: FromSpace[K];
} & {
  readonly [K in (Exclude<OptionalKeysOfMap<N>, C | keyof P> | C) & keyof FromSpace]?: K extends C ? never : FromSpace[K];
};

export interface RawSide {
  readonly needs: KeyMap;
  readonly provides: KeyMap;
  readonly consumes: readonly string[];
}

export interface RawThrough {
  readonly request: RawSide;
  readonly response: RawSide;
}

export type Keys = ReadonlyMap<string, boolean>;

export interface ParsedSide {
  readonly needs: Keys;
  readonly provides: Keys;
  readonly consumes: ReadonlySet<string>;
}

export interface ParsedThrough {
  readonly request: ParsedSide;
  readonly response: ParsedSide;
}

export const parseKeyMap = (map: KeyMap, where: string): Keys => {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new TypeError(`${where} must be a key declaration map`);
  }
  if (Object.getOwnPropertySymbols(map).length > 0) {
    throw new TypeError(`${where} must not contain symbol keys`);
  }
  const parsed = new Map<string, boolean>();
  for (const key of Object.getOwnPropertyNames(map)) {
    if (!key) throw new TypeError(`${where} contains an empty key`);
    const descriptor = Object.getOwnPropertyDescriptor(map, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new TypeError(`${where} must not contain accessor property "${key}"`);
    }
    const slot: unknown = descriptor.value;
    const isRequired = typeof slot === 'object' && slot !== null ? slotKinds.get(slot) : undefined;
    if (isRequired === undefined) {
      throw new TypeError(`${where} key "${key}" must use required<T>() or optional<T>()`);
    }
    parsed.set(key, isRequired);
  }
  return parsed;
};

export const parseConsumes = (keys: readonly string[], where: string): ReadonlySet<string> => {
  if (!Array.isArray(keys)) throw new TypeError(`${where} must be an array of key names`);
  const parsed = new Set<string>();
  for (const key of keys) {
    if (typeof key !== 'string' || !key || parsed.has(key)) {
      throw new TypeError(`${where} contains an invalid or repeated key "${String(key)}"`);
    }
    parsed.add(key);
  }
  return parsed;
};

const parseSide = (side: RawSide, where: string): ParsedSide => {
  const needs = parseKeyMap(side.needs, `${where} needs`);
  const provides = parseKeyMap(side.provides, `${where} provides`);
  const consumes = parseConsumes(side.consumes, `${where} consumes`);
  for (const key of consumes) {
    if (provides.has(key)) throw new TypeError(`${where} both consumes and provides "${key}"`);
  }
  return { needs, provides, consumes };
};

export const parseThrough = (declaration: RawThrough, where: string): ParsedThrough => ({
  request: parseSide(declaration.request, `${where} request`),
  response: parseSide(declaration.response, `${where} response`),
});

export const requireKeys = (facts: Facts, keys: Keys, where: string): void => {
  for (const [key, isRequired] of keys) {
    if (isRequired && !Object.hasOwn(facts, key)) throw new TypeError(`${where} is missing "${key}"`);
  }
};

export const checkEntry = (facts: Facts, keys: Keys, where: string): void => {
  requireKeys(facts, keys, where);
  for (const key of Object.getOwnPropertyNames(facts)) {
    if (!keys.has(key)) throw new TypeError(`${where} received undeclared "${key}"`);
  }
};

export const checkExit = (facts: Facts, keys: Keys, where: string): void => {
  requireKeys(facts, keys, where);
  for (const key of Object.getOwnPropertyNames(facts)) {
    if (!keys.has(key)) throw new TypeError(`${where} returned undeclared "${key}"`);
  }
};

export const checkInPlace = (facts: Facts, keys: Keys, where: string): void => {
  requireKeys(facts, keys, where);
  for (const key of Object.getOwnPropertyNames(facts)) {
    if (!keys.has(key)) throw new TypeError(`${where} returned undeclared "${key}"`);
  }
};

const checkWrites = (after: Facts, declaration: ParsedSide, where: string): void => {
  requireKeys(after, declaration.provides, where);
  for (const key of declaration.consumes) {
    if (Object.hasOwn(after, key)) throw new TypeError(`${where} must consume "${key}"`);
  }
};

export const checkHandoff = (before: Facts, after: Facts, declaration: ParsedSide, where: string): void => {
  checkWrites(after, declaration, where);
  for (const key of Object.getOwnPropertyNames(before)) {
    if (declaration.consumes.has(key)) continue;
    if (!Object.hasOwn(after, key) || (!declaration.provides.has(key) && !Object.is(before[key], after[key]))) {
      throw new TypeError(`${where} removed or changed undeclared "${key}"`);
    }
  }
  for (const key of Object.getOwnPropertyNames(after)) {
    if (!Object.hasOwn(before, key) && !declaration.provides.has(key)) {
      throw new TypeError(`${where} added undeclared "${key}"`);
    }
  }
};
