<script setup lang="ts">
import type { ControlPlaneModel } from '../../api/types.ts';
import { providerBadgeClass, providerMeta } from '../upstreams/provider-meta.ts';

defineProps<{
  model: ControlPlaneModel;
}>();

defineEmits<{ clear: [] }>();

const formatTokenLimit = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return n.toString();
};
</script>

<template>
  <div class="shrink-0 p-4 border-b border-white/[0.06]">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2">
          <h3 class="text-sm font-semibold text-white">{{ model.display_name ?? model.id }}</h3>
          <span
            v-if="(model.display_name ?? model.id) !== model.id"
            class="font-mono text-[11px] text-gray-500 break-all"
          >{{ model.id }}</span>
        </div>
        <div class="flex flex-wrap gap-1.5 mt-2">
          <span
            v-for="upstream in model.upstreams"
            :key="upstream.id"
            class="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
            :class="providerBadgeClass(upstream.kind)"
            :title="providerMeta(upstream.kind).label + ' · ' + upstream.name"
          >{{ upstream.name }}</span>
          <span v-if="model.limits?.max_context_window_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            context: {{ formatTokenLimit(model.limits.max_context_window_tokens) }}
          </span>
          <span v-if="model.limits?.max_prompt_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            prompt: {{ formatTokenLimit(model.limits.max_prompt_tokens) }}
          </span>
          <span v-if="model.limits?.max_output_tokens" class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-600 text-gray-400">
            output: {{ formatTokenLimit(model.limits.max_output_tokens) }}
          </span>
        </div>
      </div>
      <button class="btn-ghost text-[11px] flex shrink-0 items-center gap-1" @click="$emit('clear')">
        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
        Clear
      </button>
    </div>
  </div>
</template>
