import { DeclarationViolationError } from './errors.ts';
import type { DeclarationDirection } from './errors.ts';
import type { Facts } from './facts.ts';
import type { SideDecl, Stage } from './stage.ts';

export const requireKeys = (stage: string, direction: DeclarationDirection, facts: Facts, keys: readonly string[]): void => {
  for (const key of keys) {
    if (!(key in facts)) throw new DeclarationViolationError(stage, direction, `missing "${key}"`);
  }
};

const changeViolation = (base: Facts, next: Facts, declaration: Pick<SideDecl, 'consumes' | 'provides'>): string | undefined => {
  const provides = new Set(declaration.provides);
  const consumes = new Set(declaration.consumes);
  for (const key of provides) {
    if (!(key in next)) return `declared providing "${key}" but did not hand it over`;
  }
  for (const key of consumes) {
    if (!provides.has(key) && key in next) return `declared consuming "${key}" but handed it over`;
  }
  for (const key of Object.getOwnPropertyNames(base)) {
    if (!provides.has(key) && !consumes.has(key) && (!(key in next) || base[key] !== next[key])) {
      return `changed or removed undeclared "${key}"`;
    }
  }
  for (const key of Object.getOwnPropertyNames(next)) {
    if (!provides.has(key) && !(key in base)) return `added undeclared "${key}"`;
  }
};

export const checkDown = (stage: string, base: Facts, handed: Facts, declaration: SideDecl): void => {
  const violation = changeViolation(base, handed, declaration);
  if (violation !== undefined) throw new DeclarationViolationError(stage, 'down', violation);
};

export interface Answer {
  readonly id: number;
  readonly facts: Facts;
}

export const findBase = (handed: Facts, answers: readonly Answer[], declaration: Pick<SideDecl, 'consumes' | 'provides'>): number | undefined => {
  const exact = answers.find(answer => answer.facts === handed && changeViolation(answer.facts, handed, declaration) === undefined);
  return exact?.id ?? answers.find(answer => changeViolation(answer.facts, handed, declaration) === undefined)?.id;
};

export const checkUp = (stage: Stage<any>, handed: Facts, answers: readonly Answer[]): number | undefined => {
  const response = stage.through?.response;
  if (response) {
    const baseId = findBase(handed, answers, response);
    if (baseId !== undefined) return baseId;
  }
  if (stage.return) {
    requireKeys(stage.name, 'up', handed, stage.return.provides);
    return undefined;
  }
  if (answers.length === 0) throw new DeclarationViolationError(stage.name, 'up', 'returned without a child response or a return declaration');
  const detail = response && changeViolation(answers[0].facts, handed, response);
  throw new DeclarationViolationError(stage.name, 'up', detail ?? 'response matches no child');
};
