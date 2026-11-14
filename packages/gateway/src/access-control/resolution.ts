import { accessScopeDepth, accessScopeKey, accessValueSatisfied, administratorAccessValues, groupRuleAppliesToMembers, permissionsForScope, upstreamEditLevelRank } from './types.ts';
import type { AccessEvaluation, AccessPermission, AccessRecord, AccessRequirement, AccessResolution, AccessScope, AccessValues, PermissionDecisions, ResolveScope } from './types.ts';

interface PreparedAccessRecord {
  record: AccessRecord;
  scopeKey: string;
  regex: RegExp | null;
}

interface AccessBucket {
  scope: AccessScope;
  scopeKey: string;
  regex: RegExp | null;
  rows: PreparedAccessRecord[];
  order: number;
  id: number;
}

const valueRank = (value: NonNullable<AccessValues[AccessPermission]>) => typeof value === 'boolean' ? Number(value) : upstreamEditLevelRank[value];
// A concrete user outranks membership scopes; exact model ids and regexes share
// one ordered level. Only model-pattern precedence is operator-controlled.
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : accessScopeDepth(scope);
const isSelfUserScope = (scope: ResolveScope, subjectUserId?: number): boolean =>
  scope.kind === 'user' && scope.userId === subjectUserId;
const isGroupScope = (scope: AccessScope): boolean => scope.kind === 'group';

const eligibleRows = (bucket: AccessBucket, target: ResolveScope, permission: AccessPermission, targetGroups: ReadonlySet<number>): PreparedAccessRecord[] =>
  bucket.rows.filter(row => row.record.values[permission] !== undefined
    && !(target.kind === 'user' && isGroupScope(row.record.scope)
      && (!groupRuleAppliesToMembers[permission] || targetGroups.size === 0)));

const selectRepresentative = (rows: readonly PreparedAccessRecord[], permission: AccessPermission) => {
  const personal = rows.filter(row => row.record.principal.kind === 'user');
  const winners = personal.length > 0 ? personal : rows;
  const representative = winners.reduce((best, row) =>
    valueRank(row.record.values[permission]!) > valueRank(best.record.values[permission]!) ? row : best);
  return { winners, representative };
};

const winningSelection = (
  buckets: readonly AccessBucket[],
  target: ResolveScope,
  permission: AccessPermission,
  targetGroups: ReadonlySet<number>,
) => {
  for (const bucket of buckets) {
    const rows = eligibleRows(bucket, target, permission, targetGroups);
    if (rows.length > 0) return selectRepresentative(rows, permission);
  }
  return null;
};

const resolveBuckets = (
  prepared: readonly PreparedAccessRecord[],
  buckets: readonly AccessBucket[],
  scope: ResolveScope,
  targetGroups: ReadonlySet<number>,
): AccessResolution => {
  const applicableIds = new Set(buckets.flatMap(bucket => bucket.rows.map(row => row.record.id)));
  const applicable = prepared.filter(row => applicableIds.has(row.record.id));
  const decisions = new Map<number, PermissionDecisions>(applicable.map(({ record }) => [record.id, {}]));
  const values: AccessValues = {};
  for (const permission of permissionsForScope(scope)) {
    const selection = winningSelection(buckets, scope, permission, targetGroups);
    const representative = selection?.representative ?? null;
    if (permission === 'Upstream.Edit') values[permission] = representative === null ? 'off' : representative.record.values[permission];
    else values[permission] = representative === null ? false : representative.record.values[permission];
    if (selection === null) continue;
    const active = new Set(selection.winners.map(row => row.record.id));
    for (const { record } of applicable) {
      if (record.values[permission] === undefined) continue;
      if (scope.kind === 'user' && isGroupScope(record.scope)
        && (!groupRuleAppliesToMembers[permission] || targetGroups.size === 0)) continue;
      decisions.get(record.id)![permission] = active.has(record.id)
        ? { kind: 'effective' }
        : { kind: 'overridden', by: selection.representative.record };
    }
  }
  return { values, records: applicable.map(({ record }) => record), decisions: [...decisions].map(([recordId, permissions]) => ({ recordId, permissions })) };
};

export interface AccessResolver {
  resolve(scope: ResolveScope, evaluation: AccessEvaluation): AccessResolution;
  satisfies(scope: ResolveScope, requirement: AccessRequirement, evaluation: AccessEvaluation): boolean;
}

export const createAccessResolver = (records: readonly AccessRecord[]): AccessResolver => {
  const prepared = records.map((record): PreparedAccessRecord => ({
    record,
    scopeKey: accessScopeKey(record.scope),
    regex: record.scope.kind === 'upstreamModel' && record.scope.model.kind === 'regex' ? new RegExp(record.scope.model.value) : null,
  }));
  const bucketsByKey = new Map<string, AccessBucket>();
  for (const row of prepared) {
    const current = bucketsByKey.get(row.scopeKey);
    if (current) current.rows.push(row);
    else bucketsByKey.set(row.scopeKey, {
      scope: row.record.scope,
      scopeKey: row.scopeKey,
      regex: row.regex,
      rows: [row],
      order: row.record.sortOrder,
      id: row.record.id,
    });
  }
  for (const bucket of bucketsByKey.values()) {
    bucket.order = Math.min(...bucket.rows.map(row => row.record.sortOrder));
    bucket.id = Math.min(...bucket.rows.map(row => row.record.id));
  }
  const upstreamBuckets = new Map<string, AccessBucket>();
  const modelBuckets = new Map<string, AccessBucket[]>();
  const userBuckets = new Map<number, AccessBucket>();
  const groupBuckets = new Map<number, AccessBucket>();
  let selfBucket: AccessBucket | undefined;
  let upstreamsBucket: AccessBucket | undefined;
  let usersBucket: AccessBucket | undefined;
  let groupsBucket: AccessBucket | undefined;
  for (const value of bucketsByKey.values()) {
    switch (value.scope.kind) {
    case 'self': selfBucket = value; break;
    case 'upstreams': upstreamsBucket = value; break;
    case 'upstream': upstreamBuckets.set(value.scope.upstreamId, value); break;
    case 'upstreamModel': {
      const rows = modelBuckets.get(value.scope.upstreamId);
      if (rows) rows.push(value); else modelBuckets.set(value.scope.upstreamId, [value]);
      break;
    }
    case 'users': usersBucket = value; break;
    case 'user': userBuckets.set(value.scope.userId, value); break;
    case 'group': groupBuckets.set(value.scope.groupId, value); break;
    case 'groups': groupsBucket = value; break;
    }
  }
  for (const rows of modelBuckets.values()) rows.sort((left, right) => left.order - right.order || left.id - right.id);
  const candidates = (scope: ResolveScope, targetGroups: ReadonlySet<number>, self: boolean): AccessBucket[] => {
    const result: Array<AccessBucket | undefined> = [];
    switch (scope.kind) {
    case 'upstream': result.push(upstreamBuckets.get(scope.upstreamId), upstreamsBucket); break;
    case 'upstreamModel': {
      const targetKey = accessScopeKey(scope);
      result.push(
        ...(modelBuckets.get(scope.upstreamId) ?? []).filter(bucket => bucket.scope.kind === 'upstreamModel'
          && (scope.model.kind === 'regex'
            ? bucket.scopeKey === targetKey
            : bucket.scope.model.kind === 'exact'
              ? bucket.scope.model.value === scope.model.value
              : bucket.regex!.test(scope.model.value))),
        upstreamBuckets.get(scope.upstreamId),
        upstreamsBucket,
      );
      break;
    }
    case 'user': result.push(
      self ? selfBucket : undefined,
      userBuckets.get(scope.userId),
      ...[...targetGroups].map(id => groupBuckets.get(id)),
      usersBucket,
    ); break;
    case 'group': result.push(groupBuckets.get(scope.groupId), groupsBucket); break;
    case 'upstreams': result.push(upstreamsBucket); break;
    case 'users': result.push(usersBucket); break;
    case 'groups': result.push(groupsBucket); break;
    }
    return result.filter((value): value is AccessBucket => value !== undefined)
      .toSorted((left, right) => precedenceDepth(right.scope) - precedenceDepth(left.scope)
        || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
          ? left.order - right.order || left.id - right.id
          : left.scopeKey.localeCompare(right.scopeKey, 'en', { numeric: true })));
  };
  const candidatesFor = (scope: ResolveScope, evaluation: AccessEvaluation): AccessBucket[] =>
    candidates(scope, evaluation.targetGroups, isSelfUserScope(scope, evaluation.subjectUserId));
  return {
    resolve(scope, evaluation) {
      return resolveBuckets(prepared, candidatesFor(scope, evaluation), scope, evaluation.targetGroups);
    },
    satisfies(scope, requirement, evaluation) {
      const selection = winningSelection(candidatesFor(scope, evaluation), scope, requirement.permission, evaluation.targetGroups);
      return selection !== null && accessValueSatisfied(selection.representative.record.values[requirement.permission], requirement);
    },
  };
};

// Callers supply only the selected principal's personal and membership rules.
// Scope wins first, personal assignment wins within that scope, then group
// assignments combine by maximum while all contributing group rules stay active.
// A rule scoped to /Groups/:id never contributes Permission.Audit to a user resolution.
export const resolveAssignments = (records: readonly AccessRecord[], scope: ResolveScope, evaluation: AccessEvaluation): AccessResolution =>
  createAccessResolver(records).resolve(scope, evaluation);

export const resolveEffectiveAssignments = ({ records, scope, targetGroups, isAdmin, subjectUserId }: {
  records: readonly AccessRecord[];
  scope: ResolveScope;
  targetGroups: ReadonlySet<number>;
  isAdmin: boolean;
  subjectUserId?: number;
}): AccessResolution => {
  const resolution = resolveAssignments(records, scope, { targetGroups, subjectUserId });
  if (isAdmin) return { ...resolution, values: administratorAccessValues(scope), decisions: [] };
  if (!isSelfUserScope(scope, subjectUserId)) return resolution;
  return {
    ...resolution,
    values: { ...resolution.values, 'User.Audit': true },
    decisions: resolution.decisions.map(({ recordId, permissions }) => {
      const { 'User.Audit': _selfAudit, ...rest } = permissions;
      return { recordId, permissions: rest };
    }),
  };
};
