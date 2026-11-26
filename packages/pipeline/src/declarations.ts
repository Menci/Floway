import type { Facts } from './values.ts';

export type FactKey<Space> = (keyof Space & string) | `${keyof Space & string}?`;
export type Unmarked<K> = K extends `${infer Key}?` ? Key : K;
type RequiredKeys<K> = Exclude<K, `${string}?`>;
type Retained<K, Consumed> = K extends string ? Unmarked<K> extends Consumed ? never : K : never;

export type FactShape<Space, K> = {
  [Key in RequiredKeys<K> & keyof Space]-?: Required<Space>[Key];
} & {
  [Key in Exclude<Unmarked<K>, RequiredKeys<K>> & keyof Space]?: Required<Space>[Key];
};

export type KeyList<K extends string = string> = readonly K[];

export interface Side<K extends string = string> {
  readonly needs: KeyList<K>;
  readonly provides: KeyList<K>;
  readonly consumes: KeyList<RequiredKeys<K>>;
}

export interface Through<Rq extends string = string, Rs extends string = string> {
  readonly request: Side<Rq>;
  readonly response: Side<Rs>;
}

export interface Return<K extends string = string> {
  readonly provides: KeyList<K>;
}

export type Handoff<Space, D extends Side> = FactShape<Space,
  D['provides'][number] | Retained<D['needs'][number], D['consumes'][number]>
> & { [K in D['consumes'][number]]?: never };

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

export const parseKeys = (keys: KeyList, where: string): Keys => {
  const parsed = new Map<string, boolean>();
  for (const code of keys) {
    const required = !code.endsWith('?');
    const key = required ? code : code.slice(0, -1);
    if (!key || key.endsWith('?') || parsed.has(key)) {
      throw new TypeError(`${where} contains an invalid or repeated key "${code}"`);
    }
    parsed.set(key, required);
  }
  return parsed;
};

const parseSide = (side: Side, where: string): ParsedSide => {
  const needs = parseKeys(side.needs, `${where} needs`);
  const provides = parseKeys(side.provides, `${where} provides`);
  const consumed = parseKeys(side.consumes, `${where} consumes`);
  for (const [key, required] of consumed) {
    if (!required) throw new TypeError(`${where} marks consumed key "${key}" as optional`);
    if (provides.has(key)) throw new TypeError(`${where} both consumes and provides "${key}"`);
  }
  return { needs, provides, consumes: new Set(consumed.keys()) };
};

export const parseThrough = (declaration: Through, where: string): ParsedThrough => ({
  request: parseSide(declaration.request, `${where} request`),
  response: parseSide(declaration.response, `${where} response`),
});

export const requireKeys = (facts: Facts, keys: Keys, where: string): void => {
  for (const [key, required] of keys) {
    if (required && !Object.hasOwn(facts, key)) throw new TypeError(`${where} is missing "${key}"`);
  }
};

export const checkExit = (facts: Facts, keys: Keys, where: string): void => {
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

export interface ContinuationAnswer {
  readonly facts: Facts;
  readonly declaration: ParsedSide;
}

export const checkResponse = (
  answer: Facts,
  inPlace: Keys | undefined,
  calls: readonly ContinuationAnswer[],
  where: string,
): void => {
  const keys = Object.getOwnPropertyNames(answer);
  if (inPlace && keys.every(key => inPlace.has(key)) && [...inPlace].every(([key, required]) =>
    !required || Object.hasOwn(answer, key))) return;

  const [first] = calls;
  if (!first) throw new TypeError(`${where} does not match an in-place return or an answered continuation`);
  if (calls.length === 1) {
    checkHandoff(first.facts, answer, first.declaration, where);
    return;
  }

  const childKeys = new Set(calls.flatMap(call => Object.getOwnPropertyNames(call.facts)));
  for (const declaration of new Set(calls.map(call => call.declaration))) {
    if ([...declaration.provides].some(([key, required]) => required && !Object.hasOwn(answer, key))) continue;
    if ([...declaration.consumes].some(key => Object.hasOwn(answer, key))) continue;
    if ([...declaration.needs].some(([key, required]) =>
      required && !declaration.consumes.has(key) && !Object.hasOwn(answer, key))) continue;
    if (keys.every(key => declaration.provides.has(key) || childKeys.has(key))) return;
  }
  throw new TypeError(`${where} returned facts outside its declarations and child answers`);
};
