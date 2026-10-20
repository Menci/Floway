import { createAccessResolver } from './resolution.ts';
import type { AccessPrincipal } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User, UserDirectory } from '../repo/types.ts';

export interface PermissionAuditContext {
  directory: UserDirectory;
  userIds: ReadonlySet<number>;
  groupIds: ReadonlySet<number>;
}

export const loadPermissionAuditContext = async (subject: User): Promise<PermissionAuditContext> => {
  const repo = getRepo();
  const directory = await repo.readUserDirectory();
  const memberIdsByGroup = new Map(directory.groups.map(group => [group.id, [] as number[]]));
  for (const membership of directory.memberships) memberIdsByGroup.get(membership.groupId)!.push(membership.userId);
  if (subject.isAdmin) {
    const groupIds = new Set(directory.groups.map(group => group.id));
    return {
      directory,
      userIds: new Set(directory.users.map(user => user.id)),
      groupIds,
    };
  }

  const subjectGroupIds = directory.groups.filter(group => memberIdsByGroup.get(group.id)!.includes(subject.id)).map(group => group.id);
  const principals: AccessPrincipal[] = [
    { kind: 'user', id: subject.id },
    ...subjectGroupIds.map(id => ({ kind: 'group' as const, id })),
  ];
  const authorizationRecords = await repo.accessRecords.listByPrincipals(principals);
  const resolver = createAccessResolver(authorizationRecords);
  const userIds = new Set(directory.users.flatMap(user => resolver.satisfies(
    { kind: 'user', userId: user.id },
    { permission: 'Permission.Audit' },
    { targetGroups: new Set(), subjectUserId: subject.id },
  ) ? [user.id] : []));
  const directlyAuditedGroupIds = new Set(directory.groups.flatMap(group => resolver.satisfies(
    { kind: 'group', groupId: group.id },
    { permission: 'Permission.Audit' },
    { targetGroups: new Set() },
  ) ? [group.id] : []));
  // Auditing a user carries their membership groups: the group's rules explain
  // the user's effective permissions, so the group itself becomes auditable.
  const groupIds = new Set([
    ...directlyAuditedGroupIds,
    ...directory.groups.filter(group => memberIdsByGroup.get(group.id)!.some(userId => userIds.has(userId))).map(group => group.id),
  ]);
  return { directory, userIds, groupIds };
};

export const canAuditPrincipal = async (subject: User, principal: AccessPrincipal): Promise<boolean> => {
  if (subject.isAdmin) return true;
  const context = await loadPermissionAuditContext(subject);
  return principal.kind === 'user' ? context.userIds.has(principal.id) : context.groupIds.has(principal.id);
};

export const hasPermissionAuditTarget = (context: PermissionAuditContext): boolean =>
  context.userIds.size > 0 || context.groupIds.size > 0;

export const canViewPermissions = async (subject: User): Promise<boolean> => {
  if (subject.isAdmin) return true;
  return hasPermissionAuditTarget(await loadPermissionAuditContext(subject));
};

export const permissionAuditVisiblePrincipals = (context: PermissionAuditContext): AccessPrincipal[] => [
  ...[...context.userIds].map(id => ({ kind: 'user' as const, id })),
  ...[...context.groupIds].map(id => ({ kind: 'group' as const, id })),
];
