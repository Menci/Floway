import { describe, expect, test } from 'vitest';

import { oauth2AccessAllowed } from '../../../src/control-plane/auth/oauth2-access-policy.ts';

describe('OAuth2 UserInfo access policy', () => {
  test('or accepts any exact array member and rejects substrings or missing claims', () => {
    const policy = {
      logic: 'or' as const,
      conditions: [
        { field: 'groups', op: 'contains' as const, value: 'POPIPA-l10n:owners' },
        { field: 'groups', op: 'contains' as const, value: 'canneed:owners' },
      ],
    };

    expect(oauth2AccessAllowed(policy, { groups: ['canneed:owners'] })).toBe(true);
    expect(oauth2AccessAllowed(policy, { groups: ['prefix-canneed:owners-suffix'] })).toBe(false);
    expect(oauth2AccessAllowed(policy, {})).toBe(false);
  });

  test('and requires every dotted-path condition and an empty and policy allows all', () => {
    expect(oauth2AccessAllowed({
      logic: 'and',
      conditions: [
        { field: 'membership.groups', op: 'contains', value: 'owners' },
        { field: 'roles', op: 'contains', value: 'operator' },
      ],
    }, {
      membership: { groups: ['owners'] },
      roles: ['operator'],
    })).toBe(true);
    expect(oauth2AccessAllowed({
      logic: 'and',
      conditions: [{ field: 'groups', op: 'contains', value: 'owners' }],
    }, { groups: 'owners' })).toBe(false);
    expect(oauth2AccessAllowed({ logic: 'and', conditions: [] }, {})).toBe(true);
  });
});
