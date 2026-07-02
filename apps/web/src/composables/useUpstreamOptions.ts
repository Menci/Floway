import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { UpstreamProviderKind } from '../api/types.ts';

// Minimal picker shape for the per-key upstream whitelist editor. Backed by
// /api/upstream-options, which is mounted outside the admin-only zone so non-
// admin users can scope their keys without the gateway leaking model lists,
// flag overrides, or provider-specific config through the full upstreams API.
export interface UpstreamOption {
  id: string;
  name: string;
  kind: UpstreamProviderKind;
  enabled: boolean;
}

const options = shallowRef<UpstreamOption[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

export const useUpstreamOptionsStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const { data, error: err } = await callApi<UpstreamOption[]>(() => api.api['upstream-options'].$get());
    loading.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
    options.value = data;
  };

  return { options, loading, error, load };
};
