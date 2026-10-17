import { api, callApi } from '../../api/client';
import { mapResult, mergeResults } from '../../api/partial-results';
import type { AccessRecord, ControlPlaneModel, ControlPlaneUserDirectory, UpstreamOption } from '../../api/types';

export interface PermissionsData {
  records: AccessRecord[] | null;
  directory: ControlPlaneUserDirectory | null;
  models: ControlPlaneModel[] | null;
  upstreams: UpstreamOption[] | null;
  error: string | null;
}

export const unloadedPermissionsData: Omit<PermissionsData, 'error'> = { records: null, directory: null, models: null, upstreams: null };

export const loadPermissionsData = async (current: Omit<PermissionsData, 'error'>, signal?: AbortSignal): Promise<PermissionsData> => {
  const [records, directory, models, upstreams] = await Promise.all([
    callApi(() => api.api['access-records'].$get(undefined, { init: { signal } })),
    callApi(() => api.api['user-directory'].$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({ query: { view: 'all' } }, { init: { signal } })),
  ]);
  const merged = mergeResults(current, { records, directory, models: mapResult(models, body => body.data), upstreams });
  return { ...merged.values, error: merged.error };
};
