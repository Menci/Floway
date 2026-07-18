import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

// Three stores share this core. The server returns gateway-wide rows for admin
// sessions and scoped rows otherwise, so every `requiresAdmin` surface gets the
// full catalog and filters client-side. The stores differ only in query flags:
// `useModelsStore` synthesises alias entries (the default `/v1/models` view);
// `useRawModelsStore` drops alias merging and adds `include_unlisted=true` so
// the alias editor sees every id the resolver accepts; `useAddressableModelsStore`
// keeps alias merging AND `include_unlisted=true` so the Agent Setup page offers
// every chat id an agent could address.
const makeStore = (params: { includeAliases: boolean; includeUnlisted?: boolean }) => {
  const models = ref<ControlPlaneModel[] | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);
  let inflight: Promise<void> | null = null;

  return () => {
    const api = useApi();

    const load = (): Promise<void> => {
      inflight ??= (async () => {
        loading.value = true;
        error.value = null;
        try {
          const query: { aliases?: 'false'; include_unlisted?: 'true' } = {};
          if (!params.includeAliases) query.aliases = 'false';
          if (params.includeUnlisted) query.include_unlisted = 'true';
          const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get({ query }));
          if (err) error.value = err.message;
          else models.value = data.data;
        } finally {
          loading.value = false;
          inflight = null;
        }
      })();
      return inflight;
    };

    return { models, loading, error, load };
  };
};

export const useModelsStore = makeStore({ includeAliases: true });
export const useRawModelsStore = makeStore({ includeAliases: false, includeUnlisted: true });
export const useAddressableModelsStore = makeStore({ includeAliases: true, includeUnlisted: true });
