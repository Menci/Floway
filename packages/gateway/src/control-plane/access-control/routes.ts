import { canAuditPrincipal, hasPermissionAuditTarget, loadPermissionAuditContext, permissionAuditVisiblePrincipals, type PermissionAuditContext } from '../../access-control/permission-audit.ts';
import { resolveEffectiveAssignments } from '../../access-control/resolution.ts';
import { AccessRecordConflictError } from '../../access-control/types.ts';
import type { AccessPrincipal, AccessRecord, AccessRecordInput } from '../../access-control/types.ts';
import { storedCatalogSize } from '../../data-plane/providers/catalog.ts';
import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { accessRecordBody, reorderAccessRecordsBody, resolveAccessBody } from '../schemas.ts';
import { userToAdminWire } from '../users/wire.ts';
import { defaultUserPreferences } from '@floway-dev/protocols/common';

const parseRecordId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const principalError = async (input: AccessRecordInput): Promise<string | null> => {
  const repo = getRepo();
  const exists = input.principal.kind === 'user'
    ? await repo.users.getById(input.principal.id)
    : await repo.groups.getById(input.principal.id);
  return exists ? null : `Unknown ${input.principal.kind} principal ${input.principal.id}`;
};

const loadPermissionSnapshot = async (c: AuthedContext): Promise<{
  context: PermissionAuditContext;
  visibleRecords: AccessRecord[];
} | null> => {
  const context = await loadPermissionAuditContext(userFromContext(c));
  if (!hasPermissionAuditTarget(context)) return null;
  const visibleRecords = await getRepo().accessRecords.listByPrincipals(permissionAuditVisiblePrincipals(context));
  return { context, visibleRecords };
};

const projectPermissionDirectory = async (context: PermissionAuditContext, records: readonly AccessRecord[], admin: boolean) => {
  const renderUserIds = new Set(admin ? context.directory.users.map(user => user.id) : context.userIds);
  const renderGroupIds = new Set(admin ? context.directory.groups.map(group => group.id) : context.groupIds);
  if (!admin) {
    for (const record of records) {
      if (record.scope.kind === 'user') renderUserIds.add(record.scope.userId);
      else if (record.scope.kind === 'group') renderGroupIds.add(record.scope.groupId);
    }
  }
  // The permissions workspace reasons about a group's members, while the
  // user directory publishes flat memberships so it can also carry join times.
  const memberIdsByGroup = new Map(context.directory.groups.map(group => [group.id, [] as number[]]));
  for (const membership of context.directory.memberships) memberIdsByGroup.get(membership.groupId)!.push(membership.userId);
  const groups = context.directory.groups
    .filter(group => renderGroupIds.has(group.id))
    .map(group => ({
      ...group,
      memberIds: admin ? memberIdsByGroup.get(group.id)! : memberIdsByGroup.get(group.id)!.filter(userId => context.userIds.has(userId)),
    }));
  const groupIdsByUser = new Map([...renderUserIds].map(userId => [userId, [] as number[]]));
  for (const group of groups) for (const userId of group.memberIds) groupIdsByUser.get(userId)!.push(group.id);
  const preferenceRows = await getRepo().userPreferences.listAll();
  const preferencesByUser = new Map(preferenceRows.map(row => [row.userId, row.preferences]));
  return {
    users: context.directory.users.filter(user => renderUserIds.has(user.id)).map(user => userToAdminWire(
      user,
      groupIdsByUser.get(user.id)!,
      preferencesByUser.get(user.id) ?? defaultUserPreferences,
    )),
    groups,
    principalUserIds: context.directory.users.filter(user => context.userIds.has(user.id)).map(user => user.id),
    principalGroupIds: context.directory.groups.filter(group => context.groupIds.has(group.id)).map(group => group.id),
  };
};

const permissionUpstreamOptions = async (visibleRecords: readonly AccessRecord[], admin: boolean) => {
  const items = await getRepo().upstreams.list();
  const all = admin || visibleRecords.some(record => record.scope.kind === 'upstreams');
  const ids = new Set(visibleRecords.flatMap(record => record.scope.kind === 'upstream' || record.scope.kind === 'upstreamModel' ? [record.scope.upstreamId] : []));
  return items.filter(item => all || ids.has(item.id)).map(item => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    enabled: item.enabled,
    hue: item.hue,
    cachedModelCount: storedCatalogSize(item),
  }));
};

export const listAccessRecords = async (c: AuthedContext) => {
  const snapshot = await loadPermissionSnapshot(c);
  return snapshot === null ? c.json({ error: 'Permission audit access required' }, 403) : c.json(snapshot.visibleRecords);
};

export const getPermissionsData = async (c: AuthedContext) => {
  const snapshot = await loadPermissionSnapshot(c);
  if (snapshot === null) return c.json({ error: 'Permission audit access required' }, 403);
  const admin = userFromContext(c).isAdmin;
  const upstreams = await permissionUpstreamOptions(snapshot.visibleRecords, admin);
  const directory = await projectPermissionDirectory(snapshot.context, snapshot.visibleRecords, admin);
  return c.json({ records: snapshot.visibleRecords, directory, upstreams });
};

export const createAccessRecord = async (c: CtxWithJson<typeof accessRecordBody>) => {
  const input = c.req.valid('json');
  const error = await principalError(input);
  if (error) return c.json({ error }, 400);
  try {
    return c.json(await getRepo().accessRecords.save(input), 201);
  } catch (cause) {
    if (cause instanceof AccessRecordConflictError) return c.json({ error: cause.message }, 409);
    throw cause;
  }
};

export const updateAccessRecord = async (c: CtxWithJson<typeof accessRecordBody>) => {
  const id = parseRecordId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid access record id' }, 400);
  const input = c.req.valid('json');
  const error = await principalError(input);
  if (error) return c.json({ error }, 400);
  try {
    const record = await getRepo().accessRecords.replace(id, input);
    return record ? c.json(record) : c.json({ error: 'access record not found' }, 404);
  } catch (cause) {
    if (cause instanceof AccessRecordConflictError) return c.json({ error: cause.message }, 409);
    throw cause;
  }
};

export const deleteAccessRecord = async (c: AuthedContext) => {
  const id = parseRecordId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid access record id' }, 400);
  return await getRepo().accessRecords.delete(id)
    ? c.json({ ok: true })
    : c.json({ error: 'access record not found' }, 404);
};

export const resolveAccess = async (c: CtxWithJson<typeof resolveAccessBody>) => {
  const { principal, scope, excludeRecordId } = c.req.valid('json');
  const repo = getRepo();
  const actor = userFromContext(c);
  if (!await canAuditPrincipal(actor, principal)) {
    return c.json({ error: 'Principal not found' }, 404);
  }
  const subject = principal.kind === 'user' ? await repo.users.getById(principal.id) : await repo.groups.getById(principal.id);
  if (!subject) return c.json({ error: `${principal.kind} not found` }, 404);
  const groupIds = principal.kind === 'user' ? await repo.groups.listIdsByUserId(principal.id) : [];
  const principals: AccessPrincipal[] = [principal, ...groupIds.map(id => ({ kind: 'group' as const, id }))];
  const records = await repo.accessRecords.listByPrincipals(principals);
  const targetGroups = scope.kind === 'user' && principal.kind === 'user' && scope.userId === principal.id
    ? new Set(groupIds)
    : new Set<number>();
  const resolution = resolveEffectiveAssignments({
    records: records.filter(record => record.id !== excludeRecordId),
    scope,
    targetGroups,
    isAdmin: principal.kind === 'user' && (subject as { isAdmin: boolean }).isAdmin,
    subjectUserId: principal.kind === 'user' ? principal.id : undefined,
  });
  return c.json(resolution);
};

export const reorderAccessRecords = async (c: CtxWithJson<typeof reorderAccessRecordsBody>) => {
  const { expectedIds, ids } = c.req.valid('json');
  const repo = getRepo();
  const first = await repo.accessRecords.getById(expectedIds[0]!);
  if (first?.scope.kind !== 'upstreamModel') return c.json({ error: 'Rules do not belong to a model-pattern reorder segment.' }, 409);
  const records = await repo.accessRecords.reorderModel(first.scope.upstreamId, expectedIds, ids);
  return records === null
    ? c.json({ error: 'Rules changed or cross a fixed priority boundary. Refresh before reordering.' }, 409)
    : c.json({ records });
};
