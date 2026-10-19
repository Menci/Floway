import { createAccessResolver } from './resolution.ts';
import { permissionsForScope } from './types.ts';
import type { AccessCheck, AccessRequirement, AccessTarget } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User } from '../repo/types.ts';

const assertCompatible = (target: AccessTarget, requirement: AccessRequirement): void => {
  const compatible = permissionsForScope(target).includes(requirement.permission);
  if (!compatible) throw new Error(`${requirement.permission} is not valid for ${target.kind}`);
};

export const checkMany = async (
  subject: User,
  checks: readonly AccessCheck[],
): Promise<boolean[]> => {
  for (const check of checks) assertCompatible(check.target, check.requirement);
  const bypass = checks.map(({ target, requirement }) => subject.isAdmin
    || (requirement.permission === 'User.Audit' && target.kind === 'user' && target.userId === subject.id));
  if (bypass.every(Boolean)) return bypass;

  const repo = getRepo();
  const targetUserIds = [...new Set(checks.flatMap(check => check.target.kind === 'user' ? [check.target.userId] : []))];
  const subjectGroupIds = await repo.groups.listIdsByUserId(subject.id);
  const principals = [{ kind: 'user' as const, id: subject.id }, ...subjectGroupIds.map(id => ({ kind: 'group' as const, id }))];
  const [records, targetMemberships] = await Promise.all([
    repo.accessRecords.listByPrincipals(principals),
    repo.groups.listIdsByUserIds(targetUserIds),
  ]);
  const resolver = createAccessResolver(records);
  return checks.map(({ target, requirement }, index) => {
    if (bypass[index]) return true;
    const targetGroups = target.kind === 'user'
      ? new Set(targetMemberships.get(target.userId)!)
      : new Set<number>();
    return resolver.satisfies(target, requirement, { targetGroups, subjectUserId: subject.id });
  });
};
