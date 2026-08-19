import type { OAuth2AccessCondition, OAuth2AccessPolicy } from '../../repo/types.ts';

type JsonObject = Record<string, unknown>;

interface PathValue {
  exists: boolean;
  value: unknown;
}

export interface OAuth2AccessEvaluation {
  allowed: boolean;
  condition: OAuth2AccessCondition | null;
}

const valueAtPath = (root: unknown, path: string): PathValue => {
  let value: unknown = root;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, part)) {
      return { exists: false, value: undefined };
    }
    value = (value as JsonObject)[part];
  }
  return { exists: true, value };
};

const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (typeof left !== 'object' || left === null || Array.isArray(left)
    || typeof right !== 'object' || right === null || Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key)
      && jsonEqual((left as JsonObject)[key], (right as JsonObject)[key]));
};

const compare = (left: unknown, right: unknown): number | null => {
  if (typeof left === 'number' && typeof right === 'number') return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string') return left === right ? 0 : left < right ? -1 : 1;
  return null;
};

const containerIncludes = (container: unknown, required: unknown): boolean | null => {
  if (Array.isArray(container)) return container.some(item => jsonEqual(item, required));
  if (typeof container === 'string' && typeof required === 'string') return container.includes(required);
  return null;
};

const conditionMatches = (claims: JsonObject, condition: OAuth2AccessCondition): boolean => {
  const current = valueAtPath(claims, condition.field);
  if (condition.op === 'exists') return current.exists;
  if (condition.op === 'not_exists') return !current.exists;
  if (!current.exists) return false;

  switch (condition.op) {
  case 'eq': return jsonEqual(current.value, condition.value);
  case 'ne': return !jsonEqual(current.value, condition.value);
  case 'gt': return (compare(current.value, condition.value) ?? 0) > 0;
  case 'gte': {
    const result = compare(current.value, condition.value);
    return result !== null && result >= 0;
  }
  case 'lt': return (compare(current.value, condition.value) ?? 0) < 0;
  case 'lte': {
    const result = compare(current.value, condition.value);
    return result !== null && result <= 0;
  }
  case 'in': return Array.isArray(condition.value)
    && condition.value.some(candidate => jsonEqual(current.value, candidate));
  case 'not_in': return Array.isArray(condition.value)
    && !condition.value.some(candidate => jsonEqual(current.value, candidate));
  case 'contains': return containerIncludes(current.value, condition.value) === true;
  case 'not_contains': {
    const included = containerIncludes(current.value, condition.value);
    return included !== null && !included;
  }
  }
};

export const evaluateOAuth2Access = (policy: OAuth2AccessPolicy, claims: JsonObject): OAuth2AccessEvaluation => {
  const evaluations = policy.conditions.map(condition => ({ condition, matches: conditionMatches(claims, condition) }));
  if (policy.logic === 'and') {
    const failed = evaluations.find(evaluation => !evaluation.matches);
    return failed ? { allowed: false, condition: failed.condition } : { allowed: true, condition: null };
  }
  return evaluations.some(evaluation => evaluation.matches)
    ? { allowed: true, condition: null }
    : { allowed: false, condition: evaluations[0]?.condition ?? null };
};

export const oauth2AccessAllowed = (policy: OAuth2AccessPolicy, claims: JsonObject): boolean =>
  evaluateOAuth2Access(policy, claims).allowed;

const displayValue = (value: unknown): string => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '';
};

export const renderOAuth2AccessDeniedMessage = (
  template: string,
  provider: string,
  evaluation: OAuth2AccessEvaluation,
  claims: JsonObject,
): string => {
  const condition = evaluation.condition;
  const values: Record<string, unknown> = {
    provider,
    field: condition?.field,
    op: condition?.op,
    required: condition && 'value' in condition ? condition.value : undefined,
    current: claims,
  };
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (placeholder, path: string) => {
    const resolved = valueAtPath(values, path);
    return resolved.exists ? displayValue(resolved.value) : placeholder;
  });
};
