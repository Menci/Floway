import { useEffect, useMemo, useState } from 'react';

import type { ScopeExpressionData } from './scope-expression';
import { api, callApi } from '../../api/client';
import type { AccessPrincipal, AccessRecord, AccessResolution, AccessScope, AccessValues } from '@floway-dev/gateway/browser';
import { resolveEffectiveAssignments } from '@floway-dev/protocols/browser';

export const resolveInheritedValues = ({ data, excludeRecordId, principal, records, scope }: {
  data: Pick<ScopeExpressionData, 'users'>;
  excludeRecordId?: number;
  principal: AccessPrincipal | null;
  records: readonly AccessRecord[];
  scope: AccessScope | null;
}): AccessValues | undefined => {
  if (principal === null || scope === null || scope.kind === 'self') return undefined;
  const user = principal.kind === 'user' ? data.users.find(candidate => candidate.id === principal.id) : undefined;
  const groupIds = new Set(user?.groupIds ?? []);
  const applicable = records.filter(record => record.id !== excludeRecordId && (
    (record.principal.kind === principal.kind && record.principal.id === principal.id)
    || (principal.kind === 'user' && record.principal.kind === 'group' && groupIds.has(record.principal.id))
  ));
  const targetGroups = scope.kind === 'user' && principal.kind === 'user' && scope.userId === principal.id
    ? groupIds
    : new Set<number>();
  return resolveEffectiveAssignments({
    records: applicable,
    scope,
    targetGroups,
    isAdmin: user?.isAdmin ?? false,
    subjectUserId: principal.kind === 'user' ? principal.id : undefined,
  }).values;
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
