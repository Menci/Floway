import { DeclarationViolationError } from './errors.ts';
import type { DeclarationDirection } from './errors.ts';
import type { Facts } from './facts.ts';
import type { ReturnDecl, SideDecl } from './stage.ts';

export const requireKeys = (stage: string, direction: DeclarationDirection, facts: Facts, keys: readonly string[]): void => {
  for (const key of keys) {
    if (!Object.hasOwn(facts, key)) throw new DeclarationViolationError(stage, direction, `missing "${key}"`);
  }
};

const changeViolation = (base: Facts, next: Facts, declaration: Pick<SideDecl, 'consumes' | 'provides'>): string | undefined => {
  const provides = new Set(declaration.provides);
  const consumes = new Set(declaration.consumes);
  for (const key of provides) {
    if (!Object.hasOwn(next, key)) return `declared providing "${key}" but did not hand it over`;
  }
  for (const key of consumes) {
    if (!provides.has(key) && Object.hasOwn(next, key)) return `declared consuming "${key}" but handed it over`;
  }
  for (const key of Object.keys(base)) {
    if (!provides.has(key) && !consumes.has(key) && (!Object.hasOwn(next, key) || !Object.is(base[key], next[key]))) {
      return `changed or removed undeclared "${key}"`;
    }
  }
  for (const key of Object.keys(next)) {
    if (!provides.has(key) && !Object.hasOwn(base, key)) return `added undeclared "${key}"`;
  }
};

export const checkDown = (stage: string, base: Facts, handed: Facts, declaration: SideDecl): void => {
  const violation = changeViolation(base, handed, declaration);
  if (violation !== undefined) throw new DeclarationViolationError(stage, 'down', violation);
};

export interface Answer {
  readonly id: number;
  readonly declaration: SideDecl;
  facts?: Facts;
}

export const checkUp = (stage: string, answer: ReturnDecl | undefined, handed: Facts, calls: readonly Answer[]): number | undefined => {
  if (calls.length === 0) {
    if (!answer) throw new DeclarationViolationError(stage, 'up', 'returned without a child response or a return declaration');
    requireKeys(stage, 'up', handed, answer.provides);
    return undefined;
  }
  let first: number | undefined;
  let detail: string | undefined;
  for (const call of calls) {
    if (call.facts === undefined) continue;
    const violation = changeViolation(call.facts, handed, call.declaration);
    if (violation === undefined) {
      if (call.facts === handed) return call.id;
      first ??= call.id;
    } else {
      detail ??= violation;
    }
  }
  if (first !== undefined) return first;
  throw new DeclarationViolationError(stage, 'up', detail ?? 'response matches no child');
};
