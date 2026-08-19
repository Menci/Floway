import { describe, expect, test } from 'vitest';

import { evaluateOAuth2Access, oauth2AccessAllowed, renderOAuth2AccessDeniedMessage } from '../../../src/control-plane/auth/oauth2-access-policy.ts';
import type { OAuth2AccessCondition } from '../../../src/repo/types.ts';

const matches = (condition: OAuth2AccessCondition, claims: Record<string, unknown>): boolean =>
  oauth2AccessAllowed({ logic: 'and', conditions: [condition] }, claims);

describe('OAuth2 UserInfo access policy', () => {
  test('supports strict equality and ordered number or string comparisons', () => {
    expect(matches({ field: 'profile', op: 'eq', value: { active: true, levels: [1, 2] } }, {
      profile: { levels: [1, 2], active: true },
    })).toBe(true);
    expect(matches({ field: 'age', op: 'ne', value: 18 }, { age: 19 })).toBe(true);
    expect(matches({ field: 'age', op: 'gt', value: 18 }, { age: 19 })).toBe(true);
    expect(matches({ field: 'age', op: 'gte', value: 19 }, { age: 19 })).toBe(true);
    expect(matches({ field: 'tier', op: 'lt', value: 'pro' }, { tier: 'basic' })).toBe(true);
    expect(matches({ field: 'tier', op: 'lte', value: 'basic' }, { tier: 'basic' })).toBe(true);
    expect(matches({ field: 'age', op: 'gt', value: 18 }, { age: '19' })).toBe(false);
  });

  test('supports membership and containment without coercion', () => {
    expect(matches({ field: 'role', op: 'in', value: ['owner', 'operator'] }, { role: 'owner' })).toBe(true);
    expect(matches({ field: 'role', op: 'not_in', value: ['guest'] }, { role: 'owner' })).toBe(true);
    expect(matches({ field: 'groups', op: 'contains', value: 'canneed:owners' }, {
      groups: ['canneed:owners'],
    })).toBe(true);
    expect(matches({ field: 'bio', op: 'contains', value: 'Floway' }, { bio: 'Uses Floway daily' })).toBe(true);
    expect(matches({ field: 'groups', op: 'not_contains', value: 'guest' }, { groups: ['owners'] })).toBe(true);
    expect(matches({ field: 'bio', op: 'not_contains', value: 'guest' }, { bio: 'owner' })).toBe(true);
    expect(matches({ field: 'groups', op: 'contains', value: 'owners' }, { groups: ['prefix-owners-suffix'] })).toBe(false);
  });

  test('uses explicit presence operators and fails closed for missing or incompatible binary values', () => {
    expect(matches({ field: 'profile.roles', op: 'exists' }, { profile: { roles: null } })).toBe(true);
    expect(matches({ field: 'profile.roles', op: 'not_exists' }, { profile: {} })).toBe(true);
    expect(matches({ field: 'groups', op: 'ne', value: [] }, {})).toBe(false);
    expect(matches({ field: 'groups', op: 'not_in', value: ['guest'] }, {})).toBe(false);
    expect(matches({ field: 'groups', op: 'not_contains', value: 'guest' }, { groups: 1 })).toBe(false);
    expect(matches({ field: 'toString', op: 'exists' }, {})).toBe(false);
  });

  test('combines conditions and returns a stable condition for denial messages', () => {
    const first = { field: 'groups', op: 'contains' as const, value: 'owners' };
    const second = { field: 'roles', op: 'contains' as const, value: 'operator' };
    expect(evaluateOAuth2Access({ logic: 'and', conditions: [first, second] }, {
      groups: ['owners'], roles: [],
    })).toEqual({ allowed: false, condition: second });
    expect(evaluateOAuth2Access({ logic: 'or', conditions: [first, second] }, {
      groups: [], roles: [],
    })).toEqual({ allowed: false, condition: first });
    expect(evaluateOAuth2Access({ logic: 'and', conditions: [] }, {})).toEqual({ allowed: true, condition: null });
    expect(evaluateOAuth2Access({ logic: 'or', conditions: [] }, {})).toEqual({ allowed: false, condition: null });
  });

  test('renders denial templates from the provider, failed condition, and UserInfo paths', () => {
    const condition = { field: 'groups', op: 'contains' as const, value: 'company:owners' };
    const evaluation = { allowed: false, condition };
    expect(renderOAuth2AccessDeniedMessage(
      '{{provider}}: {{field}} {{op}} {{required}}; roles={{current.roles}}; current={{current}}; {{unknown}}',
      'Company Login',
      evaluation,
      { roles: ['guest'], profile: { active: true } },
    )).toBe('Company Login: groups contains company:owners; roles=["guest"]; current={"roles":["guest"],"profile":{"active":true}}; {{unknown}}');
  });
});
