import { useEffect, useMemo, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { AccessPrincipal, AccessRecord, AccessResolution, AccessScope } from '@floway-dev/gateway/browser';

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
  const request = useMemo(() => enabled && principalKind !== undefined && principalId !== undefined && scopeJson !== null && scope?.kind !== 'self' ? {
    json: { principal: { kind: principalKind, id: principalId }, scope: JSON.parse(scopeJson) as Exclude<AccessScope, { kind: 'self' }>, ...(excludeRecordId === undefined ? {} : { excludeRecordId }) },
    revision,
  } : null, [enabled, excludeRecordId, principalId, principalKind, revision, scopeJson, scope?.kind]);
  const [result, setResult] = useState<{ request: typeof request; data: AccessResolution | null; error: string | null } | null>(null);
  // Closing the dialog disables the request, but the surface is still mounted
  // for its exit motion. Throwing the last resolution away in that frame makes
  // every permission field flash "Inherit (unknown)". The last result is only
  // dropped when the principal or scope actually changes.
  const [lastRequest, setLastRequest] = useState<typeof request>(null);
  useEffect(() => {
    if (request === null) return;
    const controller = new AbortController();
    void callApi(() => api.api['access-resolve'].$post({ json: request.json }, { init: { signal: controller.signal } })).then(result => {
      if (controller.signal.aborted) return;
      setResult(result.error ? { request, data: null, error: result.error.message } : { request, data: result.data, error: null });
    });
    return () => controller.abort();
  }, [request]);
  if (request !== lastRequest && request !== null) setLastRequest(request);
  const current = result === null ? null
    : request === null ? result.request === lastRequest ? result : null
      : result.request === request ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, pending: request !== null && current === null };
};
