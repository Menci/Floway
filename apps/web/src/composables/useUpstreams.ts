import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { FlagDef, UpstreamRecord } from '../api/types.ts';

// Module-scoped reactive list so multiple pages share one cache: editing on
// Settings reflects on Models without a refetch. Marina's defineRouteData uses
// the same idea via a scoped store; we keep ours flatter since the dashboard
// is small.
const upstreams = shallowRef<UpstreamRecord[] | null>(null);
const flagCatalog = shallowRef<FlagDef[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

export const useUpstreamsStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const [listRes, flagsRes] = await Promise.all([
      callApi<UpstreamRecord[]>(() => api.api.upstreams.$get()),
      callApi<FlagDef[]>(() => api.api['upstream-flags'].$get()),
    ]);
    if (listRes.error) error.value = listRes.error.message;
    else if (listRes.data) upstreams.value = [...listRes.data].sort((a, b) => a.sort_order - b.sort_order);
    if (flagsRes.error && !error.value) error.value = flagsRes.error.message;
    else if (flagsRes.data) flagCatalog.value = flagsRes.data;
    loading.value = false;
  };

  return { upstreams, flagCatalog, loading, error, load };
};
