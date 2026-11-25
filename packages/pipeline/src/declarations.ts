import type { Facts } from './facts.ts';

export type KeyList<K extends string = string> = readonly K[];

export interface Side<K extends string = string> {
  readonly needs: KeyList<K>;
  readonly provides: KeyList<K>;
  readonly consumes: KeyList<K>;
}

export interface Through<K extends string = string> {
  readonly request: Side<K>;
  readonly response: Side<K>;
}

export interface Return<K extends string = string> {
  readonly provides: KeyList<K>;
}

export type Keys = ReadonlyMap<string, boolean>;

export interface ParsedSide {
  readonly needs: Keys;
  readonly provides: Keys;
  readonly consumes: Keys;
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
  const consumes = parseKeys(side.consumes, `${where} consumes`);
  for (const key of consumes.keys()) {
    if (provides.has(key)) throw new TypeError(`${where} both consumes and provides "${key}"`);
  }
  return { needs, provides, consumes };
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

const written = (facts: Facts, declaration: ParsedSide, where: string): void => {
  requireKeys(facts, declaration.provides, where);
  for (const key of declaration.consumes.keys()) {
    if (Object.hasOwn(facts, key)) throw new TypeError(`${where} must consume "${key}"`);
  }
};

export const checkHandoff = (before: Facts, after: Facts, declaration: ParsedSide, where: string): void => {
  written(after, declaration, where);
  for (const key of Object.keys(before)) {
    if (declaration.consumes.has(key)) continue;
    if (!Object.hasOwn(after, key) || (!declaration.provides.has(key) && !Object.is(before[key], after[key]))) {
      throw new TypeError(`${where} removed or changed undeclared "${key}"`);
    }
  }
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key) && !declaration.provides.has(key)) {
      throw new TypeError(`${where} added undeclared "${key}"`);
    }
  }
};

export const checkReturn = (facts: Facts, provides: Keys | undefined, where: string): void => {
  if (!provides) throw new TypeError(`${where} returned without a continuation or a return declaration`);
  requireKeys(facts, provides, where);
  for (const key of Object.keys(facts)) {
    if (!provides.has(key)) throw new TypeError(`${where} returned undeclared "${key}"`);
  }
};

export const checkUp = (
  answer: Facts,
  calls: readonly { readonly facts: Facts; readonly declaration: ParsedSide }[],
  where: string,
): void => {
  if (calls.length === 1) {
    const [{ facts, declaration }] = calls;
    checkHandoff(facts, answer, declaration, where);
    return;
  }
  const childKeys = new Set(calls.flatMap(call => Object.keys(call.facts)));
  const declarations = new Set(calls.map(call => call.declaration));
  for (const declaration of declarations) {
    if ([...declaration.provides].some(([key, required]) => required && !Object.hasOwn(answer, key))) continue;
    if ([...declaration.consumes.keys()].some(key => Object.hasOwn(answer, key))) continue;
    if (Object.keys(answer).every(key => declaration.provides.has(key) || childKeys.has(key))) return;
  }
  throw new TypeError(`${where} returned facts outside its declarations and child answers`);
};
