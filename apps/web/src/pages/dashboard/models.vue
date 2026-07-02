<script lang="ts">
import { defineBasicLoader } from 'unplugin-vue-router/data-loaders/basic';
import { computed, ref, useTemplateRef } from 'vue';

import { callApi, useApi } from '../../api/client.ts';
import type { ApiKey, ControlPlaneModel } from '../../api/types.ts';
import ChatPanel from '../../components/models/ChatPanel.vue';
import ModelInfoBar from '../../components/models/ModelInfoBar.vue';
import { useModelsStore } from '../../composables/useModels.ts';
import { useAuthStore } from '../../stores/auth.ts';
import { effectiveUpstreamCap, isReachableUnderCap } from '../../utils/reachability.ts';
import { Input, OverlayScrollbars } from '@floway-dev/ui';

export const useModelsPageData = defineBasicLoader(async () => {
  const api = useApi();
  const [keysRes] = await Promise.all([
    callApi<ApiKey[]>(() => api.api.keys.$get()),
    useModelsStore().load(),
  ]);
  return { keys: keysRes.data ?? [], keysError: keysRes.error?.message ?? null };
});
</script>

<script setup lang="ts">
const initialData = useModelsPageData();
const { models, error: modelsError } = useModelsStore();
const auth = useAuthStore();

// Reactivity is intentionally dropped: the loader never refetches keys here.
const keys = initialData.data.value.keys;

const modelsSearch = ref('');
const chatModelId = ref<string>('');
const chatPanelRef = useTemplateRef<InstanceType<typeof ChatPanel>>('chatPanel');

// Playground requires a real per-user API key, not the admin key.
const selectedKeyId = ref<string | null>(keys[0]?.id ?? null);

const selectedKey = computed<ApiKey | null>(() => {
  const id = selectedKeyId.value;
  if (!id) return null;
  return keys.find(k => k.id === id) ?? null;
});

const selectedApiKey = computed(() => selectedKey.value?.key ?? null);

// Server returns gateway-wide for admin sessions, so we filter client-side
// here by the effective cap of (selected api key, owner user). Mirrors the
// gateway's `effectiveUpstreamIdsFromContext`: the key's whitelist wins
// when set; otherwise the user's cap applies. Without a selected key (no
// keys created yet) the cap collapses to the admin's own user.upstreamIds.
const effectiveCap = computed<readonly string[] | null>(
  () => effectiveUpstreamCap(selectedKey.value?.upstream_ids ?? null, auth.currentUser?.upstreamIds ?? null),
);

const filteredChatModels = computed(() => {
  const catalog = models.value ?? [];
  const reachable = catalog.filter(m => m.kind === 'chat' && isReachableUnderCap(m, catalog, effectiveCap.value));
  const needle = modelsSearch.value.trim().toLowerCase();
  if (!needle) return reachable;
  return reachable.filter(m => m.id.toLowerCase().includes(needle) || (m.display_name?.toLowerCase().includes(needle) ?? false));
});

const chatModelInfo = computed<ControlPlaneModel | undefined>(
  () => (models.value ?? []).find(m => m.id === chatModelId.value),
);

if (!chatModelId.value && filteredChatModels.value[0]) chatModelId.value = filteredChatModels.value[0].id;

const banner = computed(() => modelsError.value ?? initialData.data.value.keysError);
</script>

<template>
  <div>
    <div v-if="banner" class="mb-3 rounded-md border border-accent-rose/40 bg-accent-rose/10 px-3 py-2 text-sm text-accent-rose">
      {{ banner }}
    </div>

    <div class="glass-card animate-in flex h-[calc(100dvh-130px)] min-h-[560px] flex-col overflow-hidden lg:h-[calc(100vh-140px)] lg:flex-row">
      <div class="max-h-56 w-full shrink-0 border-b border-white/[0.06] flex flex-col lg:max-h-none lg:w-72 lg:border-b-0 lg:border-r">
        <div class="border-b border-white/[0.06] divide-y divide-white/[0.06]">
          <div class="p-3">
            <select
              v-model="selectedKeyId"
              :disabled="keys.length === 0"
              class="w-full bg-transparent border-none text-xs text-gray-200 focus:outline-none disabled:text-gray-500"
            >
              <option v-if="keys.length === 0" :value="null">(no API keys — create one in Keys)</option>
              <option v-for="k in keys" :key="k.id" :value="k.id">
                {{ k.name }} ({{ k.key.slice(-4) }})
              </option>
            </select>
          </div>
          <div class="p-3">
            <Input
              v-model="modelsSearch"
              type="search"
              placeholder="Filter models..."
              size="sm"
              class="font-mono !border-transparent !bg-transparent !px-0 hover:!border-transparent focus:!border-transparent focus:!ring-0"
            />
          </div>
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
              @click="chatModelId = m.id"
            >
              <div class="text-[13px] truncate" :class="chatModelId === m.id ? 'text-white' : 'text-gray-300'">
                {{ m.display_name ?? m.id }}
              </div>
              <div class="text-[11px] font-mono truncate mt-0.5 opacity-60">{{ m.id }}</div>
            </button>
            <div v-if="filteredChatModels.length === 0" class="p-4 text-center text-gray-600 text-xs">{{ modelsSearch.trim() ? 'No models match your search' : 'No models available' }}</div>
          </template>
          <div v-else class="p-4 text-center text-gray-600 text-xs">No models available</div>
        </OverlayScrollbars>
      </div>

      <div class="flex-1 flex flex-col min-w-0 min-h-0">
        <template v-if="chatModelInfo">
          <ModelInfoBar :model="chatModelInfo" :catalog="models ?? []" :cap="effectiveCap" @clear="chatPanelRef?.clear()" />
          <ChatPanel v-if="selectedApiKey" ref="chatPanel" :model-id="chatModelInfo.id" :api-key="selectedApiKey" />
          <div v-else class="flex-1 flex items-center justify-center px-6 text-center text-gray-600 text-sm">
            Create an API key in the Keys tab to chat with models.
          </div>
        </template>
        <div v-else class="flex-1 flex items-center justify-center text-gray-600 text-sm">Select a model to begin</div>
      </div>
    </div>
  </div>
</template>
