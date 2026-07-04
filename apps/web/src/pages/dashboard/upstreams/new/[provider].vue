<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { callApi, useApi } from '../../../../api/client.ts';
import type { UpstreamProviderKind, UpstreamRecord } from '../../../../api/types.ts';
import UpstreamEditPage from '../../../../components/upstream-edit/UpstreamEditPage.vue';
import { PROVIDER_META } from '../../../../components/upstreams/provider-meta.ts';
import { useProxiesStore } from '../../../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../../../composables/useUpstreams.ts';

// Blueprint is a shape-complete blank `UpstreamRecord` with `id: ''` — the
// same shape edit consumes, so `UpstreamEditPage` treats create as an edit
// of an unpersisted record. `sort_order: 0` is a placeholder; the editor
// resolves the real next slot off the store at save time.
export const useNewUpstreamData = defineBasicLoader('/dashboard/upstreams/new/[provider]', async route => {
  const api = useApi();
  const store = useUpstreamsStore();
  const raw = route.params.provider;
  const kind = (PROVIDER_META.map(m => m.kind) as string[]).includes(raw) ? (raw as UpstreamProviderKind) : null;

  const blueprintPromise = kind === null
    ? Promise.resolve({ data: undefined, error: undefined } as { data: UpstreamRecord | undefined; error: { message: string } | undefined })
    : callApi<UpstreamRecord>(() => api.api.upstreams.blueprint.$get({ query: { kind } }));
  const [blueprintRes] = await Promise.all([
    blueprintPromise,
    store.load(),
    useProxiesStore().load(),
    useRuntimeInfo().load(),
  ]);

  return {
    initialRecord: blueprintRes.error ? null : blueprintRes.data ?? null,
    flags: store.flagCatalog.value!,
  };
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
// kind. Bounce to the upstreams list and let the user pick from the
// dropdown again rather than rendering a fake "Custom" form.
const providerKnown = computed<boolean>(() => {
  const raw = route.params.provider;
  return (PROVIDER_META.map(m => m.kind) as string[]).includes(raw);
});

onMounted(() => {
  if (!providerKnown.value) void router.replace('/dashboard/upstreams');
});

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
  <p v-else class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
    Unknown provider kind: <span class="font-mono">{{ route.params.provider }}</span>. Redirecting…
  </p>
</template>
