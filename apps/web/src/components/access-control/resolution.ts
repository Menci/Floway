import { useEffect, useMemo, useState } from 'react';

import { scopeDepth, scopeKey } from './scope';
import type { ScopeExpressionData } from './scope-expression';
import { scopePermissions } from './values';
import { api, callApi } from '../../api/client';
import type { AccessPermission, AccessPrincipal, AccessRecord, AccessResolution, AccessScope, AccessValues, ResolveScope, UpstreamEditLevel } from '@floway-dev/gateway/browser';

const EDIT_LEVEL_RANK: Record<UpstreamEditLevel, number> = { off: 0, models: 1, full: 2 };
const valueRank = (value: NonNullable<AccessValues[AccessPermission]>) => typeof value === 'boolean' ? Number(value) : EDIT_LEVEL_RANK[value];
const precedenceDepth = (scope: AccessScope) => scope.kind === 'user' ? 3 : scopeDepth(scope);

const matchesResolveScope = (recordScope: AccessScope, target: ResolveScope, targetGroups: ReadonlySet<number>, isSelfUser: boolean): boolean => {
  switch (target.kind) {
  case 'upstreams': return recordScope.kind === 'upstreams';
  case 'upstream': return recordScope.kind === 'upstreams'
    || (recordScope.kind === 'upstream' && recordScope.upstreamId === target.upstreamId);
  case 'upstreamModel': return recordScope.kind === 'upstreams'
    || (recordScope.kind === 'upstream' && recordScope.upstreamId === target.upstreamId)
    || (recordScope.kind === 'upstreamModel' && recordScope.upstreamId === target.upstreamId
      && (target.model.kind === 'regex'
        ? scopeKey(recordScope) === scopeKey(target)
        : recordScope.model.kind === 'exact'
          ? recordScope.model.value === target.model.value
          : new RegExp(recordScope.model.value).test(target.model.value)));
  case 'users': return recordScope.kind === 'users';
  case 'user': return (isSelfUser && recordScope.kind === 'self')
    || (recordScope.kind === 'user' && recordScope.userId === target.userId)
    || (recordScope.kind === 'group' && targetGroups.has(recordScope.groupId))
    || recordScope.kind === 'users';
  case 'groups': return recordScope.kind === 'groups';
  case 'group': return recordScope.kind === 'groups'
    || (recordScope.kind === 'group' && recordScope.groupId === target.groupId);
  }
};

export const resolveInheritedValues = ({ data, excludeRecordId, principal, records, scope }: {
  data: Pick<ScopeExpressionData, 'users'>;
  excludeRecordId?: number;
  principal: AccessPrincipal | null;
  records: readonly AccessRecord[];
  scope: AccessScope | null;
}): AccessValues | undefined => {
  if (principal === null || scope === null || scope.kind === 'self') return undefined;
  const user = principal.kind === 'user' ? data.users.find(candidate => candidate.id === principal.id) : undefined;
  const permissions = scopePermissions(scope);
  if (user?.isAdmin) {
    return Object.fromEntries(permissions.map(permission => [permission, permission === 'Upstream.Edit' ? 'full' : true]));
  }
  const groupIds = new Set(user?.groupIds ?? []);
  const isSelfUser = scope.kind === 'user' && principal.kind === 'user' && scope.userId === principal.id;
  const targetGroups = isSelfUser ? groupIds : new Set<number>();

  const bucketsByKey = new Map<string, { scope: AccessScope; scopeKey: string; rows: AccessRecord[]; order: number; id: number }>();
  for (const record of records) {
    if (record.id === excludeRecordId) continue;
    const belongs = (record.principal.kind === principal.kind && record.principal.id === principal.id)
      || (principal.kind === 'user' && record.principal.kind === 'group' && groupIds.has(record.principal.id));
    if (!belongs || !matchesResolveScope(record.scope, scope, targetGroups, isSelfUser)) continue;
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
  const buckets = [...bucketsByKey.values()].toSorted((left, right) =>
    precedenceDepth(right.scope) - precedenceDepth(left.scope)
    || (left.scope.kind === 'upstreamModel' && right.scope.kind === 'upstreamModel'
      ? left.order - right.order || left.id - right.id
      : left.scopeKey.localeCompare(right.scopeKey, 'en', { numeric: true })));

  const values: AccessValues = {};
  for (const permission of permissions) {
    if (isSelfUser && permission === 'User.Audit') {
      values[permission] = true;
      continue;
    }
    let resolved: AccessValues[AccessPermission] = permission === 'Upstream.Edit' ? 'off' : false;
    for (const bucket of buckets) {
      const eligible = bucket.rows.filter(row => row.values[permission] !== undefined
        && !(scope.kind === 'user' && row.scope.kind === 'group' && (permission !== 'User.Audit' || targetGroups.size === 0)));
      if (eligible.length === 0) continue;
      const personal = eligible.filter(row => row.principal.kind === 'user');
      const winners = personal.length > 0 ? personal : eligible;
      const best = winners.reduce((current, row) => valueRank(row.values[permission]!) > valueRank(current.values[permission]!) ? row : current);
      resolved = best.values[permission];
      break;
    }
    if (permission === 'Upstream.Edit') values[permission] = resolved as UpstreamEditLevel;
    else values[permission] = resolved as boolean;
  }
  return values;
};

export const useAccessResolution = ({ enabled, excludeRecordId, principal, revision, scope }: {
  enabled: boolean;
  excludeRecordId?: number;
  principal: AccessPrincipal | null;
  revision?: readonly AccessRecord[] | null;
  scope: AccessScope | null;
}) => {
  const principalKind = principal?.kind;
  const principalId = principal?.id;
  const scopeJson = scope === null ? null : JSON.stringify(scope);
  const target = useMemo(() => principalKind !== undefined && principalId !== undefined && scopeJson !== null && scope?.kind !== 'self' ? {
    json: { principal: { kind: principalKind, id: principalId }, scope: JSON.parse(scopeJson) as Exclude<AccessScope, { kind: 'self' }>, ...(excludeRecordId === undefined ? {} : { excludeRecordId }) },
    revision,
  } : null, [excludeRecordId, principalId, principalKind, revision, scopeJson, scope?.kind]);
  const request = enabled ? target : null;
  const [result, setResult] = useState<{ request: typeof request; data: AccessResolution | null; error: string | null } | null>(null);
  useEffect(() => {
    if (request === null) return;
    const controller = new AbortController();
    void callApi(() => api.api['access-resolve'].$post({ json: request.json }, { init: { signal: controller.signal } })).then(result => {
      if (controller.signal.aborted) return;
      setResult(result.error ? { request, data: null, error: result.error.message } : { request, data: result.data, error: null });
    });
    return () => controller.abort();
  }, [request]);
  // Disabling keeps the result for an unchanged target so transient pauses
  // (such as a page refresh) do not drop resolved effective decisions.
  const current = result?.request === target ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, pending: request !== null && current === null };
};
