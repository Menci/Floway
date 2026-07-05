<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../../../api/client.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '../../../../api/types.ts';
import UpstreamEditPage from '../../../../components/upstream-edit/UpstreamEditPage.vue';
import { PROVIDER_META, providerMeta } from '../../../../components/upstreams/provider-meta.ts';
import { useProxiesStore } from '../../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../../composables/useUpstreams.ts';

// Blueprint is a shape-complete blank `UpstreamRecord` with `id: ''` — the
// same shape edit consumes, so `UpstreamEditPage` treats create as an edit
// of an unpersisted record. `sort_order: 0` is a placeholder; the editor
// resolves the real next slot off the store at save time.
//
// The blueprint's `enabled: false` and empty `name` are wire-level blanks;
// the create page seeds them with UI-friendly defaults so a fresh row is
// enabled and named per the provider before the operator types anything.
//
// An unknown kind (typo, stale bookmark) resolves to `initialRecord: null`
// and the setup script bounces to the upstreams list. Every other blueprint
// failure (5xx / auth / network) propagates so the operator sees the actual
// problem instead of a silent redirect.
export const useNewUpstreamData = defineBasicLoader('/dashboard/upstreams/new/[provider]', async route => {
  const api = useApi();
  const store = useUpstreamsStore();
  const raw = route.params.provider;
  const kind: UpstreamProviderKind | null = (PROVIDER_META.map(m => m.kind) as string[]).includes(raw) ? (raw as UpstreamProviderKind) : null;

  const [blueprintRes] = await Promise.all([
    kind === null ? null : callApi<UpstreamRecord>(() => api.api.upstreams.blueprint.$get({ query: { kind } })),
    store.load(),
    useProxiesStore().load(),
    useRuntimeInfo().load(),
  ]);

  if (blueprintRes?.error) {
    throw new Error(blueprintRes.error.message);
  }

  const initialRecord = blueprintRes?.data && kind !== null
    ? { ...blueprintRes.data, name: providerMeta(kind).defaultName, enabled: true }
    : null;

  return {
    initialRecord,
    flags: store.flagCatalog.value!,
  };
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

const router = useRouter();
const data = useNewUpstreamData();
const store = useUpstreamsStore();

if (data.data.value.initialRecord === null) {
  void router.replace('/dashboard/upstreams');
}

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <UpstreamEditPage
    v-if="data.data.value.initialRecord"
    :initial-record="data.data.value.initialRecord"
    :flags="data.data.value.flags"
    @saved="onSaved"
  />
</template>
