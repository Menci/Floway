import { expect, test } from 'vitest';

import { parseScope, scopeContains, scopeKey } from '../../../src/components/access-control/scope';
import { scopePermissions } from '../../../src/components/access-control/values';

const data = { groups: [{ id: 1, name: 'Platform', hue: 210, memberIds: [2], createdAt: '', deletedAt: null }] };
test('recognizes ancestor and model-pattern containment without crossing resources', () => {
  expect(scopeContains(null, { kind: 'upstreams' }, data)).toBe(true);
  expect(scopeContains({ kind: 'upstreams' }, { kind: 'upstream', upstreamId: 'a' }, data)).toBe(true);
  expect(scopeContains({ kind: 'upstream', upstreamId: 'a' }, { kind: 'upstreamModel', upstreamId: 'b', model: { kind: 'exact', value: 'claude' } }, data)).toBe(false);
  expect(scopeContains({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '^claude-' } }, { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'claude-sonnet' } }, data)).toBe(true);
  expect(scopeContains({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '^claude-' } }, { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'exact', value: 'gpt' } }, data)).toBe(false);
});
test('recognizes user membership scopes and keeps regex queries symbolic', () => {
  expect(scopeContains({ kind: 'users' }, { kind: 'group', groupId: 1 }, data)).toBe(false);
  expect(scopeContains({ kind: 'groups' }, { kind: 'group', groupId: 1 }, data)).toBe(true);
  expect(scopeContains({ kind: 'group', groupId: 1 }, { kind: 'user', userId: 2 }, data)).toBe(true);
  expect(scopeContains({ kind: 'group', groupId: 1 }, { kind: 'user', userId: 3 }, data)).toBe(false);
  expect(scopeContains({ kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '.*' } }, { kind: 'upstreamModel', upstreamId: 'a', model: { kind: 'regex', value: '^claude-' } }, data)).toBe(false);
});
test('uses structural scope keys and validates URL scope values', () => {
  expect(scopeKey({ upstreamId: 'a', kind: 'upstream' })).toBe(scopeKey({ kind: 'upstream', upstreamId: 'a' }));
  expect(parseScope(null)).toBeNull();
  expect(parseScope('{"kind":"user","userId":2}')).toEqual({ kind: 'user', userId: 2 });
  expect(parseScope('{"kind":"self"}')).toEqual({ kind: 'self' });
  expect(() => parseScope('{"kind":"user","userId":"alice"}')).toThrow();
  expect(() => parseScope('{"kind":"upstreamModel","upstreamId":"a","model":{"kind":"regex","value":"["}}')).toThrow();
});

test('maps audit permissions to their valid identity scopes', () => {
  expect(scopePermissions({ kind: 'self' })).toEqual(['Permission.Audit']);
  expect(scopePermissions({ kind: 'groups' })).toEqual(['Permission.Audit']);
  for (const scope of [
    { kind: 'users' as const },
    { kind: 'user' as const, userId: 2 },
    { kind: 'group' as const, groupId: 1 },
  ]) expect(scopePermissions(scope)).toEqual(['User.Audit', 'Permission.Audit']);
});
