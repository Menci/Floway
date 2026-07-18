<script lang="ts">
import { useLocalStorage } from '@vueuse/core';
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, watch } from 'vue';

import { callApi, useApi } from '../../../api/client.ts';
import type { ApiKey } from '../../../api/types.ts';
import AgentSetupCard from '../../../components/keys/AgentSetupCard.vue';
import EditKeyDialog from '../../../components/keys/EditKeyDialog.vue';
import { type KeySource, KEY_SOURCE_OPTIONS } from '../../../components/keys/keySource.ts';
import KeysTable from '../../../components/keys/KeysTable.vue';
import { useAddressableModelsStore } from '../../../composables/useModels.ts';
import { useUpstreamOptionsStore } from '../../../composables/useUpstreamOptions.ts';
import { Button, Dialog, Input, Select } from '@floway-dev/ui';

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
const createOpen = ref(false);
const editTarget = ref<ApiKey | null>(null);
const editOpen = ref(false);
const rotateTarget = ref<ApiKey | null>(null);
const rotateSource = ref<KeySource>('generate');
const rotateCustomKey = ref('');
const rotating = ref(false);
const rotateError = ref<string | null>(null);
const copied = ref<string | null>(null);
const copyFailed = ref<string | null>(null);
const selectedKeyId = useLocalStorage('floway-agent-setup-selected-key', '');
const dropSelectionIfMissing = () => {
  if (selectedKeyId.value && !keys.value.some(key => key.id === selectedKeyId.value)) selectedKeyId.value = '';
};
dropSelectionIfMissing();

const loadAll = async (): Promise<boolean> => {
  error.value = null;
  const [keysRes] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    upstreamOptionsStore.load(),
    modelsStore.load(),
  ]);
  if (keysRes.error) {
    error.value = keysRes.error.message;
    return false;
  }
  keys.value = keysRes.data;
  dropSelectionIfMissing();
  return true;
};

const selectCreatedKey = async (key: ApiKey) => {
  if (await loadAll()) selectedKeyId.value = key.id;
};

const rotateOpen = computed({
  get: () => rotateTarget.value !== null,
  set: () => { rotateTarget.value = null; },
});

// Every time the rotate dialog opens, forget any state from the previous
// rotation — otherwise a rejected custom key would linger into the next
// target's dialog.
watch(rotateOpen, v => {
  if (!v) return;
  rotateSource.value = 'generate';
  rotateCustomKey.value = '';
  rotateError.value = null;
});

const submitRotate = async () => {
  // rotateOpen gates dialog mount and only becomes true once rotateTarget is
  // set, so target cannot be null here.
  const target = rotateTarget.value!;
  const source = rotateSource.value;
  const customKey = rotateCustomKey.value.trim();
  if (source === 'custom' && !customKey) {
    rotateError.value = 'Custom API key is required.';
    return;
  }
  rotating.value = true;
  rotateError.value = null;
  const { error: err } = await callApi(
    () => api.api.keys[':id'].rotate.$post({
      param: { id: target.id },
      json: source === 'custom' ? { key_source: 'custom', custom_key: customKey } : { key_source: 'generate' },
    }),
  );
  rotating.value = false;
  if (err) {
    rotateError.value = err.message;
    return;
  }
  rotateOpen.value = false;
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
const models = computed(() => modelsStore.models.value ?? []);
const selectedKey = computed(() => keys.value.find(key => key.id === selectedKeyId.value) ?? null);
</script>

<template>
  <div>
    <div class="glass-card p-5 sm:p-6 mb-6 animate-in">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between mb-6">
        <span class="text-xs font-medium text-gray-500 uppercase tracking-widest">API Keys</span>
        <Button class="whitespace-nowrap" @click="createOpen = true">+ Create API Key</Button>
      </div>

      <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
        {{ error }}
      </div>

      <KeysTable
        :keys="keys"
        :upstreams="upstreamOptions"
        :selected-id="selectedKeyId"
        :copied="copied"
        :copy-failed="copyFailed"
        @select="id => selectedKeyId = id"
        @copy="(text, tag) => copyToClipboard(text, tag)"
        @edit="openEdit"
        @rotate="k => rotateTarget = k"
        @remove="remove"
      />
    </div>

    <AgentSetupCard
      :selected-key="selectedKey"
      :models="models"
      :loading="modelsStore.loading.value"
      :error="modelsStore.error.value"
    />

    <EditKeyDialog
      v-model:open="createOpen"
      mode="create"
      :upstreams="upstreamOptions"
      @saved="selectCreatedKey"
    />

    <EditKeyDialog
      v-if="editTarget"
      v-model:open="editOpen"
      mode="edit"
      :api-key="editTarget"
      :upstreams="upstreamOptions"
      @saved="loadAll"
    />

    <Dialog v-model:open="rotateOpen" title="Rotate API Key" size="md" :auto-focus-on-open="false">
      <template v-if="rotateTarget">
        <div class="space-y-4">
          <p class="text-sm text-gray-400">
            Rotating replaces the raw key for {{ rotateTarget.name }}. The old key stops working immediately.
          </p>
          <div class="space-y-2">
            <label class="block text-xs font-medium text-gray-500">New key</label>
            <Select v-model="rotateSource" :options="KEY_SOURCE_OPTIONS">
              <template #description="{ option }">
                <span class="text-xs text-gray-500">{{ option.description }}</span>
              </template>
            </Select>
            <Input
              v-if="rotateSource === 'custom'"
              v-model="rotateCustomKey"
              placeholder="Paste custom API key"
              @keydown.enter="submitRotate"
            />
          </div>
          <p v-if="rotateError" class="rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-xs text-accent-rose">{{ rotateError }}</p>
          <footer class="flex items-center justify-end gap-2">
            <Button variant="secondary" :disabled="rotating" @click="rotateOpen = false">Cancel</Button>
            <Button :loading="rotating" @click="submitRotate">Rotate key</Button>
          </footer>
        </div>
      </template>
    </Dialog>
  </div>
</template>
