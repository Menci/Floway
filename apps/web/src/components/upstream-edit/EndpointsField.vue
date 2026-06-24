<script setup lang="ts">
// Endpoint-capability chip group; reused by the upstream-level Default LLM
// Endpoints selector and the per-model Supported Endpoints selector.

import type { ModelEndpointKey, ModelEndpoints } from '../../api/types.ts';

const value = defineModel<ModelEndpoints>({ required: true });

const props = defineProps<{
  kind: 'chat' | 'image';
  disabled?: boolean;
}>();

const CHAT_ENDPOINTS: { key: ModelEndpointKey; label: string }[] = [
  { key: 'completions', label: '/completions' },
  { key: 'chatCompletions', label: '/chat/completions' },
  { key: 'responses', label: '/responses' },
  { key: 'messages', label: '/messages' },
];

const IMAGE_ENDPOINTS: { key: ModelEndpointKey; label: string }[] = [
  { key: 'imagesGenerations', label: '/images/generations' },
  { key: 'imagesEdits', label: '/images/edits' },
];

const toggle = (key: ModelEndpointKey) => {
  const next: ModelEndpoints = { ...value.value };
  if (next[key] !== undefined) delete next[key];
  else next[key] = {};
  value.value = next;
};
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <label
      v-for="ep in (props.kind === 'image' ? IMAGE_ENDPOINTS : CHAT_ENDPOINTS)"
      :key="ep.key"
      class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-mono transition-colors"
      :class="[
        value[ep.key] !== undefined
          ? 'border-accent-cyan/40 bg-accent-cyan/5 text-accent-cyan'
          : 'border-white/10 bg-surface-800/50 text-gray-400 hover:border-white/20',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      ]"
    >
      <input
        type="checkbox"
        class="accent-accent-cyan"
        :checked="value[ep.key] !== undefined"
        :disabled="disabled"
        @change="toggle(ep.key)"
      >
      <span>{{ ep.label }}</span>
    </label>
  </div>
</template>
