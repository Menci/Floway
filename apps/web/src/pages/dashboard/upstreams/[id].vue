<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../../api/client.ts';
import type { CopilotQuotaSnapshot, CursorDashboardUsage, UpstreamModelConfig } from '../../../api/types.ts';
import UpstreamEditPage from '../../../components/upstream-edit/UpstreamEditPage.vue';
import { useProxiesStore } from '../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../composables/useUpstreams.ts';

// Pre-fetch the provider-specific model list (and Copilot's premium quota)
// during route resolution so the editor mounts already populated; without
// this the page renders with empty bodies for a frame and flickers once
// the in-component fetch resolves.
export const useEditUpstreamData = defineBasicLoader('/dashboard/upstreams/[id]', async route => {
  const api = useApi();
  const store = useUpstreamsStore();
  await Promise.all([store.load(), useProxiesStore().load(), useRuntimeInfo().load()]);
  const list = store.upstreams.value!;
  const id = route.params.id;
  const record = list.find(u => u.id === id) ?? null;

  let upstreamModels: UpstreamModelConfig[] = [];
  let upstreamModelsError: string | null = null;
  let copilotQuota: CopilotQuotaSnapshot | null = null;
  let copilotQuotaError: string | null = null;
  let cursorQuota: CursorDashboardUsage | null = null;
  let cursorQuotaError: string | null = null;

  // Every provider except Azure resolves its catalog through the SWR cache
  // backing GET /upstreams/:id/models. Azure's catalog is operator-edited
  // form data — there is nothing to fetch — so it is skipped here.
  if (record && record.kind !== 'azure') {
    const modelsPromise = callApi<{ data: UpstreamModelConfig[] }>(
      () => api.api.upstreams[':id'].models.$get({ param: { id: record.id } }),
    );
    const copilotQuotaPromise = record.kind === 'copilot'
      ? callApi<CopilotQuotaSnapshot>(() => api.api.upstreams[':id'].copilot.quota.$get({ param: { id: record.id } }))
      : null;
    // Prefetch the Cursor dashboard usage for cursor upstreams; the panel's
    // CursorAccountCard renders it on first paint (no spinner flicker).
    // Skip if the account isn't active — the panel guards the same check.
    const cursorQuotaPromise = record.kind === 'cursor' && record.state?.accounts[0]?.state === 'active'
      ? callApi<CursorDashboardUsage>(() => api.api.upstreams[':id'].cursor.quota.$get({ param: { id: record.id } }))
      : null;
    const [modelsRes, copilotRes, cursorRes] = await Promise.all([
      modelsPromise,
      copilotQuotaPromise ?? Promise.resolve(null),
      cursorQuotaPromise ?? Promise.resolve(null),
    ]);
    if (modelsRes.error) upstreamModelsError = modelsRes.error.message;
    else upstreamModels = modelsRes.data.data;
    if (copilotRes) {
      if (copilotRes.error) copilotQuotaError = copilotRes.error.message;
      else copilotQuota = copilotRes.data;
    }
    if (cursorRes) {
      if (cursorRes.error) cursorQuotaError = cursorRes.error.message;
      else cursorQuota = cursorRes.data;
    }
  }

  return {
    record,
    flags: store.flagCatalog.value!,
    nextSortOrder: list.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1,
    upstreamModels,
    upstreamModelsError,
    copilotQuota,
    copilotQuotaError,
    cursorQuota,
    cursorQuotaError,
  };
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

const data = useEditUpstreamData();
const router = useRouter();
const store = useUpstreamsStore();

// Missing id → upstream was deleted; bounce back to settings. The list was
// already fetched by the loader, so a missing id is authoritative.
if (data.data.value.record === null) {
  void router.replace('/dashboard/settings');
}
</script>

<template>
  <UpstreamEditPage
    v-if="data.data.value.record"
    :key="data.data.value.record.id"
    mode="edit"
    :record="data.data.value.record"
    :next-sort-order="data.data.value.nextSortOrder"
    :flags="data.data.value.flags"
    :initial-upstream-models="data.data.value.upstreamModels"
    :initial-upstream-models-error="data.data.value.upstreamModelsError"
    :initial-copilot-quota="data.data.value.copilotQuota"
    :initial-copilot-quota-error="data.data.value.copilotQuotaError"
    :initial-cursor-quota="data.data.value.cursorQuota"
    :initial-cursor-quota-error="data.data.value.cursorQuotaError"
    @saved="store.load"
  />
</template>
