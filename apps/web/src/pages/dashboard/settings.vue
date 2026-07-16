<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { callApi, useApi } from '../../api/client.ts';
import type { ModelAlias, ProxyRecord, SearchConfig, UpstreamProviderKind, UpstreamRecord } from '../../api/types.ts';
import AliasEditDialog from '../../components/alias-edit/AliasEditDialog.vue';
import ProxyEditDialog from '../../components/proxy-edit/ProxyEditDialog.vue';
import AliasesSettingsCard from '../../components/settings/AliasesSettingsCard.vue';
import ApiEndpointsSection from '../../components/settings/ApiEndpointsSection.vue';
import ExportSection from '../../components/settings/ExportSection.vue';
import ImportSection from '../../components/settings/ImportSection.vue';
import ProxiesSettingsCard from '../../components/settings/ProxiesSettingsCard.vue';
import SearchConfigSection from '../../components/settings/SearchConfigSection.vue';
import UpstreamsSettingsCard from '../../components/settings/UpstreamsSettingsCard.vue';
import { useModelAliases } from '../../composables/useModelAliases.ts';
import { useRawModelsStore } from '../../composables/useModels.ts';
import { useProxiesStore } from '../../composables/useProxies.ts';
import { useRuntimeInfo } from '../../composables/useRuntimeInfo.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';

const defaultSearchConfig: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

export const useSettingsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const [searchRes] = await Promise.all([
    callApi<SearchConfig>(() => api.api['search-config'].$get()),
    useUpstreamsStore().load(),
    useProxiesStore().load(),
    useModelAliases().load(),
    useRuntimeInfo().load(),
  ]);
  await useRawModelsStore().load();
  return {
    searchConfig: searchRes.data ?? defaultSearchConfig,
    searchConfigError: searchRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">

definePage({ meta: { requiresAdmin: true } });

const router = useRouter();
const { upstreams, loading: storeLoading, load } = useUpstreamsStore();
const modelsStore = useRawModelsStore();
const proxiesStore = useProxiesStore();
const aliasesStore = useModelAliases();
const { load: loadProxies } = proxiesStore;
const { load: loadAliases } = aliasesStore;
const settingsData = useSettingsPageData();

// Local working copy the child reorders via v-model:ordered; reloadAll
// re-syncs from the store after the child reports a change.
const ordered = ref<UpstreamRecord[]>([]);
watch(upstreams, list => {
  ordered.value = list ? [...list] : [];
}, { immediate: true });

const reloadAll = async () => {
  await Promise.all([load(), modelsStore.load(), loadProxies(), loadAliases()]);
};

// Proxy editor is hosted as a modal — v-if drives the unmount on close so the
// next open boots from a fresh script setup (no manual reset).
const proxyDialogOpen = ref(false);
const proxyDialogRecord = ref<ProxyRecord | null>(null);
const openProxyDialog = (record: ProxyRecord | null): void => {
  proxyDialogRecord.value = record;
  proxyDialogOpen.value = true;
};

const aliasDialogOpen = ref(false);
const aliasDialogRecord = ref<ModelAlias | null>(null);
const openAliasDialog = (record: ModelAlias | null): void => {
  aliasDialogRecord.value = record;
  aliasDialogOpen.value = true;
};
</script>

<template>
  <div>
    <p
      v-if="modelsStore.error.value"
      class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose"
    >
      Model catalog unavailable: {{ modelsStore.error.value }}
    </p>
    <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div class="flex flex-col gap-5">
        <UpstreamsSettingsCard
          v-model:ordered="ordered"
          :loading="storeLoading"
          :models="modelsStore.models.value ?? []"
          @add="(kind: UpstreamProviderKind) => router.push(`/dashboard/upstreams/new/${kind}`)"
          @edit="(record: UpstreamRecord) => router.push(`/dashboard/upstreams/${record.id}`)"
          @changed="reloadAll"
        />
        <ProxiesSettingsCard
          @add="() => openProxyDialog(null)"
          @edit="(record: ProxyRecord) => openProxyDialog(record)"
          @changed="reloadAll"
        />
        <AliasesSettingsCard
          @add="() => openAliasDialog(null)"
          @edit="(record: ModelAlias) => openAliasDialog(record)"
          @changed="reloadAll"
        />
        <SearchConfigSection
          :initial-config="settingsData.data.value.searchConfig"
          :initial-error="settingsData.data.value.searchConfigError"
          :upstreams="ordered"
          :models="modelsStore.models.value ?? []"
        />
      </div>

      <div class="flex flex-col gap-5">
        <ApiEndpointsSection />
        <div class="glass-card p-5 sm:p-6 animate-in delay-2">
          <ExportSection :framed="false" />
          <div class="my-6 border-t border-white/[0.06]" />
          <ImportSection :framed="false" />
        </div>
      </div>
    </div>

    <ProxyEditDialog
      v-if="proxyDialogOpen"
      v-model:open="proxyDialogOpen"
      :record="proxyDialogRecord"
      @saved="reloadAll"
    />

    <AliasEditDialog
      v-if="aliasDialogOpen"
      v-model:open="aliasDialogOpen"
      :record="aliasDialogRecord"
      @saved="reloadAll"
    />
  </div>
</template>
