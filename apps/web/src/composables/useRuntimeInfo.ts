import { shallowRef } from 'vue';

import { callApi, useApi } from '../api/client.ts';

export interface RuntimeInfo {
  kind: 'cloudflare' | 'node';
  colo: string;
}

const info = shallowRef<RuntimeInfo | null>(null);
let inflight: Promise<RuntimeInfo> | null = null;

export const useRuntimeInfo = () => {
  const api = useApi();

  const load = async (): Promise<RuntimeInfo> => {
    if (info.value !== null) return info.value;
    if (inflight !== null) return await inflight;
    inflight = (async () => {
      try {
        const res = await callApi<RuntimeInfo>(() => api.api['runtime-info'].$get());
        if (res.error) throw new Error(`/api/runtime-info: ${res.error.message}`);
        info.value = res.data;
        return res.data;
      } finally {
        inflight = null;
      }
    })();
    return await inflight;
  };

  return { info, load };
};
