import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { FlagDef, UpstreamRecord } from '../api/types.ts';

// Module-scoped so Settings edits reflect on Models without a refetch.
const upstreams = shallowRef<UpstreamRecord[] | null>(null);
const flagCatalog = shallowRef<FlagDef[] | null>(null);
const loading = ref(false);

export const useUpstreamsStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    try {
      const [listRes, flagsRes] = await Promise.all([
        callApi<UpstreamRecord[]>(() => api.api.upstreams.$get()),
        callApi<FlagDef[]>(() => api.api.upstreams.flags.$get()),
      ]);
      if (listRes.error) throw new Error(listRes.error.message);
      if (flagsRes.error) throw new Error(flagsRes.error.message);
      upstreams.value = [...listRes.data].sort((a, b) => a.sort_order - b.sort_order);
      flagCatalog.value = flagsRes.data;
    } finally {
      loading.value = false;
    }
  };

  return { upstreams, flagCatalog, loading, load };
};
