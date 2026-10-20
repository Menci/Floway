import { api, callApi } from '../../api/client';
import { mapResult, mergeResults } from '../../api/partial-results';
import type { AccessRecord, ControlPlaneModel, PermissionsDirectory, UpstreamOption } from '../../api/types';

export interface PermissionsData {
  records: AccessRecord[] | null;
  directory: PermissionsDirectory | null;
  models: ControlPlaneModel[] | null;
  upstreams: UpstreamOption[] | null;
  error: string | null;
}

export const unloadedPermissionsData: Omit<PermissionsData, 'error'> = { records: null, directory: null, models: null, upstreams: null };

export const loadPermissionsData = async (current: Omit<PermissionsData, 'error'>, signal?: AbortSignal): Promise<PermissionsData> => {
  const [permissions, models] = await Promise.all([
    callApi(() => api.api.permissions.$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  const merged = mergeResults(current, {
    records: mapResult(permissions, body => body.records),
    directory: mapResult(permissions, body => body.directory),
    upstreams: mapResult(permissions, body => body.upstreams),
    models: mapResult(models, body => body.data),
  });
  return { ...merged.values, error: merged.error };
};
