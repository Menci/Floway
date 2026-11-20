import { expect, test } from 'vitest';

import type { AccessRecord } from '../../../src/api/types';
import { resolveAccess } from '../../../src/components/access-control/resolution';
import type { AccessPrincipal, AccessScope } from '@floway-dev/gateway/browser';

const scope: AccessScope = { kind: 'upstream', upstreamId: 'up_a' };
const row = (id: number, principal: AccessPrincipal, recordScope: AccessScope, values: AccessRecord['values'], sortOrder = id): AccessRecord => ({
  id, principal, scope: recordScope, values, sortOrder, createdAt: '', updatedAt: '',
});

test('resolveAccess computes values, applicable records, and decisions for users, groups, self, and admins', () => {
  const data = {
    users: [
      { id: 1, username: 'admin', isAdmin: true, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null, uiTextEditor: false }, groupIds: [] },
      { id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null, uiTextEditor: false }, groupIds: [3] },
    ],
  };
  const records: AccessRecord[] = [
    row(1, { kind: 'group', id: 3 }, { kind: 'upstreams' }, { 'Model.Use': true, 'Upstream.Edit': 'models' }, 0),
    row(2, { kind: 'user', id: 2 }, scope, { 'Model.Use': false }, 0),
    row(3, { kind: 'group', id: 3 }, { kind: 'self' }, { 'Permission.Audit': true }, 0),
    row(4, { kind: 'group', id: 4 }, { kind: 'upstreams' }, { 'Upstream.Audit': true }, 0),
  ];

  const excluded = resolveAccess({ data, excludeRecordId: 2, principal: { kind: 'user', id: 2 }, records, scope })!;
  expect(excluded.values).toEqual({ 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'models' });
  expect(excluded.records.map(record => record.id)).toEqual([1]);

  const effective = resolveAccess({ data, principal: { kind: 'user', id: 2 }, records, scope })!;
  expect(effective.values).toEqual({ 'Model.Use': false, 'Upstream.Audit': false, 'Upstream.Edit': 'models' });
  expect(effective.decisions).toEqual([
    { recordId: 1, permissions: { 'Model.Use': { kind: 'overridden', by: records[1] }, 'Upstream.Edit': { kind: 'effective' } } },
    { recordId: 2, permissions: { 'Model.Use': { kind: 'effective' } } },
  ]);

  const selfUser = resolveAccess({ data, principal: { kind: 'user', id: 2 }, records, scope: { kind: 'user', userId: 2 } })!;
  expect(selfUser.values).toEqual({ 'User.Audit': true, 'Permission.Audit': true });
  expect(selfUser.records.map(record => record.id)).toEqual([3]);

  const admin = resolveAccess({ data, principal: { kind: 'user', id: 1 }, records, scope })!;
  expect(admin).toEqual({
    values: { 'Model.Use': true, 'Upstream.Audit': true, 'Upstream.Edit': 'full' },
    records: [],
    decisions: [],
  });

  expect(resolveAccess({ data, principal: { kind: 'user', id: 2 }, records, scope: { kind: 'self' } })).toBeNull();
  expect(resolveAccess({ data, principal: null, records, scope })).toBeNull();
});

test('resolveAccess matches gateway precedence for personal overrides, group union, model order, and membership scopes', () => {
  const data = {
    users: [
      { id: 2, username: 'alice', isAdmin: false, createdAt: '', preferences: { quotaDisplay: 'remaining' as const, language: null, uiTextEditor: false }, groupIds: [3, 4] },
    ],
  };
  const modelScope: AccessScope = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } };

  const combined = resolveAccess({
    data,
    principal: { kind: 'user', id: 2 },
    records: [
      row(1, { kind: 'group', id: 3 }, scope, { 'Model.Use': true, 'Upstream.Edit': 'models' }),
      row(2, { kind: 'group', id: 4 }, scope, { 'Upstream.Edit': 'full' }),
      row(3, { kind: 'user', id: 2 }, scope, { 'Model.Use': false }),
    ],
    scope,
  })!;
  expect(combined.values).toEqual({ 'Model.Use': false, 'Upstream.Audit': false, 'Upstream.Edit': 'full' });
  expect(combined.decisions.find(row => row.recordId === 1)!.permissions).toEqual({
    'Model.Use': { kind: 'overridden', by: expect.objectContaining({ id: 3 }) },
    'Upstream.Edit': { kind: 'effective' },
  });
  expect(combined.decisions.find(row => row.recordId === 2)!.permissions).toEqual({
    'Upstream.Edit': { kind: 'effective' },
  });

  const regexScope: AccessScope = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-' } };
  expect(resolveAccess({
    data,
    principal: { kind: 'user', id: 2 },
    records: [
      row(1, { kind: 'group', id: 3 }, regexScope, { 'Model.Use': false }, 0),
      row(2, { kind: 'user', id: 2 }, modelScope, { 'Model.Use': true }, 1),
    ],
    scope: modelScope,
  })!.values).toEqual({ 'Model.Use': false });
  expect(resolveAccess({
    data,
    principal: { kind: 'user', id: 2 },
    records: [
      row(1, { kind: 'group', id: 3 }, scope, { 'Model.Use': true }, 0),
      row(2, { kind: 'user', id: 2 }, { ...regexScope, model: { kind: 'regex', value: '.*' } }, { 'Model.Use': false }, 1),
    ],
    scope: regexScope,
  })!.values).toEqual({ 'Model.Use': true });

  expect(resolveAccess({
    data,
    principal: { kind: 'user', id: 2 },
    records: [row(1, { kind: 'group', id: 3 }, { kind: 'group', groupId: 3 }, { 'Permission.Audit': true })],
    scope: { kind: 'user', userId: 2 },
  })!.values).toEqual({ 'User.Audit': true, 'Permission.Audit': false });
});
