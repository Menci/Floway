import type { OAuth2AccessCondition, OAuth2AccessPolicy } from '../../repo/types.ts';

type JsonObject = Record<string, unknown>;

const claimAtPath = (claims: JsonObject, path: string): unknown => {
  let value: unknown = claims;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    value = (value as JsonObject)[part];
  }
  return value;
};

const conditionMatches = (claims: JsonObject, condition: OAuth2AccessCondition): boolean => {
  const claim = claimAtPath(claims, condition.field);
  return Array.isArray(claim)
    && claim.some(item => typeof item === 'string' && item === condition.value);
};

export const oauth2AccessAllowed = (policy: OAuth2AccessPolicy, claims: JsonObject): boolean => {
  const matches = (condition: OAuth2AccessCondition) => conditionMatches(claims, condition);
  return policy.logic === 'and'
    ? policy.conditions.every(matches)
    : policy.conditions.some(matches);
};
