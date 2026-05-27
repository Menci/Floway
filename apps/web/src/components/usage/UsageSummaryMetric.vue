<script setup lang="ts">
defineProps<{
  metric: string;
  label: string;
  active: boolean;
  value: string;
}>();

defineEmits<{
  select: [metric: string];
}>();
</script>

<template>
  <button
    type="button"
    class="text-center w-full rounded-md border border-transparent cursor-pointer transition-colors hover:border-white/10 focus:outline-none focus-visible:border-accent-cyan/40 px-2 py-2"
    :aria-pressed="active"
    :title="`Use ${label} for chart y-axis`"
    @click="$emit('select', metric)"
  >
    <span class="block text-xs mb-1" :class="active ? 'text-accent-cyan' : 'text-gray-500'">{{ label }}</span>
    <span class="block text-lg font-bold font-mono" :class="active ? 'text-accent-cyan' : 'text-white'">{{ value }}</span>
  </button>
</template>
