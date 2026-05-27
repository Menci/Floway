<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi, useApi } from '../../api/client.ts';
import type { SearchConfig } from '../../api/types.ts';
import { useModelsStore as useModelsStoreForLoader } from '../../composables/useModels.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../composables/useUpstreams.ts';

const defaultSearchConfig: SearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftGrounding: { apiKey: '' },
};

export const useSettingsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const [searchRes] = await Promise.all([
    callApi<SearchConfig>(() => api.api['search-config'].$get()),
    useUpstreamsStoreForLoader().load(),
    useModelsStoreForLoader().load(),
  ]);
  return {
    searchConfig: searchRes.data ?? defaultSearchConfig,
    searchConfigError: searchRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { UpstreamRecord } from '../../api/types.ts';
import ApiEndpointsSection from '../../components/settings/ApiEndpointsSection.vue';
import ExportSection from '../../components/settings/ExportSection.vue';
import ImportSection from '../../components/settings/ImportSection.vue';
import SearchConfigSection from '../../components/settings/SearchConfigSection.vue';
import UpstreamFormDialog from '../../components/settings/UpstreamFormDialog.vue';
import UpstreamsSettingsCard from '../../components/settings/UpstreamsSettingsCard.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';

definePage({ meta: { requiresAdmin: true } });

const store = useUpstreamsStore();
const { upstreams, flagCatalog, loading: storeLoading, error: storeError, load } = store;
const modelsStore = useModelsStore();
const settingsData = useSettingsPageData();

const formOpen = ref(false);
const formMode = ref<'create' | 'edit'>('create');
const formRecord = ref<UpstreamRecord | undefined>();

// SortableJS mutates this array in place; we sync it from the store whenever
// the store changes, then re-emit reorder via PATCH from the child card.
const ordered = ref<UpstreamRecord[]>([]);
watch(upstreams, list => {
  ordered.value = list ? [...list].sort((a, b) => a.sort_order - b.sort_order) : [];
}, { immediate: true });

const nextSortOrder = computed(() => ordered.value.reduce((acc, u) => Math.max(acc, u.sort_order), -1) + 1);

const openCreate = () => {
  formMode.value = 'create';
  formRecord.value = undefined;
  formOpen.value = true;
};

const openEdit = (record: UpstreamRecord) => {
  formMode.value = 'edit';
  formRecord.value = record;
  formOpen.value = true;
};

const reloadAll = async () => {
  await Promise.all([load(), modelsStore.load()]);
};
</script>

<template>
  <div>
    <div v-if="storeError" class="mb-4 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ storeError }}
    </div>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <div class="flex flex-col gap-5">
        <UpstreamsSettingsCard
          v-model:ordered="ordered"
          :loading="storeLoading"
          :models="modelsStore.models.value"
          @add="openCreate"
          @edit="openEdit"
          @changed="reloadAll"
        />
        <SearchConfigSection
          :initial-config="settingsData.data.value.searchConfig"
          :initial-error="settingsData.data.value.searchConfigError"
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

    <UpstreamFormDialog
      v-model:open="formOpen"
      :mode="formMode"
      :provider="formRecord?.provider ?? 'custom'"
      :record="formRecord"
      :next-sort-order="nextSortOrder"
      :flags="flagCatalog ?? []"
      @saved="reloadAll"
    />
  </div>
</template>
