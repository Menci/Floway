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

interface EligibleAccessRow<Permission extends AccessPermission> {
  record: AccessRecord;
  value: NonNullable<AccessValues[Permission]>;
}

const valueRank = (value: Required<AccessValues>[AccessPermission]) => typeof value === 'boolean' ? Number(value) : upstreamEditLevelRank[value];
// A concrete user outranks membership scopes; exact model ids and regexes share
// one ordered level. Only model-pattern precedence is operator-controlled.
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : accessScopeDepth(scope);
const isSelfUserScope = (scope: ResolveScope, subjectUserId?: number): boolean =>
  scope.kind === 'user' && scope.userId === subjectUserId;
const isGroupScope = (scope: AccessScope): boolean => scope.kind === 'group';

const eligibleRows = <Permission extends AccessPermission>(bucket: AccessBucket, target: ResolveScope, permission: Permission, targetGroups: ReadonlySet<number>): EligibleAccessRow<Permission>[] =>
  bucket.rows.flatMap(({ record }) => {
    const value = record.values[permission];
    if (value === undefined || (target.kind === 'user' && isGroupScope(record.scope)
      && (!groupRuleAppliesToMembers[permission] || targetGroups.size === 0))) return [];
    return [{ record, value }];
  });

const selectRepresentative = <Permission extends AccessPermission>(rows: readonly EligibleAccessRow<Permission>[]) => {
  const personal = rows.filter(row => row.record.principal.kind === 'user');
  const winners = personal.length > 0 ? personal : rows;
  const representative = winners.reduce((best, row) => valueRank(row.value) > valueRank(best.value) ? row : best);
  return { winners, representative };
};

const winningSelection = <Permission extends AccessPermission>(
  buckets: readonly AccessBucket[],
  target: ResolveScope,
  permission: Permission,
  targetGroups: ReadonlySet<number>,
) => {
  for (const bucket of buckets) {
    const rows = eligibleRows(bucket, target, permission, targetGroups);
    if (rows.length > 0) return selectRepresentative(rows);
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
  const resolvePermission = <Permission extends AccessPermission>(permission: Permission, fallback: NonNullable<AccessValues[Permission]>) => {
    const selection = winningSelection(buckets, scope, permission, targetGroups);
    values[permission] = selection === null ? fallback : selection.representative.value;
    if (selection === null) return;
    const active = new Set(selection.winners.map(row => row.record.id));
    for (const { record } of applicable) {
      if (record.values[permission] === undefined) continue;
      if (scope.kind === 'user' && isGroupScope(record.scope)
        && (!groupRuleAppliesToMembers[permission] || targetGroups.size === 0)) continue;
      decisions.get(record.id)![permission] = active.has(record.id)
        ? { kind: 'effective' }
        : { kind: 'overridden', by: selection.representative.record };
    }
  };
  for (const permission of permissionsForScope(scope)) {
    if (permission === 'Upstream.Edit') resolvePermission(permission, 'off');
    else resolvePermission(permission, false);
  }
  return { values, records: applicable.map(({ record }) => record), decisions: [...decisions].map(([recordId, permissions]) => ({ recordId, permissions })) };
};

export interface ModelUsePlan {
  readonly globalAllowed: boolean;
  readonly candidateUpstreamIds: ReadonlySet<string>;
  readonly deniedUpstreamIds: ReadonlySet<string>;
  readonly upstreamsWithModelRules: ReadonlySet<string>;
  readonly upstreamsWithModelGrants: ReadonlySet<string>;
}

export interface AccessResolver {
  resolve(scope: ResolveScope, evaluation: AccessEvaluation): AccessResolution;
  satisfies(scope: ResolveScope, requirement: AccessRequirement, evaluation: AccessEvaluation): boolean;
  planModelUse(evaluation: AccessEvaluation): ModelUsePlan;
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
    switch (scope.kind) {
    case 'upstream': {
      const out: AccessBucket[] = [];
      const upstreamBucket = upstreamBuckets.get(scope.upstreamId);
      if (upstreamBucket !== undefined) out.push(upstreamBucket);
      if (upstreamsBucket !== undefined) out.push(upstreamsBucket);
      return out;
    }
    case 'upstreamModel': {
      // `modelBuckets` rows are pre-sorted by `(order, id)` and outrank the
      // `upstream` and `upstreams` scopes per `accessScopeDepth`, so no per-check sort is needed.
      const out: AccessBucket[] = [];
      const rows = modelBuckets.get(scope.upstreamId);
      if (rows !== undefined) {
        if (scope.model.kind === 'regex') {
          const targetKey = accessScopeKey(scope);
          for (const bucket of rows) {
            if (bucket.scopeKey === targetKey) out.push(bucket);
          }
        } else {
          const modelValue = scope.model.value;
          for (const bucket of rows) {
            if (bucket.scope.kind === 'upstreamModel'
              && (bucket.scope.model.kind === 'exact'
                ? bucket.scope.model.value === modelValue
                : bucket.regex!.test(modelValue))) {
              out.push(bucket);
            }
          }
        }
      }
      const upstreamBucket = upstreamBuckets.get(scope.upstreamId);
      if (upstreamBucket !== undefined) out.push(upstreamBucket);
      if (upstreamsBucket !== undefined) out.push(upstreamsBucket);
      return out;
    }
    case 'group': {
      const out: AccessBucket[] = [];
      const groupBucket = groupBuckets.get(scope.groupId);
      if (groupBucket !== undefined) out.push(groupBucket);
      if (groupsBucket !== undefined) out.push(groupsBucket);
      return out;
    }
    case 'upstreams': return upstreamsBucket !== undefined ? [upstreamsBucket] : [];
    case 'users': return usersBucket !== undefined ? [usersBucket] : [];
    case 'groups': return groupsBucket !== undefined ? [groupsBucket] : [];
    case 'user': {
      const result: Array<AccessBucket | undefined> = [
        self ? selfBucket : undefined,
        userBuckets.get(scope.userId),
        ...[...targetGroups].map(id => groupBuckets.get(id)),
        usersBucket,
      ];
      return result.filter((value): value is AccessBucket => value !== undefined)
        .toSorted((left, right) => precedenceDepth(right.scope) - precedenceDepth(left.scope)
          || left.scopeKey.localeCompare(right.scopeKey, 'en', { numeric: true }));
    }
    }
  };
  const candidatesFor = (scope: ResolveScope, evaluation: AccessEvaluation): AccessBucket[] =>
    candidates(scope, evaluation.targetGroups, isSelfUserScope(scope, evaluation.subjectUserId));
  const satisfies = (scope: ResolveScope, requirement: AccessRequirement, evaluation: AccessEvaluation): boolean => {
    const selection = winningSelection(candidatesFor(scope, evaluation), scope, requirement.permission, evaluation.targetGroups);
    return selection !== null && accessValueSatisfied(selection.representative.value, requirement);
  };
  return {
    resolve(scope, evaluation) {
      return resolveBuckets(prepared, candidatesFor(scope, evaluation), scope, evaluation.targetGroups);
    },
    satisfies,
    planModelUse(evaluation) {
      const requirement: AccessRequirement = { permission: 'Model.Use' };
      const globalAllowed = satisfies({ kind: 'upstreams' }, requirement, evaluation);
      const upstreamsWithModelRules = new Set<string>();
      const upstreamsWithModelGrants = new Set<string>();
      for (const [upstreamId, buckets] of modelBuckets) {
        let hasRule = false;
        let hasGrant = false;
        for (const bucket of buckets) {
          for (const { record } of bucket.rows) {
            const value = record.values['Model.Use'];
            if (value !== undefined) {
              hasRule = true;
              if (value === true) hasGrant = true;
            }
          }
        }
        if (hasRule) upstreamsWithModelRules.add(upstreamId);
        if (hasGrant) upstreamsWithModelGrants.add(upstreamId);
      }

      const candidateUpstreamIds = new Set<string>();
      const deniedUpstreamIds = new Set<string>();
      if (!globalAllowed) {
        for (const upstreamId of upstreamBuckets.keys()) {
          if (satisfies({ kind: 'upstream', upstreamId }, requirement, evaluation)) {
            candidateUpstreamIds.add(upstreamId);
          }
        }
        for (const upstreamId of upstreamsWithModelGrants) {
          candidateUpstreamIds.add(upstreamId);
        }
      } else {
        for (const upstreamId of upstreamBuckets.keys()) {
          if (!satisfies({ kind: 'upstream', upstreamId }, requirement, evaluation) && !upstreamsWithModelGrants.has(upstreamId)) {
            deniedUpstreamIds.add(upstreamId);
          }
        }
      }

      return {
        globalAllowed,
        candidateUpstreamIds,
        deniedUpstreamIds,
        upstreamsWithModelRules,
        upstreamsWithModelGrants,
      };
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
  subjectUserId?: number | undefined;
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
