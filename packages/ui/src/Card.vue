<script setup lang="ts">
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

const props = withDefaults(defineProps<{
  padded?: boolean;
  bordered?: boolean;
}>(), {
  padded: true,
  bordered: true,
});

const classes = computed(() => cn(
  'rounded-2xl bg-surface-800/60',
  props.bordered && 'border border-white/[0.06]',
  props.padded && 'p-5',
));
</script>

<template>
  <div :class="classes">
    <slot />
  </div>
</template>
