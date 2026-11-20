import { filterPrincipalRecords, principalGroupIds } from './principals';
import { scopeCoversTarget, scopeDepth, scopeKey } from './scope';
import type { ScopeExpressionData } from './scope-expression';
import { scopePermissions } from './values';
import type { AccessRecord } from '../../api/types';
import type { AccessPermission, AccessPrincipal, AccessResolution, AccessScope, AccessValues, PermissionDecisions, ResolveScope, UpstreamEditLevel } from '@floway-dev/gateway/browser';

const EDIT_LEVEL_RANK: Record<UpstreamEditLevel, number> = { off: 0, models: 1, full: 2 };
const valueRank = (value: NonNullable<AccessValues[AccessPermission]>) => typeof value === 'boolean' ? Number(value) : EDIT_LEVEL_RANK[value];
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : scopeDepth(scope);

const matchesResolveScope = (recordScope: AccessScope, target: ResolveScope, targetGroups: ReadonlySet<number>, isSelfUser: boolean): boolean =>
  scopeCoversTarget(recordScope, target)
  || (target.kind === 'user' && (
    (isSelfUser && recordScope.kind === 'self')
    || (recordScope.kind === 'group' && targetGroups.has(recordScope.groupId))
  ));

export const resolveAccess = ({ data, excludeRecordId, principal, records, scope }: {
  data: Pick<ScopeExpressionData, 'users'>;
  excludeRecordId?: number;
  principal: AccessPrincipal | null;
  records: readonly AccessRecord[];
  scope: AccessScope | null;
}): AccessResolution | null => {
  if (principal === null || scope === null || scope.kind === 'self') return null;
  const user = principal.kind === 'user' ? data.users.find(candidate => candidate.id === principal.id) : undefined;
  const permissions = scopePermissions(scope);
  const groupIds = new Set(principalGroupIds(principal, data));
  const isSelfUser = scope.kind === 'user' && principal.kind === 'user' && scope.userId === principal.id;
  const targetGroups = isSelfUser ? groupIds : new Set<number>();

  const applicable: AccessRecord[] = [];
  const bucketsByKey = new Map<string, { scope: AccessScope; scopeKey: string; rows: AccessRecord[]; order: number; id: number }>();
  for (const record of filterPrincipalRecords(records, principal, data)) {
    if (record.id === excludeRecordId || !matchesResolveScope(record.scope, scope, targetGroups, isSelfUser)) continue;
    applicable.push(record);
    const key = scopeKey(record.scope);
    const bucket = bucketsByKey.get(key);
    if (bucket) {
      bucket.rows.push(record);
      bucket.order = Math.min(bucket.order, record.sortOrder);
      bucket.id = Math.min(bucket.id, record.id);
    } else {
      bucketsByKey.set(key, { scope: record.scope, scopeKey: key, rows: [record], order: record.sortOrder, id: record.id });
    }
  }
  if (user?.isAdmin) {
    return {
      values: Object.fromEntries(permissions.map(permission => [permission, permission === 'Upstream.Edit' ? 'full' : true])),
      records: applicable,
      decisions: [],
    };
  }

  const buckets = [...bucketsByKey.values()].toSorted((left, right) =>
    precedenceDepth(right.scope) - precedenceDepth(left.scope)
    || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
      ? left.order - right.order || left.id - right.id
      : left.scopeKey.localeCompare(right.scopeKey, 'en', { numeric: true })));

  const decisions = new Map<number, PermissionDecisions>(applicable.map(record => [record.id, {}]));
  const values: AccessValues = {};
  for (const permission of permissions) {
    if (isSelfUser && permission === 'User.Audit') {
      values[permission] = true;
      continue;
    }
    let selection: { winners: AccessRecord[]; representative: AccessRecord } | null = null;
    for (const bucket of buckets) {
      const eligible = bucket.rows.filter(row => row.values[permission] !== undefined
        && !(scope.kind === 'user' && row.scope.kind === 'group' && (permission !== 'User.Audit' || targetGroups.size === 0)));
      if (eligible.length === 0) continue;
      const personal = eligible.filter(row => row.principal.kind === 'user');
      const winners = personal.length > 0 ? personal : eligible;
      const representative = winners.reduce((current, row) => valueRank(row.values[permission]!) > valueRank(current.values[permission]!) ? row : current);
      selection = { winners, representative };
      break;
    }
    if (permission === 'Upstream.Edit') values[permission] = selection === null ? 'off' : selection.representative.values[permission];
    else values[permission] = selection === null ? false : selection.representative.values[permission];
    if (selection === null) continue;
    const active = new Set(selection.winners.map(record => record.id));
    for (const record of applicable) {
      if (record.values[permission] === undefined) continue;
      if (scope.kind === 'user' && record.scope.kind === 'group' && (permission !== 'User.Audit' || targetGroups.size === 0)) continue;
      decisions.get(record.id)![permission] = active.has(record.id)
        ? { kind: 'effective' }
        : { kind: 'overridden', by: selection.representative };
    }
  }
  return {
    values,
    records: applicable,
    decisions: [...decisions].map(([recordId, permissions]) => ({ recordId, permissions })),
  };
};
