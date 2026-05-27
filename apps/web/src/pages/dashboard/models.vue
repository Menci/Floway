<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';

import { useModelsStore } from '../../composables/useModels.ts';

export const useModelsPageData = defineBasicLoader(async () => {
  await useModelsStore().load();
  return true;
});
</script>

<script setup lang="ts">
import { Input, OverlayScrollbars } from '@floway-dev/ui';
import { computed, ref, useTemplateRef } from 'vue';

import type { ControlPlaneModel } from '../../api/types.ts';
import ChatPanel from '../../components/models/ChatPanel.vue';
import ModelInfoBar from '../../components/models/ModelInfoBar.vue';

useModelsPageData();

const { models, error } = useModelsStore();

const modelsSearch = ref('');
const chatModelId = ref<string>('');
const chatPanelRef = useTemplateRef<InstanceType<typeof ChatPanel>>('chatPanel');

const filteredChatModels = computed(() => {
  const list = (models.value ?? []).filter(m => m.kind !== 'embedding');
  const needle = modelsSearch.value.trim().toLowerCase();
  if (!needle) return list;
  return list.filter(m => m.id.toLowerCase().includes(needle) || (m.display_name?.toLowerCase().includes(needle) ?? false));
});

const chatModelInfo = computed<ControlPlaneModel | undefined>(
  () => (models.value ?? []).find(m => m.id === chatModelId.value),
);

const selectChatModel = (id: string) => { chatModelId.value = id; };

if (!chatModelId.value && filteredChatModels.value[0]) chatModelId.value = filteredChatModels.value[0].id;
</script>

<template>
  <div>
    <div v-if="error" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ error }}
    </div>

    <div class="glass-card animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
      <div class="max-h-56 w-full shrink-0 border-b border-white/[0.06] flex flex-col lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
        <div class="p-3 border-b border-white/[0.06]">
          <Input
            v-model="modelsSearch"
            type="search"
            placeholder="Filter models..."
            size="sm"
            class="font-mono !border-transparent !bg-transparent !px-0 hover:!border-transparent focus:!border-transparent focus:!ring-0"
          />
        </div>
        <OverlayScrollbars class="min-h-0 flex-1" :v-scrollbar-offset="{ x: 2 }">
          <template v-if="models">
            <button
              v-for="(m, i) in filteredChatModels"
              :key="m.id"
              class="w-full min-h-11 text-left px-4 py-2.5 transition-colors border-l-2"
              :class="[
                chatModelId === m.id
                  ? 'bg-accent-cyan/10 text-accent-cyan border-l-accent-cyan'
                  : 'text-gray-400 hover:bg-white/[0.03] hover:text-gray-200 border-l-transparent',
                i < filteredChatModels.length - 1 ? 'border-b border-white/[0.03]' : '',
              ]"
              @click="selectChatModel(m.id)"
            >
              <div class="text-[13px] truncate" :class="chatModelId === m.id ? 'text-white' : 'text-gray-300'">
                {{ m.display_name ?? m.id }}
              </div>
              <div class="text-[11px] font-mono truncate mt-0.5 opacity-60">{{ m.id }}</div>
            </button>
            <div v-if="filteredChatModels.length === 0" class="p-4 text-center text-gray-600 text-xs">No models found</div>
          </template>
          <div v-else class="p-4 text-center text-gray-600 text-xs">No models found</div>
        </OverlayScrollbars>
      </div>

      <div class="flex-1 flex flex-col min-w-0 min-h-0">
        <template v-if="chatModelInfo">
          <ModelInfoBar :model="chatModelInfo" @clear="chatPanelRef?.clear()" />
          <ChatPanel ref="chatPanel" :model-id="chatModelInfo.id" />
        </template>
        <div v-else class="flex-1 flex items-center justify-center text-gray-600 text-sm">Select a model to begin</div>
      </div>
    </div>
  </div>
</template>
