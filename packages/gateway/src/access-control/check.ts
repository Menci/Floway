import { resolveAssignments, targetScope } from './resolution.ts';
import type { AccessCheck, AccessRequirement, AccessTarget, UpstreamEditLevel } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User } from '../repo/types.ts';

const editRank: Record<UpstreamEditLevel, number> = { off: 0, models: 1, full: 2 };

const assertCompatible = (target: AccessTarget, requirement: AccessRequirement): void => {
  const compatible = target.kind === 'upstreamModel'
    ? requirement.permission === 'Model.Use'
    : target.kind === 'upstream'
      ? requirement.permission === 'Model.Use' || requirement.permission === 'Upstream.Audit' || requirement.permission === 'Upstream.Edit'
      : requirement.permission === 'User.Audit';
  if (!compatible) throw new Error(`${requirement.permission} is not valid for ${target.kind}`);
};

const satisfies = (value: boolean | UpstreamEditLevel, requirement: AccessRequirement): boolean =>
  requirement.permission === 'Upstream.Edit'
    ? editRank[value as UpstreamEditLevel] >= editRank[requirement.level]
    : value === true;

export const checkMany = async (
  subject: User,
  checks: readonly AccessCheck[],
): Promise<boolean[]> => {
  for (const check of checks) assertCompatible(check.target, check.requirement);
  if (subject.isAdmin) return checks.map(() => true);
  if (checks.length === 0) return [];

  const repo = getRepo();
  const targetUserIds = [...new Set(checks.flatMap(check => check.target.kind === 'user' ? [check.target.userId] : []))];
  const subjectGroupIds = await repo.groups.listIdsByUserId(subject.id);
  const principals = [{ kind: 'user' as const, id: subject.id }, ...subjectGroupIds.map(id => ({ kind: 'group' as const, id }))];
  const [records, targetMemberships] = await Promise.all([
    repo.accessRecords.listByPrincipals(principals),
    repo.groups.listIdsByUserIds(targetUserIds),
  ]);
  return checks.map(({ target, requirement }) => {
    const permission = requirement.permission;
    const targetGroups = target.kind === 'user'
      ? new Set(targetMemberships.get(target.userId)!)
      : new Set<number>();
    const { values } = resolveAssignments(records, targetScope(target), targetGroups);
    return satisfies(values[permission]!, requirement);
  });
};

export const check = async (subject: User, target: AccessTarget, requirement: AccessRequirement): Promise<boolean> =>
  (await checkMany(subject, [{ target, requirement }]))[0]!;
