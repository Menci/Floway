import { accessScopeDepth, permissionsForScope, upstreamEditLevelRank } from './types.ts';
import type { AccessPermission, AccessRecord, AccessResolution, AccessScope, AccessTarget, AccessValues, PermissionDecisions } from './types.ts';

const scopeKey = (scope: AccessScope): string => {
  switch (scope.kind) {
  case 'upstream': return JSON.stringify([scope.kind, scope.upstreamId]);
  case 'upstreamModel': return JSON.stringify([scope.kind, scope.upstreamId, scope.model.kind, scope.model.value]);
  case 'user': return JSON.stringify([scope.kind, scope.userId]);
  case 'group': return JSON.stringify([scope.kind, scope.groupId]);
  case 'upstreams':
  case 'users': return scope.kind;
  }
};

const matches = (outer: AccessScope, inner: AccessScope, targetGroups: ReadonlySet<number>): boolean => {
  if (scopeKey(outer) === scopeKey(inner)) return true;
  switch (outer.kind) {
  case 'upstreams': return inner.kind === 'upstream' || inner.kind === 'upstreamModel';
  case 'upstream': return inner.kind === 'upstreamModel' && inner.upstreamId === outer.upstreamId;
  case 'upstreamModel': return inner.kind === 'upstreamModel' && inner.upstreamId === outer.upstreamId
    && inner.model.kind === 'exact' && outer.model.kind === 'regex' && new RegExp(outer.model.value).test(inner.model.value);
  case 'users': return inner.kind === 'user' || inner.kind === 'group';
  case 'group': return inner.kind === 'user' && targetGroups.has(outer.groupId);
  case 'user': return false;
  }
};

const valueRank = (value: NonNullable<AccessValues[AccessPermission]>) => typeof value === 'boolean' ? Number(value) : upstreamEditLevelRank[value];
// A concrete user outranks membership scopes; exact model ids and regexes share
// one ordered level. Only model-pattern precedence is operator-controlled.
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : accessScopeDepth(scope);

export const targetScope = (target: AccessTarget): AccessScope => target.kind === 'upstreamModel'
  ? { kind: 'upstreamModel', upstreamId: target.upstreamId, model: { kind: 'exact', value: target.modelId } }
  : target;

// Callers supply only the selected principal's personal and membership rules.
// Scope wins first, personal assignment wins within that scope, then group
// assignments combine by maximum while all contributing group rules stay active.
export const resolveAssignments = (records: readonly AccessRecord[], scope: AccessScope, targetGroups: ReadonlySet<number>): AccessResolution => {
  const applicable = records.filter(record => matches(record.scope, scope, targetGroups));
  const decisions = new Map<number, PermissionDecisions>(applicable.map(record => [record.id, {}]));
  const values: AccessValues = {};
  for (const permission of permissionsForScope(scope)) {
    const buckets = [...Map.groupBy(applicable.filter(record => record.values[permission] !== undefined), record => scopeKey(record.scope)).values()]
      .map(rows => ({ scope: rows[0]!.scope, rows, order: Math.min(...rows.map(row => row.sortOrder)), id: Math.min(...rows.map(row => row.id)) }))
      .toSorted((left, right) => precedenceDepth(right.scope) - precedenceDepth(left.scope)
        || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
          ? left.order - right.order || left.id - right.id
          : scopeKey(left.scope).localeCompare(scopeKey(right.scope), 'en', { numeric: true })));
    const bucket = buckets[0];
    const personal = bucket?.rows.filter(row => row.principal.kind === 'user');
    const winners = personal && personal.length > 0 ? personal : bucket?.rows ?? [];
    const representative = winners.reduce<AccessRecord | null>((highest, row) => highest === null || valueRank(row.values[permission]!) > valueRank(highest.values[permission]!) ? row : highest, null);
    if (permission === 'Upstream.Edit') values[permission] = representative === null ? 'off' : representative.values[permission];
    else values[permission] = representative === null ? false : representative.values[permission];
    if (representative === null) continue;
    const active = new Set(winners.map(record => record.id));
    for (const record of applicable) {
      if (record.values[permission] !== undefined) decisions.get(record.id)![permission] = active.has(record.id) ? { kind: 'effective' } : { kind: 'overridden', by: representative };
    }
  }
  return { values, records: applicable, decisions: [...decisions].map(([recordId, permissions]) => ({ recordId, permissions })) };
};
