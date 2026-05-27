<script setup lang="ts">
import { computed } from 'vue';

import { cn } from './utils/cn.ts';

const props = withDefaults(defineProps<{
  modelValue?: string | null;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  rows?: number;
  monospace?: boolean;
}>(), {
  rows: 4,
});

defineEmits<{
  'update:modelValue': [value: string];
}>();

const classes = computed(() => cn(
  'w-full rounded-[10px] bg-surface-700 border border-white/[0.06] text-white placeholder:text-gray-500 px-3 py-2 text-sm',
  'transition-colors resize-y',
  'hover:border-white/[0.1]',
  'focus:outline-none focus:border-accent-cyan/50 focus:ring-1 focus:ring-accent-cyan/30',
  'disabled:opacity-50 disabled:cursor-not-allowed',
  props.invalid && 'border-accent-rose/60 focus:border-accent-rose focus:ring-accent-rose/40',
  props.monospace ? 'font-mono text-xs' : 'font-sans',
));
</script>

<template>
  <textarea
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows"
    :class="classes"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>
