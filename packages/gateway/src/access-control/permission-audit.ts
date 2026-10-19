import { checkMany } from './check.ts';
import { createAccessResolver } from './resolution.ts';
import type { AccessPrincipal } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User, UserDirectory } from '../repo/types.ts';

export interface PermissionAuditContext {
  directory: UserDirectory;
  userIds: ReadonlySet<number>;
  directGroupIds: ReadonlySet<number>;
  membershipGroupIds: ReadonlySet<number>;
}

export const loadPermissionAuditContext = async (subject: User): Promise<PermissionAuditContext> => {
  const repo = getRepo();
  const directory = await repo.readUserDirectory();
  if (subject.isAdmin) {
    const groupIds = new Set(directory.groups.map(group => group.id));
    return {
      directory,
      userIds: new Set(directory.users.map(user => user.id)),
      directGroupIds: groupIds,
      membershipGroupIds: new Set(),
    };
  }

  const subjectGroupIds = directory.groups.filter(group => group.memberIds.includes(subject.id)).map(group => group.id);
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
  const directGroupIds = new Set(directory.groups.flatMap(group => resolver.satisfies(
    { kind: 'group', groupId: group.id },
    { permission: 'Permission.Audit' },
    { targetGroups: new Set() },
  ) ? [group.id] : []));
  const membershipGroupIds = new Set(directory.groups
    .filter(group => !directGroupIds.has(group.id) && group.memberIds.some(userId => userIds.has(userId)))
    .map(group => group.id));
  return { directory, userIds, directGroupIds, membershipGroupIds };
};

export const canAuditPrincipal = async (subject: User, principal: AccessPrincipal): Promise<boolean> => {
  const target = principal.kind === 'user'
    ? { kind: 'user' as const, userId: principal.id }
    : { kind: 'group' as const, groupId: principal.id };
  return (await checkMany(subject, [{ target, requirement: { permission: 'Permission.Audit' } }]))[0]!;
};

export const hasPermissionAuditTarget = (context: PermissionAuditContext): boolean =>
  context.userIds.size > 0 || context.directGroupIds.size > 0;

export const canViewPermissions = async (subject: User): Promise<boolean> => {
  if (subject.isAdmin) return true;
  return hasPermissionAuditTarget(await loadPermissionAuditContext(subject));
};

export const permissionAuditVisiblePrincipals = (context: PermissionAuditContext): AccessPrincipal[] => [
  ...[...context.userIds].map(id => ({ kind: 'user' as const, id })),
  ...[...context.directGroupIds].map(id => ({ kind: 'group' as const, id })),
];

export const permissionAuditSourcePrincipals = (context: PermissionAuditContext): AccessPrincipal[] => [
  ...permissionAuditVisiblePrincipals(context),
  ...[...context.membershipGroupIds].map(id => ({ kind: 'group' as const, id })),
];
