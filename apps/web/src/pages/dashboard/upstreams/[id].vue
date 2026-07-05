<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../../api/client.ts';
import type { UpstreamRecord } from '../../../api/types.ts';
import UpstreamEditPage from '../../../components/upstream-edit/UpstreamEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';

// Pull the full unredacted record for the editor; the flag catalog and
// proxies come from the shared stores so the sidebar + proxy fallback UI
// mount pre-populated. Model catalog and Copilot quota are fetched on
// demand by the editor.
export const useEditUpstreamData = defineBasicLoader('/dashboard/upstreams/[id]', async route => {
  const api = useApi();
  const upstreamsStore = useUpstreamsStore();
  const id = route.params.id;
  const [recordRes] = await Promise.all([
    callApi<UpstreamRecord>(() => api.api.upstreams[':id'].$get({ param: { id } })),
    upstreamsStore.load(),
    useProxiesStore().load(),
    useRuntimeInfo().load(),
  ]);

  // 404 signals the row was deleted (open editor tab, another admin
  // deletes it) → the setup script bounces to /dashboard/settings. Every
  // other failure (5xx / auth / network) propagates so the operator sees
  // the actual problem instead of a silent redirect.
  if (recordRes.error && recordRes.error.status !== 404) {
    throw new Error(recordRes.error.message);
  }
  return {
    initialRecord: recordRes.error ? null : recordRes.data,
    flags: upstreamsStore.flagCatalog.value!,
  };
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

const data = useEditUpstreamData();
const router = useRouter();
const store = useUpstreamsStore();

if (data.data.value.initialRecord === null) {
  void router.replace('/dashboard/settings');
}
</script>

<template>
  <UpstreamEditPage
    v-if="data.data.value.initialRecord"
    :key="data.data.value.initialRecord.id"
    :initial-record="data.data.value.initialRecord"
    :flags="data.data.value.flags"
    @saved="store.load"
  />
</template>
