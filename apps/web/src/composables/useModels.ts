import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Two stores share this core. The server returns gateway-wide rows for
// admin sessions and scoped rows for non-admin sessions, so every surface
// that mounts under `requiresAdmin` (alias edit dialog, settings card,
// Models playground) gets the full catalog and filters client-side as
// needed. `useModelsStore` includes synthesised alias entries (the
// default `/v1/models` view); `useRawModelsStore` drops alias merging
// and adds `include_unlisted=true` so the alias editor's combobox sees
// every id the data-plane resolver would accept.
const makeStore = (params: { includeAliases: boolean; includeUnlisted?: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  return () => {
    const api = useApi();

    const load = async () => {
      loading.value = true;
      error.value = null;
      const query: { aliases?: 'false'; include_unlisted?: 'true' } = {};
      if (!params.includeAliases) query.aliases = 'false';
      if (params.includeUnlisted) query.include_unlisted = 'true';
      const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get({ query }));
      loading.value = false;
      if (err) {
        error.value = err.message;
        return;
      }
      models.value = data?.data ?? [];
    };

    return { models, loading, error, load };
  };
};

export const useModelsStore = makeStore({ includeAliases: true });
export const useRawModelsStore = makeStore({ includeAliases: false, includeUnlisted: true });
