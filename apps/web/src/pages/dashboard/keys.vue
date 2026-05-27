<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { callApi as callApiForLoader, useApi as useApiForLoader } from '../../api/client.ts';
import type { ApiKey as LoaderApiKey } from '../../api/types.ts';
import { useModelsStore as useModelsStoreForLoader } from '../../composables/useModels.ts';
import { useUpstreamsStore as useUpstreamsStoreForLoader } from '../../composables/useUpstreams.ts';
import { useAuthStore as useAuthStoreForLoader } from '../../stores/auth.ts';

export const useKeysPageData = defineBasicLoader(async () => {
  const api = useApiForLoader();
  const auth = useAuthStoreForLoader();
  const [keysRes] = await Promise.all([
    callApiForLoader<LoaderApiKey[]>(() => api.api.keys.$get()),
    auth.isAdmin ? useUpstreamsStoreForLoader().load() : Promise.resolve(),
    useModelsStoreForLoader().load(),
  ]);
  return {
    keys: keysRes.data ?? [],
    error: keysRes.error?.message ?? null,
  };
});
</script>

<script setup lang="ts">
import { Button, Code, Input, Spinner } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey } from '../../api/types.ts';
import CliSnippet from '../../components/keys/CliSnippet.vue';
import EditKeyDialog from '../../components/keys/EditKeyDialog.vue';
import KeysTable from '../../components/keys/KeysTable.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useUpstreamsStore } from '../../composables/useUpstreams.ts';
import { useAuthStore } from '../../stores/auth.ts';

const api = useApi();
const auth = useAuthStore();
const upstreamsStore = useUpstreamsStore();
const modelsStore = useModelsStore();
const initialData = useKeysPageData();

const keys = ref<ApiKey[]>(initialData.data.value.keys);
const loading = ref(false);
const error = ref<string | null>(initialData.data.value.error);
const newName = ref('');
const creating = ref(false);
const editTarget = ref<ApiKey | undefined>();
const editOpen = ref(false);
const selectedKeyId = ref<string>('');
const copied = ref<string | null>(null);

const loadAll = async () => {
  loading.value = true;
  error.value = null;
  const [keysRes] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    auth.isAdmin ? upstreamsStore.load() : Promise.resolve(),
    modelsStore.load(),
  ]);
  loading.value = false;
  if (keysRes.error) {
    error.value = keysRes.error.message;
    return;
  }
  keys.value = keysRes.data ?? [];
};

const create = async () => {
  const trimmed = newName.value.trim();
  if (!trimmed) return;
  creating.value = true;
  const { error: err } = await callApi(() => api.api.keys.$post({ json: { name: trimmed } }));
  creating.value = false;
  if (err) {
    error.value = err.message;
    return;
  }
  newName.value = '';
  await loadAll();
};

const rotate = async (key: ApiKey) => {
  if (!window.confirm(`Rotate key "${key.name}"? The old key will stop working immediately.`)) return;
  const { error: err } = await callApi(() => api.api.keys[':id'].rotate.$post({ param: { id: key.id } }));
  if (err) {
    window.alert(`Rotate failed: ${err.message}`);
    return;
  }
  await loadAll();
};

const remove = async (key: ApiKey) => {
  if (!window.confirm(`Delete key "${key.name}"? This cannot be undone.`)) return;
  const { error: err } = await callApi(() => api.api.keys[':id'].$delete({ param: { id: key.id } }));
  if (err) {
    window.alert(`Delete failed: ${err.message}`);
    return;
  }
  await loadAll();
};

const openEdit = (key: ApiKey) => {
  editTarget.value = key;
  editOpen.value = true;
};

const copyToClipboard = async (text: string, tag: string) => {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = tag;
    window.setTimeout(() => { if (copied.value === tag) copied.value = null; }, 1500);
  } catch {
    // Clipboard may be denied; fall back to no feedback rather than throw.
  }
};

const selectedKey = computed(() => keys.value.find(k => k.id === selectedKeyId.value));
const configurationKey = computed(() => selectedKey.value?.key ?? (auth.isAdmin ? '<your-api-key>' : (auth.authKey ?? keys.value[0]?.key ?? '')));
const modelsForSnippets = computed(() => modelsStore.models.value ?? []);
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 mb-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
        <div v-if="auth.isAdmin" class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          <Input
            v-model="newName"
            size="sm"
            placeholder="Name"
            class="!w-full sm:!w-32"
            @keydown.enter="create"
          />
          <Button
            :loading="creating"
            :disabled="!newName.trim() || creating"
            class="whitespace-nowrap"
            @click="create"
          >
            <span v-if="!creating">+ Create</span>
            <span v-else>Creating…</span>
          </Button>
        </div>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ error }}
      </div>

      <KeysTable
        :keys="keys"
        :loading="loading"
        :is-admin="auth.isAdmin"
        :upstreams="upstreamsStore.upstreams.value ?? []"
        :selected-id="selectedKeyId"
        :copied="copied"
        @select="id => selectedKeyId = id"
        @copy="(text, tag) => copyToClipboard(text, tag)"
        @edit="openEdit"
        @rotate="rotate"
        @remove="remove"
      />
    </div>

    <div class="glass-card p-5 sm:p-6 animate-in delay-1">
      <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">Configuration</span>

      <p v-if="selectedKey" class="text-xs text-accent-cyan mt-2 flex items-center gap-1.5">
        <svg class="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
        Configs below use the selected key.
      </p>

      <div class="mt-5">
        <CliSnippet :api-key="configurationKey" :models="modelsForSnippets" />
      </div>

      <div v-if="!auth.isAdmin && keys[0] && !selectedKey" class="mt-5">
        <Code :code="keys[0].key" :copyable="true" />
      </div>
    </div>

    <EditKeyDialog
      v-model:open="editOpen"
      :api-key="editTarget"
      :upstreams="upstreamsStore.upstreams.value ?? []"
      @saved="loadAll"
    />
  </div>
</template>
