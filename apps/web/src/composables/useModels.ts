import { ref } from 'vue';

import { callApi, useApi } from '../api/client.ts';
import type { ControlPlaneModel } from '../api/types.ts';

const models = ref<ControlPlaneModel[] | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

interface ModelsResponse {
  object: string;
  data: ControlPlaneModel[];
}

export const useModelsStore = () => {
  const api = useApi();

  const load = async () => {
    loading.value = true;
    error.value = null;
    const { data, error: err } = await callApi<ModelsResponse>(() => api.api.models.$get());
    loading.value = false;
    if (err) {
      error.value = err.message;
      return;
    }
    models.value = data?.data ?? [];
  };

  return { models, loading, error, load };
};
