<script setup lang="ts">
import { computed } from 'vue';

import AliasRow from './AliasRow.vue';
import { callApi, useApi } from '../../api/client.ts';
import type { ModelAlias } from '../../api/types.ts';
import { useModelAliases } from '../../composables/useModelAliases.ts';
import { useRawModelsStore } from '../../composables/useModels.ts';
import { Spinner } from '@floway-dev/ui';

const emit = defineEmits<{
  'add': [];
  'edit': [record: ModelAlias];
  'changed': [];
}>();

const api = useApi();
const aliasesStore = useModelAliases();
const modelsStore = useRawModelsStore();

const aliases = computed<ModelAlias[]>(() => aliasesStore.aliases.value ?? []);

const deleteAlias = async (record: ModelAlias) => {
  if (!window.confirm(`Delete alias "${record.name}"?`)) return;
  const { error } = await callApi(() => api.api.aliases[':name'].$delete({ param: { name: record.name } }));
  if (error) {
    window.alert(`Delete failed: ${error.message}`);
    return;
  }
  emit('changed');
};
</script>

<template>
  <div class="glass-card p-5 sm:p-6 animate-in delay-2">
    <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-white font-semibold mb-1">Aliases</h3>
        <p class="text-sm text-gray-400">
          Named virtual model ids that resolve to one of N target models, with optional per-target rule overlays.
        </p>
      </div>
      <button class="btn-primary !py-2.5 !px-3 text-xs whitespace-nowrap" @click="emit('add')">Add Alias</button>
    </div>

    <p v-if="aliasesStore.error.value" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      Failed to load aliases: {{ aliasesStore.error.value }}
    </p>

    <p v-if="!aliasesStore.error.value && aliases.length === 0" class="text-sm text-gray-500">
      No aliases configured. Add one to expose a virtual model id that routes across multiple targets with locked rules.
    </p>

    <div v-else-if="aliases.length > 0" class="space-y-2">
      <AliasRow
        v-for="alias in aliases"
        :key="alias.name"
        :alias="alias"
        :models="modelsStore.models.value"
        @edit="emit('edit', alias)"
        @delete="deleteAlias(alias)"
      />
    </div>

    <Spinner v-if="aliasesStore.loading.value && aliases.length > 0" class="mt-3 h-4 w-4 text-gray-500" />
  </div>
</template>
