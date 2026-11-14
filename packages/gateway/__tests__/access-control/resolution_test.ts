import { expect, test } from 'vitest';

import { resolveAssignments, resolveEffectiveAssignments } from '../../src/access-control/resolution.ts';
import type { AccessPrincipal, AccessRecord, AccessScope, AccessValues, ResolveScope } from '../../src/access-control/types.ts';

const user: AccessPrincipal = { kind: 'user', id: 2 };
const group: AccessPrincipal = { kind: 'group', id: 3 };
const upstream: AccessScope = { kind: 'upstream', upstreamId: 'up_a' };
const model: AccessScope = { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'exact', value: 'gpt-5' } };
const row = (id: number, principal: AccessPrincipal, scope: AccessScope, values: AccessValues, sortOrder = id): AccessRecord => ({ id, principal, scope, values, sortOrder, createdAt: '', updatedAt: '' });
const resolve = (records: AccessRecord[], scope: ResolveScope = upstream) => resolveAssignments(records, scope, { targetGroups: new Set() });

test.each([false, true])('the personal boolean %s overrides all groups at the same scope', value => {
  const records = [row(1, group, upstream, { 'Model.Use': !value }), row(2, user, upstream, { 'Model.Use': value })];
  const result = resolve(records);
  expect(result.values['Model.Use']).toBe(value);
  expect(result.decisions.find(row => row.recordId === 1)!.permissions['Model.Use']).toEqual({ kind: 'overridden', by: records[1] });
});

test.each(['off', 'models', 'full'] as const)('personal edit level %s overrides higher and lower group values', level => {
  const records = [row(1, group, upstream, { 'Upstream.Edit': 'full' }), row(2, { kind: 'group', id: 4 }, upstream, { 'Upstream.Edit': 'off' }), row(3, user, upstream, { 'Upstream.Edit': level })];
  const result = resolve(records);
  expect(result.values['Upstream.Edit']).toBe(level);
  expect(result.decisions.slice(0, 2).every(row => row.permissions['Upstream.Edit']?.kind === 'overridden')).toBe(true);
});

test('same-scope group assignments union their values while all contributions stay active', () => {
  const records = [row(1, group, upstream, { 'Model.Use': false, 'Upstream.Edit': 'models' }), row(2, { kind: 'group', id: 4 }, upstream, { 'Model.Use': true, 'Upstream.Edit': 'full' })];
  const result = resolve(records);
  expect(result.values).toEqual({ 'Model.Use': true, 'Upstream.Audit': false, 'Upstream.Edit': 'full' });
  expect(result.decisions.every(row => row.permissions['Model.Use']?.kind === 'effective' && row.permissions['Upstream.Edit']?.kind === 'effective')).toBe(true);
});

test('a deeper group assignment beats a personal ancestor and each permission resolves independently', () => {
  const records = [row(1, user, { kind: 'upstreams' }, { 'Model.Use': true, 'Upstream.Audit': true }), row(2, group, upstream, { 'Model.Use': false })];
  const result = resolve(records);
  expect(result.values).toEqual({ 'Model.Use': false, 'Upstream.Audit': true, 'Upstream.Edit': 'off' });
  expect(result.decisions[0]!.permissions['Model.Use']).toEqual({ kind: 'overridden', by: records[1] });
  expect(result.decisions[0]!.permissions['Upstream.Audit']).toEqual({ kind: 'effective' });
});

test('current and ancestor scopes are included but descendant scopes are excluded', () => {
  const records = [row(1, group, { kind: 'upstreams' }, { 'Model.Use': true }), row(2, user, upstream, { 'Model.Use': false }), row(3, user, model, { 'Model.Use': true })];
  expect(resolve(records).records.map(row => row.id)).toEqual([1, 2]);
  expect(resolve(records, { kind: 'upstreams' }).records.map(row => row.id)).toEqual([1]);
});

test('matching model regexes share priority with exact ids and use their bounded order', () => {
  const records = [row(1, group, { kind: 'upstreamModel', upstreamId: 'up_a', model: { kind: 'regex', value: '^gpt-' } }, { 'Model.Use': false }, 0), row(2, user, model, { 'Model.Use': true }, 1)];
  expect(resolve(records, model).values['Model.Use']).toBe(false);
  expect(resolve(records.map(record => ({ ...record, sortOrder: 1 - record.sortOrder })), model).values['Model.Use']).toBe(true);
});

test('model regex inheritance does not claim arbitrary overlaps with other regexes', () => {
  const scope = { kind: 'upstreamModel' as const, upstreamId: 'up_a', model: { kind: 'regex' as const, value: '^gpt-' } };
  const records = [row(1, group, upstream, { 'Model.Use': true }), row(2, group, scope, { 'Model.Use': false }), row(3, user, { ...scope, model: { kind: 'regex', value: '.*' } }, { 'Model.Use': true })];
  expect(resolve(records, scope).records.map(row => row.id)).toEqual([1, 2]);
  expect(resolve(records, scope).values['Model.Use']).toBe(false);
});

test('a concrete user scope outranks membership scopes independent of sort order', () => {
  const records = [row(1, user, { kind: 'group', groupId: 7 }, { 'User.Audit': true }, 0), row(2, group, { kind: 'user', userId: 9 }, { 'User.Audit': false }, 100)];
  expect(resolveAssignments(records, { kind: 'user', userId: 9 }, { targetGroups: new Set([7]) }).values['User.Audit']).toBe(false);
});

test('group membership scopes do not apply to unrelated target users', () => {
  const records = [row(1, user, { kind: 'group', groupId: 7 }, { 'User.Audit': true })];
  expect(resolveAssignments(records, { kind: 'user', userId: 9 }, { targetGroups: new Set() }).values['User.Audit']).toBe(false);
});

test('/Self rules participate when resolving the owning user\'s user scope', () => {
  const records = [row(1, group, { kind: 'self' }, { 'Permission.Audit': true })];
  const result = resolveEffectiveAssignments({ records, scope: { kind: 'user', userId: 2 }, targetGroups: new Set(), isAdmin: false, subjectUserId: 2 });
  expect(result.values['Permission.Audit']).toBe(true);
  expect(result.records.map(record => record.id)).toEqual([1]);
});

test('Self rules are the highest precedence for the owning user', () => {
  const records = [
    row(1, user, { kind: 'users' }, { 'Permission.Audit': true }),
    row(2, user, { kind: 'user', userId: 2 }, { 'Permission.Audit': false }),
    row(3, user, { kind: 'self' }, { 'Permission.Audit': true }),
  ];
  expect(resolveEffectiveAssignments({ records, scope: { kind: 'user', userId: 2 }, targetGroups: new Set(), isAdmin: false, subjectUserId: 2 }).values['Permission.Audit']).toBe(true);
});

test('a group /Self rule applies to each member user\'s own self, not to the group itself', () => {
  const records = [row(1, group, { kind: 'self' }, { 'Permission.Audit': true })];
  expect(resolveAssignments(records, { kind: 'user', userId: 2 }, { targetGroups: new Set([3]), subjectUserId: 2 }).values['Permission.Audit']).toBe(true);
  expect(resolveAssignments(records, { kind: 'group', groupId: 3 }, { targetGroups: new Set() }).values['Permission.Audit']).toBe(false);
});

test('unassigned values resolve to off at every scope category', () => {
  expect(resolve([], upstream).values).toEqual({ 'Model.Use': false, 'Upstream.Audit': false, 'Upstream.Edit': 'off' });
  expect(resolve([], model).values).toEqual({ 'Model.Use': false });
  expect(resolve([], { kind: 'group', groupId: 3 }).values).toEqual({ 'User.Audit': false, 'Permission.Audit': false });
  expect(resolve([], { kind: 'groups' }).values).toEqual({ 'Permission.Audit': false });
});
