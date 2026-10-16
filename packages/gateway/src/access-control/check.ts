import {
  accessScopeDepth,
  accessScopeOrderGroup,
  type AccessCheck,
  type AccessPermission,
  type AccessRecord,
  type AccessRequirement,
  type AccessTarget,
  type AccessValues,
  type UpstreamEditLevel,
} from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User } from '../repo/types.ts';

const editRank: Record<UpstreamEditLevel, number> = { off: 0, models: 1, full: 2 };

const requirementPermission = (requirement: AccessRequirement): AccessPermission => requirement.permission;

const assertCompatible = (target: AccessTarget, requirement: AccessRequirement): void => {
  const compatible = target.kind === 'upstreamModel'
    ? requirement.permission === 'Model.Use'
    : target.kind === 'upstream'
      ? requirement.permission === 'Model.Use' || requirement.permission === 'Upstream.Audit' || requirement.permission === 'Upstream.Edit'
      : requirement.permission === 'User.Audit';
  if (!compatible) throw new Error(`${requirement.permission} is not valid for ${target.kind}`);
};

const scopeMatches = (
  record: AccessRecord,
  target: AccessTarget,
  targetGroups: ReadonlySet<number>,
): boolean => {
  const { scope } = record;
  if (target.kind === 'upstream') {
    return scope.kind === 'upstreams' || (scope.kind === 'upstream' && scope.upstreamId === target.upstreamId);
  }
  if (target.kind === 'upstreamModel') {
    if (scope.kind === 'upstreams') return true;
    if (scope.kind === 'upstream') return scope.upstreamId === target.upstreamId;
    if (scope.kind !== 'upstreamModel' || scope.upstreamId !== target.upstreamId) return false;
    return scope.model.kind === 'exact'
      ? scope.model.value === target.modelId
      : new RegExp(scope.model.value).test(target.modelId);
  }
  return scope.kind === 'users'
    || (scope.kind === 'user' && scope.userId === target.userId)
    || (scope.kind === 'group' && targetGroups.has(scope.groupId));
};

const resolvePrincipalValue = (
  records: readonly AccessRecord[],
  target: AccessTarget,
  targetGroups: ReadonlySet<number>,
  permission: AccessPermission,
): AccessValues[AccessPermission] => records
  .filter(record => record.values[permission] !== undefined && scopeMatches(record, target, targetGroups))
  .toSorted((left, right) => {
    const depth = accessScopeDepth(right.scope) - accessScopeDepth(left.scope);
    if (depth !== 0) return depth;
    const group = accessScopeOrderGroup(left.scope).localeCompare(accessScopeOrderGroup(right.scope));
    if (group !== 0) return group;
    return left.sortOrder - right.sortOrder || left.id - right.id;
  })[0]?.values[permission];

const combineValues = (
  values: readonly AccessValues[AccessPermission][],
  permission: AccessPermission,
): boolean | UpstreamEditLevel => {
  if (permission === 'Upstream.Edit') {
    return values.reduce<UpstreamEditLevel>((highest, value) => {
      const level = value as UpstreamEditLevel | undefined;
      return level !== undefined && editRank[level] > editRank[highest] ? level : highest;
    }, 'off');
  }
  return values.some(Boolean);
};

const satisfies = (value: boolean | UpstreamEditLevel, requirement: AccessRequirement): boolean =>
  requirement.permission === 'Upstream.Edit'
    ? editRank[value as UpstreamEditLevel] >= editRank[requirement.level]
    : value === true;

const evaluateMany = async (
  subject: User,
  checks: readonly AccessCheck[],
  excludedRecordIds: ReadonlySet<number>,
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
  const recordsByPrincipal = Map.groupBy(
    records.filter(record => !excludedRecordIds.has(record.id)),
    record => `${record.principal.kind}:${record.principal.id}`,
  );

  return checks.map(({ target, requirement }) => {
    const permission = requirementPermission(requirement);
    const targetGroups = target.kind === 'user'
      ? new Set(targetMemberships.get(target.userId) ?? [])
      : new Set<number>();
    const principalValues = principals.map(principal => resolvePrincipalValue(
      recordsByPrincipal.get(`${principal.kind}:${principal.id}`) ?? [],
      target,
      targetGroups,
      permission,
    ));
    return satisfies(combineValues(principalValues, permission), requirement);
  });
};

export const checkMany = async (subject: User, checks: readonly AccessCheck[]): Promise<boolean[]> =>
  await evaluateMany(subject, checks, new Set());

export const checkManyForManagement = async (
  subject: User,
  checks: readonly AccessCheck[],
  excludedRecordIds: ReadonlySet<number>,
): Promise<boolean[]> => await evaluateMany(subject, checks, excludedRecordIds);

export const check = async (subject: User, target: AccessTarget, requirement: AccessRequirement): Promise<boolean> =>
  (await checkMany(subject, [{ target, requirement }]))[0]!;
