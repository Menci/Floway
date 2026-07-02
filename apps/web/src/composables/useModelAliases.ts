import { ref, shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ModelAlias } from '../api/types.ts';

// Module-scoped cache so concurrent callers share one fetch and edits in
// the Settings card reflect on the Models page without a reload.
const aliases = shallowRef<ModelAlias[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

export const useModelAliases = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const { data, error: err } = await callApi<ModelAlias[]>(() => api.api.aliases.$get());
    loading.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
    aliases.value = data;
  };

  return { aliases, loading, error, load };
};
