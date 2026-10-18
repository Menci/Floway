import { accessScopeDepth, accessScopeKey, accessValueSatisfied, administratorAccessValues, permissionsForScope, upstreamEditLevelRank } from './types.ts';
import type { AccessPermission, AccessRecord, AccessRequirement, AccessResolution, AccessScope, AccessTarget, AccessValues, PermissionDecisions } from './types.ts';

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

const matches = (outer: AccessScope, outerKey: string, regex: RegExp | null, inner: AccessScope, targetGroups: ReadonlySet<number>, self: boolean): boolean => {
  if (outerKey === accessScopeKey(inner)) return true;
  switch (outer.kind) {
  case 'self': return self && inner.kind === 'user';
  case 'upstreams': return inner.kind === 'upstream' || inner.kind === 'upstreamModel';
  case 'upstream': return inner.kind === 'upstreamModel' && inner.upstreamId === outer.upstreamId;
  case 'upstreamModel': return inner.kind === 'upstreamModel' && inner.upstreamId === outer.upstreamId
    && inner.model.kind === 'exact' && outer.model.kind === 'regex' && regex!.test(inner.model.value);
  case 'users': return inner.kind === 'user';
  case 'groups': return inner.kind === 'group';
  case 'group': return inner.kind === 'user' && targetGroups.has(outer.groupId);
  case 'user': return false;
  }
};

const valueRank = (value: NonNullable<AccessValues[AccessPermission]>) => typeof value === 'boolean' ? Number(value) : upstreamEditLevelRank[value];
const groupScopeParticipates = (permission: AccessPermission): boolean => permission === 'User.Audit';
// A concrete user outranks membership scopes; exact model ids and regexes share
// one ordered level. Only model-pattern precedence is operator-controlled.
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : accessScopeDepth(scope);

export const targetScope = (target: AccessTarget): AccessScope => target.kind === 'upstreamModel'
  ? { kind: 'upstreamModel', upstreamId: target.upstreamId, model: { kind: 'exact', value: target.modelId } }
  : target;

const resolvePreparedAssignments = (
  prepared: readonly PreparedAccessRecord[],
  scope: AccessScope,
  targetGroups: ReadonlySet<number>,
  self = false,
): AccessResolution => {
  const applicable = prepared.filter(record => matches(record.record.scope, record.scopeKey, record.regex, scope, targetGroups, self));
  const decisions = new Map<number, PermissionDecisions>(applicable.map(({ record }) => [record.id, {}]));
  const values: AccessValues = {};
  for (const permission of permissionsForScope(scope)) {
    const assignments = applicable.filter(record => record.record.values[permission] !== undefined
      && !(scope.kind === 'user' && record.record.scope.kind === 'group' && !groupScopeParticipates(permission)));
    const buckets = [...Map.groupBy(assignments, record => record.scopeKey).values()]
      .map(rows => ({ scope: rows[0]!.record.scope, rows, order: Math.min(...rows.map(row => row.record.sortOrder)), id: Math.min(...rows.map(row => row.record.id)) }))
      .toSorted((left, right) => precedenceDepth(right.scope) - precedenceDepth(left.scope)
        || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
          ? left.order - right.order || left.id - right.id
          : accessScopeKey(left.scope).localeCompare(accessScopeKey(right.scope), 'en', { numeric: true })));
    const bucket = buckets[0];
    const personal = bucket?.rows.filter(row => row.record.principal.kind === 'user');
    const winners = personal && personal.length > 0 ? personal : bucket?.rows ?? [];
    const representative = winners.reduce<PreparedAccessRecord | null>((highest, row) =>
      highest === null || valueRank(row.record.values[permission]!) > valueRank(highest.record.values[permission]!) ? row : highest, null);
    if (permission === 'Upstream.Edit') values[permission] = representative === null ? 'off' : representative.record.values[permission];
    else values[permission] = representative === null ? false : representative.record.values[permission];
    if (representative === null) continue;
    const active = new Set(winners.map(row => row.record.id));
    const assigned = new Set(assignments.map(row => row.record.id));
    for (const { record } of applicable) {
      if (assigned.has(record.id)) decisions.get(record.id)![permission] = active.has(record.id) ? { kind: 'effective' } : { kind: 'overridden', by: representative.record };
    }
  }
  return { values, records: applicable.map(({ record }) => record), decisions: [...decisions].map(([recordId, permissions]) => ({ recordId, permissions })) };
};

export interface AccessResolver {
  resolve(scope: AccessScope, targetGroups: ReadonlySet<number>, self?: boolean): AccessResolution;
  satisfies(scope: AccessScope, targetGroups: ReadonlySet<number>, requirement: AccessRequirement, self?: boolean): boolean;
}

export const createAccessResolver = (records: readonly AccessRecord[]): AccessResolver => {
  const prepared = records.map((record): PreparedAccessRecord => ({
    record,
    scopeKey: accessScopeKey(record.scope),
    regex: record.scope.kind === 'upstreamModel' && record.scope.model.kind === 'regex' ? new RegExp(record.scope.model.value) : null,
  }));
  const upstream = prepared.filter(({ record }) => record.scope.kind.startsWith('upstream'));
  const user = prepared.filter(({ record }) => !record.scope.kind.startsWith('upstream'));
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
  const candidates = (scope: AccessScope, targetGroups: ReadonlySet<number>, requirement: AccessRequirement, self: boolean): AccessBucket[] => {
    const result: Array<AccessBucket | undefined> = [];
    switch (scope.kind) {
    case 'upstream': result.push(upstreamBuckets.get(scope.upstreamId), upstreamsBucket); break;
    case 'upstreamModel':
      result.push(
        ...(modelBuckets.get(scope.upstreamId) ?? []).filter(bucket => bucket.scope.kind === 'upstreamModel'
          && (bucket.scope.model.kind === 'exact'
            ? bucket.scope.model.value === scope.model.value
            : bucket.regex!.test(scope.model.value))),
        upstreamBuckets.get(scope.upstreamId),
        upstreamsBucket,
      );
      break;
    case 'user': result.push(
      self ? selfBucket : undefined,
      userBuckets.get(scope.userId),
      ...(groupScopeParticipates(requirement.permission) ? [...targetGroups].map(id => groupBuckets.get(id)) : []),
      usersBucket,
    ); break;
    case 'group': result.push(groupBuckets.get(scope.groupId), groupsBucket); break;
    case 'upstreams': result.push(upstreamsBucket); break;
    case 'users': result.push(usersBucket); break;
    case 'groups': result.push(groupsBucket); break;
    case 'self': result.push(selfBucket); break;
    }
    return result.filter((value): value is AccessBucket => value !== undefined)
      .toSorted((left, right) => precedenceDepth(right.scope) - precedenceDepth(left.scope)
        || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
          ? left.order - right.order || left.id - right.id
          : left.scopeKey.localeCompare(right.scopeKey, 'en', { numeric: true })));
  };
  const cache = new Map<string, AccessResolution>();
  return {
    resolve(scope, targetGroups, self = false) {
      const targetGroupsKey = [...targetGroups].toSorted((left, right) => left - right).join(',');
      const key = `${accessScopeKey(scope)}\0${targetGroupsKey}\0${Number(self)}`;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const resolution = resolvePreparedAssignments(scope.kind.startsWith('upstream') ? upstream : user, scope, targetGroups, self);
      cache.set(key, resolution);
      return resolution;
    },
    satisfies(scope, targetGroups, requirement, self = false) {
      for (const bucket of candidates(scope, targetGroups, requirement, self)) {
        const rows = bucket.rows.filter(row => row.record.values[requirement.permission] !== undefined);
        if (rows.length === 0) continue;
        const personal = rows.filter(row => row.record.principal.kind === 'user');
        const winners = personal.length > 0 ? personal : rows;
        const representative = winners.reduce((highest, row) =>
          valueRank(row.record.values[requirement.permission]!) > valueRank(highest.record.values[requirement.permission]!) ? row : highest);
        return accessValueSatisfied(representative.record.values[requirement.permission], requirement);
      }
      return false;
    },
  };
};

// Callers supply only the selected principal's personal and membership rules.
// Scope wins first, personal assignment wins within that scope, then group
// assignments combine by maximum while all contributing group rules stay active.
// A /Group rule never contributes Permission.Audit to a user resolution.
export const resolveAssignments = (records: readonly AccessRecord[], scope: AccessScope, targetGroups: ReadonlySet<number>, self = false): AccessResolution =>
  createAccessResolver(records).resolve(scope, targetGroups, self);

export const resolveEffectiveAssignments = (
  records: readonly AccessRecord[],
  scope: AccessScope,
  targetGroups: ReadonlySet<number>,
  isAdmin: boolean,
  selfUserId?: number,
): AccessResolution => {
  const self = scope.kind === 'user' && scope.userId === selfUserId;
  const resolution = resolveAssignments(records, scope, targetGroups, self);
  if (isAdmin) return { ...resolution, values: administratorAccessValues(scope), decisions: [] };
  if (self) {
    return {
      ...resolution,
      values: { ...resolution.values, 'User.Audit': true },
      decisions: resolution.decisions.map(({ recordId, permissions }) => {
        const { 'User.Audit': _selfAudit, ...rest } = permissions;
        return { recordId, permissions: rest };
      }),
    };
  }
  return resolution;
};
