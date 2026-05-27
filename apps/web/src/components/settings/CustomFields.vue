<script setup lang="ts">
import { Input } from '@floway-dev/ui';
import { computed, ref } from 'vue';

import type { CustomEndpoint } from '../../api/types.ts';

import Accordion from './Accordion.vue';

// pathOverrides are keyed by the endpoint family ('chat_completions',
// 'responses', 'messages', 'embeddings', 'models'), each holding either an
// override URL or '' for "no override". We carry empty strings through here so
// the controlled inputs work; the parent dialog strips them at save time.
type PathKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'models';

interface CustomDraft {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  supportedEndpoints: CustomEndpoint[];
  bearerToken: string;
  pathOverrides: Record<PathKey, string>;
}

const draft = defineModel<CustomDraft>({ required: true });

const props = defineProps<{
  bearerTokenSet: boolean;
  editMode: boolean;
}>();

const endpointPills: { value: CustomEndpoint; label: string }[] = [
  { value: '/chat/completions', label: 'Chat' },
  { value: '/responses', label: 'Responses' },
  { value: '/v1/messages', label: 'Messages' },
];

const pathOverrideKeys: PathKey[] = ['chat_completions', 'responses', 'messages', 'embeddings', 'models'];

const toggleEndpoint = (ep: CustomEndpoint) => {
  const set = new Set(draft.value.supportedEndpoints);
  if (set.has(ep)) set.delete(ep); else set.add(ep);
  draft.value = { ...draft.value, supportedEndpoints: Array.from(set) };
};

const updatePathOverride = (key: PathKey, value: string) => {
  draft.value = { ...draft.value, pathOverrides: { ...draft.value.pathOverrides, [key]: value } };
};

const overrideCount = computed(() => Object.values(draft.value.pathOverrides).filter(v => v.trim().length > 0).length);

const pathOverridesOpen = ref(false);

const bearerLabel = computed(() => {
  const anthropic = draft.value.authStyle === 'anthropic';
  if (props.editMode) return anthropic ? 'API Key (leave blank to keep)' : 'Bearer Token (leave blank to keep)';
  return anthropic ? 'API Key' : 'Bearer Token';
});

const bearerPlaceholder = computed(() => {
  if (props.bearerTokenSet) return '••••••••';
  return draft.value.authStyle === 'anthropic' ? 'sk-ant-xxxxx' : 'sk-xxxxx';
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">Base URL</label>
        <Input
          :model-value="draft.baseUrl"
          placeholder="e.g. https://api.openai.com"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, baseUrl: v }"
        />
      </div>
      <div>
        <label class="mb-1.5 block text-xs font-medium text-gray-500">{{ bearerLabel }}</label>
        <Input
          type="password"
          autocomplete="off"
          :model-value="draft.bearerToken"
          :placeholder="bearerPlaceholder"
          class="font-mono"
          @update:model-value="v => draft = { ...draft, bearerToken: v }"
        />
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Auth Style</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20"
          :class="draft.authStyle === 'bearer' && 'border-accent-cyan/40 bg-accent-cyan/5'"
        >
          <input
            type="radio"
            name="customAuthStyle"
            value="bearer"
            class="mt-0.5 accent-accent-cyan"
            :checked="draft.authStyle === 'bearer'"
            @change="draft = { ...draft, authStyle: 'bearer' }"
          >
          <span class="flex flex-col gap-0.5">
            <span class="font-medium">Bearer</span>
            <span class="font-mono text-[10px] text-gray-600">Authorization: Bearer &lt;token&gt;</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 transition-colors hover:border-white/20"
          :class="draft.authStyle === 'anthropic' && 'border-accent-cyan/40 bg-accent-cyan/5'"
        >
          <input
            type="radio"
            name="customAuthStyle"
            value="anthropic"
            class="mt-0.5 accent-accent-cyan"
            :checked="draft.authStyle === 'anthropic'"
            @change="draft = { ...draft, authStyle: 'anthropic' }"
          >
          <span class="flex flex-col gap-0.5">
            <span class="font-medium">Anthropic</span>
            <span class="font-mono text-[10px] text-gray-600">x-api-key + anthropic-version</span>
          </span>
        </label>
      </div>
    </div>

    <div>
      <p class="mb-2 text-xs font-medium text-gray-500">Supported Endpoints</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label
          v-for="ep in endpointPills"
          :key="ep.value"
          class="flex items-center gap-2 rounded-md border border-white/10 bg-surface-800/50 px-3 py-2 text-xs text-gray-300 cursor-pointer"
        >
          <input
            type="checkbox"
            class="accent-accent-cyan"
            :checked="draft.supportedEndpoints.includes(ep.value)"
            @change="toggleEndpoint(ep.value)"
          >
          <span class="font-mono text-[11px]">{{ ep.label }}</span>
        </label>
      </div>
    </div>

    <Accordion v-model:open="pathOverridesOpen" label="Path Overrides" :count="overrideCount">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label v-for="key in pathOverrideKeys" :key="key" class="min-w-0">
          <span class="mb-1 block truncate font-mono text-[10px] text-gray-500">{{ key }}</span>
          <Input
            :model-value="draft.pathOverrides[key]"
            :placeholder="`/v1/${key.replace('_', '/')}`"
            size="sm"
            class="font-mono"
            @update:model-value="v => updatePathOverride(key, v)"
          />
        </label>
      </div>
      <p class="mt-3 text-xs text-gray-400">
        Leave blank to use the OpenAI default <code class="font-mono">/v1/&lt;endpoint&gt;</code>. Count tokens follows the messages path.
      </p>
    </Accordion>
  </div>
</template>
