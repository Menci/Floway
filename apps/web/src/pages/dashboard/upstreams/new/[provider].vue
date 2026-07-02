<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { UpstreamProviderKind } from '../../../../api/types.ts';
import UpstreamEditPage from '../../../../components/upstream-edit/UpstreamEditPage.vue';
import { PROVIDER_META } from '../../../../components/upstreams/provider-meta.ts';
import { useProxiesStore } from '../../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../../composables/useUpstreams.ts';

export const useNewUpstreamData = defineBasicLoader(async () => {
  const store = useUpstreamsStore();
  await Promise.all([store.load(), useProxiesStore().load(), useRuntimeInfo().load()]);
  const list = store.upstreams.value!;
  const flags = store.flagCatalog.value!;
  const nextSortOrder = list.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1;
  return { flags, nextSortOrder };
});
</script>

<script setup lang="ts">
definePage({ meta: { requiresAdmin: true } });

const route = useRoute('/dashboard/upstreams/new/[provider]');
const router = useRouter();
const data = useNewUpstreamData();
const store = useUpstreamsStore();

// The provider segment is the route's discriminator: an unknown value is a
// dead URL (typo, stale bookmark) and should not silently default to one
// kind. Bounce to the settings list and let the user pick from the
// dropdown again rather than rendering a fake "Custom" form.
const provider = computed<UpstreamProviderKind | null>(() => {
  const raw = route.params.provider;
  return (PROVIDER_META.map(m => m.kind) as string[]).includes(raw) ? (raw as UpstreamProviderKind) : null;
});

onMounted(() => {
  if (provider.value === null) void router.replace('/dashboard/upstreams');
});

const onSaved = async () => {
  await store.load();
};
</script>

<template>
  <UpstreamEditPage
    v-if="provider"
    mode="create"
    :record="null"
    :initial-kind="provider"
    :next-sort-order="data.data.value.nextSortOrder"
    :flags="data.data.value.flags"
    @saved="onSaved"
  />
  <p v-else class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
    Unknown provider kind: <span class="font-mono">{{ route.params.provider }}</span>. Redirecting…
  </p>
</template>
