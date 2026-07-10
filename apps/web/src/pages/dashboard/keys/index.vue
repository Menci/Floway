<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref } from 'vue';

import { callApi, useApi } from '../../../api/client.ts';
import type { ApiKey } from '../../../api/types.ts';
import AgentSetupCard from '../../../components/keys/AgentSetupCard.vue';
import EditKeyDialog from '../../../components/keys/EditKeyDialog.vue';
import KeysTable from '../../../components/keys/KeysTable.vue';
import { useAddressableModelsStore } from '../../../composables/useModels.ts';
import { useUpstreamOptionsStore } from '../../../composables/useUpstreamOptions.ts';
import { Button, Input } from '@floway-dev/ui';

export const useKeysPageData = defineBasicLoader(async () => {
  const api = useApi();
  const upstreamOptions = useUpstreamOptionsStore();
  const [keysRes] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    upstreamOptions.load(),
    useAddressableModelsStore().load(),
  ]);
  return {
    keys: keysRes.error ? [] : keysRes.data,
    error: keysRes.error?.message ?? upstreamOptions.error.value,
  };
});
</script>

<script setup lang="ts">

const api = useApi();
const upstreamOptionsStore = useUpstreamOptionsStore();
const modelsStore = useAddressableModelsStore();
const initialData = useKeysPageData();

const keys = ref<ApiKey[]>(initialData.data.value.keys);
const error = ref<string | null>(initialData.data.value.error);
const newName = ref('');
const creating = ref(false);
const editTarget = ref<ApiKey | undefined>();
const editOpen = ref(false);
const copied = ref<string | null>(null);
const copyFailed = ref<string | null>(null);

const loadAll = async () => {
  error.value = null;
  const [keysRes] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    upstreamOptionsStore.load(),
    modelsStore.load(),
  ]);
  if (keysRes.error) {
    error.value = keysRes.error.message;
    return;
  }
  keys.value = keysRes.data;
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
  } catch (err) {
    console.error('[clipboard]', err);
    copyFailed.value = tag;
    window.setTimeout(() => { if (copyFailed.value === tag) copyFailed.value = null; }, 2000);
  }
};

const upstreamOptions = computed(() => upstreamOptionsStore.options.value);
// The setup card revalidates its selected key against the live account, so it
// only needs each key's id and name; a genuine no-key → has-key transition
// re-acquires a lease by remounting the card with a fresh useAgentSetup.
const setupKeys = computed(() => keys.value.map(k => ({ id: k.id, name: k.name })));
const models = computed(() => modelsStore.models.value ?? []);
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 mb-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
        <div class="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
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
        :upstreams="upstreamOptions"
        :copied="copied"
        :copy-failed="copyFailed"
        @copy="(text, tag) => copyToClipboard(text, tag)"
        @edit="openEdit"
        @rotate="rotate"
        @remove="remove"
      />
    </div>

    <AgentSetupCard
      :key="keys.length > 0 ? 'has-keys' : 'no-keys'"
      :keys="setupKeys"
      :models="models"
      :loading="modelsStore.loading.value"
      :error="modelsStore.error.value"
    />

    <EditKeyDialog
      v-if="editTarget"
      v-model:open="editOpen"
      :api-key="editTarget"
      :upstreams="upstreamOptions"
      @saved="loadAll"
    />
  </div>
</template>
