<script setup lang="ts">
import type { SeriesSelectionAction } from './series-selection.ts';

defineProps<{
  label: string;
}>();

const emit = defineEmits<{
  select: [action: SeriesSelectionAction];
}>();

const buttonClass = 'shrink-0 rounded px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-gray-300';
</script>

<template>
  <div class="inline-flex items-center gap-1.5" :aria-label="label">
    <span class="text-[11px] font-medium text-gray-500">Select</span>
    <div class="inline-flex items-center gap-0.5 rounded-md border border-white/[0.06] bg-surface-800/70 p-0.5">
      <button type="button" :class="buttonClass" @click="emit('select', 'all')">All</button>
      <button type="button" :class="buttonClass" @click="emit('select', 'invert')">Invert</button>
      <button type="button" :class="buttonClass" @click="emit('select', 'none')">None</button>
    </div>
  </div>
</template>
